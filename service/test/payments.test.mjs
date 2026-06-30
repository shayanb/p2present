// payments.test.mjs — unit tests for the "Make permanent" payments Worker
// (src/payments-worker.js), driven against a Map-backed mock KV and a stubbed
// Stripe + control API (no network). Run:
//   node --test service/test/   (or `npm test` from /service)
//
// Exercises: pricing, checkout-session creation (Stripe mocked), webhook
// signature verification (good + tampered + stale), the payment→persist trigger
// via the control API (mocked), webhook idempotency, graceful degradation when
// Stripe / the control API are unconfigured, and the result-polling endpoint.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker, {
  randId, priceCents, stripeConfigured, controlConfigured,
  verifyStripeEvent, safeReturnUrl,
} from '../src/payments-worker.js';

// --- in-memory KV (subset we use) -------------------------------------------
function mockKV() {
  const m = new Map();
  return {
    _m: m,
    async get(key, type) {
      const v = m.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value, _opts) { m.set(key, value); },
    async delete(key) { m.delete(key); },
  };
}

const STRIPE_SECRET = 'sk_test_mock';
const WEBHOOK_SECRET = 'whsec_testsecret';

const baseEnv = (over = {}) => ({
  P2_PAY_KV: mockKV(),
  STRIPE_SECRET_KEY: STRIPE_SECRET,
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  ...over,
});

function req(method, path, { body, headers = {} } = {}) {
  return new Request(`https://pay.example${path}`, {
    method,
    headers: { ...headers },
    body: body === undefined ? undefined
      : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}
const call = (env, ...args) => worker.fetch(req(...args), env);

// Build a Stripe-style signature header for a raw payload.
function stripeSig(payload, secret = WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

// Stub global fetch to fake Stripe + control-API responses; returns a restore fn.
function stubFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  return () => { globalThis.fetch = real; };
}

// --- pure helpers -----------------------------------------------------------

test('randId is base62 of the requested length', () => {
  const id = randId(20);
  assert.equal(id.length, 20);
  assert.match(id, /^[0-9a-zA-Z]+$/);
});

test('priceCents = base + per-MiB, floored at the minimum', () => {
  const env = { PRICE_BASE_CENTS: '100', PRICE_PER_MIB_CENTS: '12', PRICE_MIN_CENTS: '100' };
  assert.equal(priceCents(0, env), 100);                 // floor
  assert.equal(priceCents(1024 * 1024, env), 112);       // 1 MiB → $1.12
  assert.equal(priceCents(10 * 1024 * 1024, env), 220);  // 10 MiB → $2.20
  // a tiny non-zero file rounds the per-MiB charge up to 1 cent over the base
  assert.equal(priceCents(123, env), 101);
  // with a higher floor, small files clamp up to it
  assert.equal(priceCents(123, { ...env, PRICE_MIN_CENTS: '250' }), 250);
});

test('stripeConfigured / controlConfigured gate on env presence', () => {
  assert.ok(!stripeConfigured({}));
  assert.ok(!stripeConfigured({ STRIPE_SECRET_KEY: 'x' }));
  assert.ok(stripeConfigured({ STRIPE_SECRET_KEY: 'x', STRIPE_WEBHOOK_SECRET: 'y' }));
  assert.ok(!controlConfigured({}));
  assert.ok(controlConfigured({ PERSIST_CONTROL_URL: 'https://c' }));
});

test('safeReturnUrl rejects non-http(s) + enforces an allow-list', () => {
  const reqUrl = new URL('https://pay.example/api/pay/checkout');
  assert.equal(safeReturnUrl('javascript:alert(1)', {}, reqUrl), 'https://pay.example/host/');
  assert.equal(safeReturnUrl('https://ok.test/host/', {}, reqUrl), 'https://ok.test/host/');
  const env = { ALLOW_RETURN_ORIGINS: 'https://ok.test', APP_BASE: 'https://fallback/host/' };
  assert.equal(safeReturnUrl('https://evil.test/x', env, reqUrl), 'https://fallback/host/');
  assert.equal(safeReturnUrl('https://ok.test/x', env, reqUrl), 'https://ok.test/x');
});

// --- webhook signature verification -----------------------------------------

test('verifyStripeEvent accepts a valid signature', async () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const t = 1_000_000;
  const sig = stripeSig(payload, WEBHOOK_SECRET, t);
  const ev = await verifyStripeEvent(payload, sig, WEBHOOK_SECRET, t, 300);
  assert.equal(ev.id, 'evt_1');
});

test('verifyStripeEvent rejects a tampered payload', async () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const t = 1_000_000;
  const sig = stripeSig(payload, WEBHOOK_SECRET, t);
  await assert.rejects(() => verifyStripeEvent(payload + 'x', sig, WEBHOOK_SECRET, t, 300), /invalid_signature/);
});

test('verifyStripeEvent rejects a stale timestamp beyond tolerance', async () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const sig = stripeSig(payload, WEBHOOK_SECRET, 1000);
  await assert.rejects(() => verifyStripeEvent(payload, sig, WEBHOOK_SECRET, 1000 + 9999, 300), /invalid_signature/);
});

// --- checkout ---------------------------------------------------------------

test('POST /api/pay/checkout creates a Stripe session + parks the job', async () => {
  const env = baseEnv();
  let sawBody = '';
  const restore = stubFetch((url, init) => {
    assert.match(url, /api\.stripe\.com\/v1\/checkout\/sessions/);
    assert.match(init.headers.authorization, /Bearer sk_test_mock/);
    sawBody = init.body;
    return new Response(JSON.stringify({ id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' }), { status: 200 });
  });
  try {
    const res = await call(env, 'POST', '/api/pay/checkout', { body: { provider: 'arweave', bytes: 5 * 1024 * 1024, name: 'talk.mp4' } });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.match(out.url, /checkout\.stripe\.com/);
    assert.equal(out.sessionId, 'cs_test_123');
    assert.equal(out.amount, priceCents(5 * 1024 * 1024, env));
    // job persisted in KV in the awaiting state
    const job = await env.P2_PAY_KV.get(`job:${out.jobId}`, 'json');
    assert.equal(job.status, 'awaiting_payment');
    assert.equal(job.provider, 'arweave');
    // success/cancel urls carry the jobId; metadata maps the session back to it
    assert.match(decodeURIComponent(sawBody), new RegExp(`job=${out.jobId}`));
    assert.match(decodeURIComponent(sawBody), new RegExp(`client_reference_id=${out.jobId}`));
  } finally { restore(); }
});

test('checkout rejects a bad provider, bad size, and oversize uploads', async () => {
  const env = baseEnv({ MAX_BYTES: '1000' });
  assert.equal((await call(env, 'POST', '/api/pay/checkout', { body: { provider: 'nope', bytes: 10 } })).status, 400);
  assert.equal((await call(env, 'POST', '/api/pay/checkout', { body: { provider: 'arweave', bytes: 0 } })).status, 400);
  assert.equal((await call(env, 'POST', '/api/pay/checkout', { body: { provider: 'arweave', bytes: 99999 } })).status, 413);
});

test('checkout degrades to 501 not_configured without Stripe keys', async () => {
  const env = { P2_PAY_KV: mockKV() }; // no Stripe keys
  const res = await call(env, 'POST', '/api/pay/checkout', { body: { provider: 'arweave', bytes: 10 } });
  assert.equal(res.status, 501);
  assert.equal((await res.json()).error, 'not_configured');
});

// --- webhook → persist ------------------------------------------------------

function completedEvent(jobId, id = 'evt_ok') {
  return JSON.stringify({
    id, type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_123', client_reference_id: jobId, payment_intent: 'pi_1' } },
  });
}

async function seedPaidJob(env, over = {}) {
  const restore = stubFetch(() => new Response(JSON.stringify({ id: 'cs_test_123', url: 'https://checkout.stripe.com/c/x' }), { status: 200 }));
  let out;
  try {
    out = await (await call(env, 'POST', '/api/pay/checkout', { body: { provider: 'arweave', bytes: 1024 * 1024, name: 'f', ...over } })).json();
  } finally { restore(); }
  return out.jobId;
}

test('webhook funds persistence via the control API and records the ref', async () => {
  const env = baseEnv({ PERSIST_CONTROL_URL: 'https://control.example/', PERSIST_CONTROL_TOKEN: 'ctl' });
  const jobId = await seedPaidJob(env);
  const payload = completedEvent(jobId);

  let controlCalled = false;
  const restore = stubFetch((url, init) => {
    if (/control\.example\/jobs/.test(url)) {
      controlCalled = true;
      assert.match(init.headers.authorization, /Bearer ctl/);
      const body = JSON.parse(init.body);
      assert.equal(body.jobId, jobId);
      assert.equal(body.provider, 'arweave');
      return new Response(JSON.stringify({ status: 'persisted', ref: 'ar://TX123', scheme: 'ar' }), { status: 200 });
    }
    throw new Error('unexpected fetch ' + url);
  });
  try {
    const res = await call(env, 'POST', '/api/pay/webhook', { body: payload, headers: { 'stripe-signature': stripeSig(payload) } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'persisted');
    assert.ok(controlCalled);
    const job = await env.P2_PAY_KV.get(`job:${jobId}`, 'json');
    assert.equal(job.ref, 'ar://TX123');
    assert.equal(job.scheme, 'ar');
  } finally { restore(); }
});

test('webhook with a bad signature → 400 and no state change', async () => {
  const env = baseEnv({ PERSIST_CONTROL_URL: 'https://control.example/' });
  const jobId = await seedPaidJob(env);
  const payload = completedEvent(jobId);
  const res = await call(env, 'POST', '/api/pay/webhook', { body: payload, headers: { 'stripe-signature': 't=1,v1=deadbeef' } });
  assert.equal(res.status, 400);
  const job = await env.P2_PAY_KV.get(`job:${jobId}`, 'json');
  assert.equal(job.status, 'awaiting_payment'); // untouched
});

test('webhook is idempotent on repeated event ids', async () => {
  const env = baseEnv({ PERSIST_CONTROL_URL: 'https://control.example/' });
  const jobId = await seedPaidJob(env);
  const payload = completedEvent(jobId, 'evt_dup');

  let controlCalls = 0;
  const restore = stubFetch(() => { controlCalls++; return new Response(JSON.stringify({ status: 'persisted', ref: 'ar://A', scheme: 'ar' }), { status: 200 }); });
  try {
    const sig = stripeSig(payload);
    const first = await call(env, 'POST', '/api/pay/webhook', { body: payload, headers: { 'stripe-signature': sig } });
    const second = await call(env, 'POST', '/api/pay/webhook', { body: payload, headers: { 'stripe-signature': stripeSig(payload) } });
    assert.equal(first.status, 200);
    assert.equal((await second.json()).duplicate, true);
    assert.equal(controlCalls, 1); // not re-funded
  } finally { restore(); }
});

test('webhook without a control API parks the job as paid_pending_backend', async () => {
  const env = baseEnv(); // no PERSIST_CONTROL_URL
  const jobId = await seedPaidJob(env);
  const payload = completedEvent(jobId, 'evt_nobackend');
  const res = await call(env, 'POST', '/api/pay/webhook', { body: payload, headers: { 'stripe-signature': stripeSig(payload) } });
  assert.equal(res.status, 200);
  const job = await env.P2_PAY_KV.get(`job:${jobId}`, 'json');
  assert.equal(job.status, 'paid_pending_backend');
});

test('webhook ignores unrelated event types', async () => {
  const env = baseEnv();
  const payload = JSON.stringify({ id: 'evt_x', type: 'customer.created', data: { object: {} } });
  const res = await call(env, 'POST', '/api/pay/webhook', { body: payload, headers: { 'stripe-signature': stripeSig(payload) } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ignored, 'customer.created');
});

// --- result polling ---------------------------------------------------------

test('GET /api/pay/result returns the job status + ref', async () => {
  const env = baseEnv({ PERSIST_CONTROL_URL: 'https://control.example/' });
  const jobId = await seedPaidJob(env);
  const payload = completedEvent(jobId, 'evt_res');
  const restore = stubFetch(() => new Response(JSON.stringify({ status: 'persisted', ref: 'ipfs://bafyX', scheme: 'ipfs' }), { status: 200 }));
  try {
    await call(env, 'POST', '/api/pay/webhook', { body: payload, headers: { 'stripe-signature': stripeSig(payload) } });
  } finally { restore(); }

  const res = await call(env, 'GET', `/api/pay/result?jobId=${jobId}`);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.status, 'persisted');
  assert.equal(out.ref, 'ipfs://bafyX');
  assert.equal(out.scheme, 'ipfs');
});

test('result for an unknown job → 404; missing jobId → 400', async () => {
  const env = baseEnv();
  assert.equal((await call(env, 'GET', '/api/pay/result?jobId=nope')).status, 404);
  assert.equal((await call(env, 'GET', '/api/pay/result')).status, 400);
});

// --- routing / misc ---------------------------------------------------------

test('GET / reports which rails are configured', async () => {
  const res = await call(baseEnv({ PERSIST_CONTROL_URL: 'https://c/' }), 'GET', '/');
  const info = await res.json();
  assert.equal(info.ok, true);
  assert.equal(info.stripe, true);
  assert.equal(info.control, true);
});

test('missing KV binding → 500 misconfigured', async () => {
  const res = await worker.fetch(req('GET', '/'), {});
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'misconfigured');
});

test('OPTIONS preflight returns CORS headers', async () => {
  const res = await call(baseEnv(), 'OPTIONS', '/api/pay/checkout');
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-methods'), /POST/);
});
