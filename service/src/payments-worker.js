// payments-worker.js — p2present "Make permanent" payment rail (Stripe, fiat).
//
// A SIBLING Cloudflare Worker to the pastebin-lite worker (src/worker.js). It is
// the server side of docs/src/persist/payments.js: it turns a "make this asset
// permanent" request into a real Stripe Checkout charge, and — once the charge
// is confirmed by Stripe's webhook — triggers the actual persistence by calling
// the deploy/ control API (which funds an Arweave upload, pins to IPFS, or seeds
// a torrent depending on the chosen provider). The resulting permanent reference
// (ar:// / ipfs:// / magnet:) is recorded against the job so the browser can poll
// it back and reflect it into the manifest.
//
// Static-first / graceful degradation: the docs/ site never imports this. If the
// Stripe keys are unset the checkout endpoint reports `not_configured` and the
// client falls back to the documented "payment not configured" stub. If the
// control API is unset, payment still succeeds and the job is parked as
// `paid_pending_backend` (an operator can fulfil it later) rather than crashing.
//
// API (all JSON, CORS-enabled):
//   GET    /                      → service info (which rails are configured)
//   POST   /api/pay/checkout      body { provider, bytes, name?, returnUrl? }
//                                 → { jobId, url, sessionId } (redirect to `url`)
//   POST   /api/pay/webhook       Stripe webhook (raw body + Stripe-Signature)
//                                 → 200 once handled; funds persistence on success
//   GET    /api/pay/result?jobId= → { status, ref?, scheme?, amount, currency }
//
// Storage (KV binding P2_PAY_KV):
//   job:<jobId>      → { jobId, status, provider, bytes, name, amount, currency,
//                        sessionId, paymentIntent?, ref?, scheme?, created, updated,
//                        note? }
//   evt:<eventId>    → '1' marker for webhook idempotency (TTL'd)
//
// Secrets (NEVER committed — `wrangler secret put`, or .dev.vars for local):
//   STRIPE_SECRET_KEY        sk_test_… / sk_live_…
//   STRIPE_WEBHOOK_SECRET    whsec_…
//   PERSIST_CONTROL_TOKEN    bearer token the control API expects
// Public config ([vars] in wrangler.payments.toml):
//   PERSIST_CONTROL_URL      https://control.example/  (the deploy/ control API)
//   PRICE_BASE_CENTS         flat fee per upload (default 100 = $1.00)
//   PRICE_PER_MIB_CENTS      per-MiB price (default 12 = $0.12/MiB)
//   PRICE_MIN_CENTS          floor (default 100)
//   MAX_BYTES                largest accepted upload (default 2 GiB)
//   ALLOW_ORIGIN             CORS origin (default *)
//   CURRENCY                 ISO currency (default usd)

const DEFAULTS = {
  PRICE_BASE_CENTS: 100,        // $1.00 flat
  PRICE_PER_MIB_CENTS: 12,      // $0.12 per MiB
  PRICE_MIN_CENTS: 100,         // never charge less than $1.00
  MAX_BYTES: 2 * 1024 * 1024 * 1024, // 2 GiB
  WEBHOOK_TOLERANCE: 300,       // seconds of clock skew tolerated on the signature
  EVENT_TTL: 7 * 24 * 3600,     // idempotency markers live a week
};

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const cfg = (env, key) => num(env?.[key], DEFAULTS[key]);
const currency = (env) => (env?.CURRENCY || 'usd').toLowerCase();

// --- ids / hashing ----------------------------------------------------------

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function randId(len = 16) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % 62];
  return s;
}

// --- responses / CORS -------------------------------------------------------

function corsHeaders(env) {
  return {
    'access-control-allow-origin': env?.ALLOW_ORIGIN || '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,stripe-signature',
    'access-control-max-age': '86400',
  };
}

function json(data, status, env, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(env), ...extra },
  });
}

// --- config gates -----------------------------------------------------------

export function stripeConfigured(env) {
  return !!env?.STRIPE_SECRET_KEY && !!env?.STRIPE_WEBHOOK_SECRET;
}
export function controlConfigured(env) {
  return !!env?.PERSIST_CONTROL_URL;
}

// --- pricing ----------------------------------------------------------------

/** Price (in the smallest currency unit, e.g. cents) for persisting `bytes`. */
export function priceCents(bytes, env) {
  const mib = Math.max(0, Number(bytes) || 0) / (1024 * 1024);
  const raw = cfg(env, 'PRICE_BASE_CENTS') + Math.ceil(mib * cfg(env, 'PRICE_PER_MIB_CENTS'));
  return Math.max(cfg(env, 'PRICE_MIN_CENTS'), Math.round(raw));
}

// --- supported persistence providers (mirror docs/src/persist) --------------

const PROVIDER_SCHEME = { arweave: 'ar', pinning: 'ipfs', seedbox: 'magnet', s3: 'https' };
function normalizeProvider(p) {
  const id = String(p || 'arweave').toLowerCase();
  return PROVIDER_SCHEME[id] ? id : null;
}

// --- Stripe REST (no SDK; form-encoded calls over fetch) --------------------

function formEncode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out;
}

/** Create a Stripe Checkout Session. `doFetch` is injectable for tests. */
export async function createCheckoutSession(env, { amount, name, jobId, successUrl, cancelUrl }, doFetch = fetch) {
  const body = formEncode({
    mode: 'payment',
    'success_url': successUrl,
    'cancel_url': cancelUrl,
    client_reference_id: jobId,
    'metadata': { jobId },
    'line_items': {
      0: {
        quantity: 1,
        'price_data': {
          currency: currency(env),
          'unit_amount': amount,
          'product_data': { name: name || 'p2present — permanent storage' },
        },
      },
    },
    'payment_intent_data': { 'metadata': { jobId } },
  }).join('&');

  const res = await doFetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`stripe checkout failed: HTTP ${res.status} ${data?.error?.message || ''}`.trim());
  }
  return data; // { id, url, ... }
}

// --- Stripe webhook signature verification ----------------------------------

async function hmacSha256Hex(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time-ish equality on two equal-length hex strings. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a Stripe webhook signature and return the parsed event.
 * @throws Error('invalid_signature') on any mismatch.
 */
export async function verifyStripeEvent(payload, sigHeader, secret, nowSec, tolerance = DEFAULTS.WEBHOOK_TOLERANCE) {
  const parts = Object.fromEntries(
    String(sigHeader || '').split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }).filter(([k]) => k));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) throw new Error('invalid_signature');
  if (Number.isFinite(tolerance) && Math.abs(nowSec - t) > tolerance) throw new Error('invalid_signature');
  const expected = await hmacSha256Hex(secret, `${t}.${payload}`);
  if (!timingSafeEqual(expected, v1)) throw new Error('invalid_signature');
  return JSON.parse(payload);
}

// --- control API (deploy/) — enqueue the actual persistence -----------------

/**
 * Tell the deploy/ control API to persist the (already client-staged) job and
 * return its reference. Returns { ref, scheme, status } or { status } if still
 * processing. `doFetch` is injectable for tests.
 */
export async function enqueuePersist(env, job, doFetch = fetch) {
  const base = env.PERSIST_CONTROL_URL.replace(/\/$/, '');
  const res = await doFetch(`${base}/jobs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(env.PERSIST_CONTROL_TOKEN ? { authorization: `Bearer ${env.PERSIST_CONTROL_TOKEN}` } : {}),
    },
    body: JSON.stringify({ jobId: job.jobId, provider: job.provider, bytes: job.bytes, name: job.name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`control enqueue failed: HTTP ${res.status} ${data?.error || ''}`.trim());
  return data; // { status, ref?, scheme? }
}

// --- handlers ---------------------------------------------------------------

export async function handleCheckout(request, env, reqUrl) {
  if (!stripeConfigured(env)) {
    return json({ error: 'not_configured', detail: 'Stripe keys are not set on this service.' }, 501, env);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400, env); }

  const provider = normalizeProvider(body?.provider);
  if (!provider) return json({ error: 'bad_provider', detail: 'provider must be arweave|pinning|seedbox|s3' }, 400, env);

  const bytes = Math.floor(Number(body?.bytes));
  if (!Number.isFinite(bytes) || bytes <= 0) return json({ error: 'bad_bytes' }, 400, env);
  if (bytes > cfg(env, 'MAX_BYTES')) return json({ error: 'too_large', max: cfg(env, 'MAX_BYTES') }, 413, env);

  const name = String(body?.name || '').slice(0, 200) || 'asset';
  const amount = priceCents(bytes, env);
  const jobId = randId(20);

  // success/cancel return the browser to the host page with the jobId so it can
  // poll /api/pay/result and reflect the permanent ref back into the manifest.
  const ret = safeReturnUrl(body?.returnUrl, env, reqUrl);
  const successUrl = withParams(ret, { p2pay: 'success', job: jobId });
  const cancelUrl = withParams(ret, { p2pay: 'cancel', job: jobId });

  let session;
  try {
    session = await createCheckoutSession(env, { amount, name, jobId, successUrl, cancelUrl });
  } catch (e) {
    return json({ error: 'stripe_error', detail: String(e?.message || e) }, 502, env);
  }

  const now = Date.now();
  const job = {
    jobId, status: 'awaiting_payment', provider, bytes, name,
    amount, currency: currency(env), sessionId: session.id, created: now, updated: now,
  };
  await env.P2_PAY_KV.put(`job:${jobId}`, JSON.stringify(job));

  return json({ jobId, url: session.url, sessionId: session.id, amount, currency: currency(env) }, 200, env);
}

export async function handleWebhook(request, env) {
  if (!stripeConfigured(env)) return json({ error: 'not_configured' }, 501, env);
  const payload = await request.text();
  const sig = request.headers.get('stripe-signature');

  let event;
  try {
    event = await verifyStripeEvent(payload, sig, env.STRIPE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000));
  } catch {
    return json({ error: 'invalid_signature' }, 400, env);
  }

  // Idempotency: Stripe may retry the same event id.
  if (event.id) {
    if (await env.P2_PAY_KV.get(`evt:${event.id}`)) return json({ received: true, duplicate: true }, 200, env);
    await env.P2_PAY_KV.put(`evt:${event.id}`, '1', { expirationTtl: DEFAULTS.EVENT_TTL });
  }

  if (event.type !== 'checkout.session.completed' && event.type !== 'payment_intent.succeeded') {
    return json({ received: true, ignored: event.type }, 200, env);
  }

  const obj = event.data?.object || {};
  const jobId = obj.client_reference_id || obj.metadata?.jobId;
  if (!jobId) return json({ received: true, note: 'no jobId on event' }, 200, env);

  const job = await env.P2_PAY_KV.get(`job:${jobId}`, 'json');
  if (!job) return json({ received: true, note: 'unknown job' }, 200, env);
  if (job.status === 'persisted' || job.status === 'persisting') {
    return json({ received: true, already: job.status }, 200, env);
  }

  job.status = 'paid';
  job.paymentIntent = obj.payment_intent || obj.id || null;
  job.updated = Date.now();

  // Trigger the real persistence via the deploy/ control API.
  if (controlConfigured(env)) {
    try {
      const out = await enqueuePersist(env, job);
      if (out.ref) {
        job.status = 'persisted';
        job.ref = out.ref;
        job.scheme = out.scheme || PROVIDER_SCHEME[job.provider];
      } else {
        job.status = 'persisting';     // backend accepted; client keeps polling
        job.note = out.status || 'queued';
      }
    } catch (e) {
      job.status = 'paid_backend_error';
      job.note = String(e?.message || e);
    }
  } else {
    job.status = 'paid_pending_backend';
    job.note = 'Payment captured; no persistence control API is configured on this service.';
  }

  job.updated = Date.now();
  await env.P2_PAY_KV.put(`job:${jobId}`, JSON.stringify(job));
  return json({ received: true, jobId, status: job.status }, 200, env);
}

export async function handleResult(reqUrl, env) {
  const jobId = reqUrl.searchParams.get('jobId') || reqUrl.searchParams.get('job');
  if (!jobId) return json({ error: 'jobId_required' }, 400, env);
  const job = await env.P2_PAY_KV.get(`job:${jobId}`, 'json');
  if (!job) return json({ error: 'not_found' }, 404, env);
  return json({
    jobId: job.jobId, status: job.status, provider: job.provider,
    ref: job.ref || null, scheme: job.scheme || null,
    amount: job.amount, currency: job.currency, note: job.note,
  }, 200, env);
}

// --- return-url helpers -----------------------------------------------------

/** Only allow returning the browser to an http(s) URL we trust. */
export function safeReturnUrl(raw, env, reqUrl) {
  const fallback = env?.APP_BASE || `${reqUrl.origin}/host/`;
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return fallback;
    if (env?.ALLOW_RETURN_ORIGINS) {
      const allowed = String(env.ALLOW_RETURN_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
      if (allowed.length && !allowed.includes(u.origin)) return fallback;
    }
    return u.toString();
  } catch { return fallback; }
}

function withParams(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

// --- router -----------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    try {
      if (!env || !env.P2_PAY_KV) {
        return json({ error: 'misconfigured', detail: 'KV binding P2_PAY_KV missing' }, 500, env);
      }

      if (pathname === '/' && request.method === 'GET') {
        return json({
          service: 'p2present payments', ok: true,
          stripe: stripeConfigured(env), control: controlConfigured(env),
        }, 200, env);
      }
      if (pathname === '/api/pay/checkout' && request.method === 'POST') {
        return await handleCheckout(request, env, url);
      }
      if (pathname === '/api/pay/webhook' && request.method === 'POST') {
        return await handleWebhook(request, env);
      }
      if (pathname === '/api/pay/result' && request.method === 'GET') {
        return await handleResult(url, env);
      }
      return json({ error: 'not_found' }, 404, env);
    } catch (err) {
      return json({ error: 'server_error', detail: String(err?.message || err) }, 500, env);
    }
  },
};
