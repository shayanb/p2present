// worker.test.mjs — unit tests for the pastebin-lite Worker handlers, driven
// against a Map-backed mock KV (no network, no real Cloudflare). Run:
//   node --test service/test/   (or `npm test` from /service)
//
// Exercises: create → get round-trip, size cap, invalid bodies, edit-token
// PUT/DELETE auth, expiry (TTL plumbed to KV), per-IP rate limiting, the report
// endpoint + auto-hide, public listing, and the /p/:id human redirect.

import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { randId, sha256hex, validateManifest, ipfsEnabled } from '../src/worker.js';

// --- a tiny in-memory KV that mimics the subset of the KV API we use ---------
function mockKV() {
  const m = new Map();
  const puts = []; // record options so tests can assert TTLs were passed
  return {
    _m: m,
    _puts: puts,
    async get(key, type) {
      const v = m.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value, opts) {
      puts.push({ key, opts: opts || {} });
      m.set(key, value);
    },
    async delete(key) { m.delete(key); },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

const baseEnv = (over = {}) => ({ P2_KV: mockKV(), ...over });

const VALID = {
  p2present: '1.0',
  title: 'Test Deck',
  video: { sources: [{ provider: 'youtube', src: 'abc' }] },
  deck: { type: 'html', sources: [{ src: 'slides/index.html' }] },
  timing: [{ time: 0, slide: 1 }],
};

function req(method, path, { body, headers = {}, ip = '1.2.3.4' } = {}) {
  return new Request(`https://svc.example${path}`, {
    method,
    headers: { 'cf-connecting-ip': ip, ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

const call = (env, ...args) => worker.fetch(req(...args), env, { waitUntil() {} });

// --- helpers ----------------------------------------------------------------

test('randId is base62 and the requested length', () => {
  const id = randId(8);
  assert.equal(id.length, 8);
  assert.match(id, /^[0-9a-zA-Z]+$/);
  assert.notEqual(randId(8), randId(8)); // overwhelmingly likely distinct
});

test('sha256hex is stable + 64 hex chars', async () => {
  const a = await sha256hex('hello');
  assert.equal(a.length, 64);
  assert.equal(a, await sha256hex('hello'));
  assert.notEqual(a, await sha256hex('world'));
});

test('validateManifest accepts a real manifest, rejects junk', () => {
  assert.ok(validateManifest(VALID).ok);
  assert.ok(!validateManifest({}).ok);
  assert.ok(!validateManifest({ video: { sources: [] }, deck: { type: 'html' } }).ok);
  assert.ok(!validateManifest({ video: { sources: [{}] } }).ok); // no deck
});

test('ipfsEnabled needs both the flag AND a token', () => {
  assert.ok(!ipfsEnabled({ IPFS_PIN: 'true' }));
  assert.ok(!ipfsEnabled({ IPFS_PIN_TOKEN: 'x' }));
  assert.ok(ipfsEnabled({ IPFS_PIN: 'true', IPFS_PIN_TOKEN: 'x' }));
});

// --- create → get -----------------------------------------------------------

test('POST /api/p creates; GET /api/p/:id round-trips the manifest', async () => {
  const env = baseEnv();
  const res = await call(env, 'POST', '/api/p', { body: VALID });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.match(out.id, /^[0-9a-zA-Z]{8}$/);
  assert.match(out.editToken, /^[0-9a-zA-Z]{40}$/);
  assert.equal(out.url, `https://svc.example/p/${out.id}`);
  assert.equal(out.manifestUrl, `https://svc.example/api/p/${out.id}`);
  assert.equal(out.visibility, 'unlisted');

  // token is NOT stored in plaintext, only its hash
  const rec = await env.P2_KV.get(`doc:${out.id}`, 'json');
  assert.equal(rec.meta.tokenHash, await sha256hex(out.editToken));
  assert.ok(!JSON.stringify(rec).includes(out.editToken));

  const got = await call(env, 'GET', `/api/p/${out.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(await got.json(), VALID);
  assert.match(got.headers.get('access-control-allow-origin'), /\*/);
});

test('GET unknown id → 404', async () => {
  const res = await call(baseEnv(), 'GET', '/api/p/doesnotexist');
  assert.equal(res.status, 404);
});

test('POST rejects oversized bodies → 413', async () => {
  const env = baseEnv({ MAX_BYTES: '100' });
  const big = { ...VALID, title: 'x'.repeat(500) };
  const res = await call(env, 'POST', '/api/p', { body: big });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'too_large');
});

test('POST rejects invalid JSON → 400; non-manifest → 400', async () => {
  const env = baseEnv();
  const bad = await call(env, 'POST', '/api/p', { body: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'invalid_json');

  const notManifest = await call(env, 'POST', '/api/p', { body: { hello: 'world' } });
  assert.equal(notManifest.status, 400);
  assert.equal((await notManifest.json()).error, 'invalid_manifest');
});

// --- visibility + listing ---------------------------------------------------

test('public visibility is listed by /api/recent; unlisted is not', async () => {
  const env = baseEnv();
  const pub = await (await call(env, 'POST', '/api/p?visibility=public', { body: VALID, ip: 'a' })).json();
  await call(env, 'POST', '/api/p', { body: VALID, ip: 'b' }); // unlisted

  const recent = await (await call(env, 'GET', '/api/recent')).json();
  assert.deepEqual(recent.ids, [pub.id]);
  assert.equal(recent.count, 1);
});

// --- expiry -----------------------------------------------------------------

test('expiry plumbs expirationTtl to KV and records expires', async () => {
  const env = baseEnv();
  const out = await (await call(env, 'POST', '/api/p?ttl=120', { body: VALID })).json();
  assert.ok(out.expires > Date.now());
  const docPut = env.P2_KV._puts.find((p) => p.key === `doc:${out.id}`);
  assert.equal(docPut.opts.expirationTtl, 120);
});

test('expiry is clamped to MAX_TTL', async () => {
  const env = baseEnv({ MAX_TTL: '60' });
  const out = await (await call(env, 'POST', '/api/p?ttl=999999', { body: VALID })).json();
  const docPut = env.P2_KV._puts.find((p) => p.key === `doc:${out.id}`);
  assert.equal(docPut.opts.expirationTtl, 60);
});

// --- edit token: PUT / DELETE auth ------------------------------------------

test('PUT updates with the right token, rejects a wrong/missing one', async () => {
  const env = baseEnv();
  const out = await (await call(env, 'POST', '/api/p', { body: VALID })).json();
  const updated = { ...VALID, title: 'Edited' };

  const noTok = await call(env, 'PUT', `/api/p/${out.id}`, { body: updated });
  assert.equal(noTok.status, 403);

  const wrong = await call(env, 'PUT', `/api/p/${out.id}`, { body: updated, headers: { authorization: 'Bearer nope' } });
  assert.equal(wrong.status, 403);

  const ok = await call(env, 'PUT', `/api/p/${out.id}`, { body: updated, headers: { authorization: `Bearer ${out.editToken}` } });
  assert.equal(ok.status, 200);

  const got = await (await call(env, 'GET', `/api/p/${out.id}`)).json();
  assert.equal(got.title, 'Edited');
});

test('PUT can flip visibility public/unlisted', async () => {
  const env = baseEnv();
  const out = await (await call(env, 'POST', '/api/p', { body: VALID })).json();
  await call(env, 'PUT', `/api/p/${out.id}?visibility=public`, { body: VALID, headers: { authorization: `Bearer ${out.editToken}` } });
  let recent = await (await call(env, 'GET', '/api/recent')).json();
  assert.deepEqual(recent.ids, [out.id]);
  await call(env, 'PUT', `/api/p/${out.id}?visibility=unlisted`, { body: VALID, headers: { authorization: `Bearer ${out.editToken}` } });
  recent = await (await call(env, 'GET', '/api/recent')).json();
  assert.equal(recent.count, 0);
});

test('DELETE removes the doc with the right token only', async () => {
  const env = baseEnv();
  const out = await (await call(env, 'POST', '/api/p', { body: VALID })).json();
  assert.equal((await call(env, 'DELETE', `/api/p/${out.id}`)).status, 403);
  const ok = await call(env, 'DELETE', `/api/p/${out.id}`, { headers: { authorization: `Bearer ${out.editToken}` } });
  assert.equal(ok.status, 200);
  assert.equal((await call(env, 'GET', `/api/p/${out.id}`)).status, 404);
});

// --- rate limiting ----------------------------------------------------------

test('per-IP rate limit returns 429 once over the cap', async () => {
  const env = baseEnv({ RATE_MAX: '2' });
  assert.equal((await call(env, 'POST', '/api/p', { body: VALID, ip: 'z' })).status, 200);
  assert.equal((await call(env, 'POST', '/api/p', { body: VALID, ip: 'z' })).status, 200);
  assert.equal((await call(env, 'POST', '/api/p', { body: VALID, ip: 'z' })).status, 429);
  // a different IP is unaffected
  assert.equal((await call(env, 'POST', '/api/p', { body: VALID, ip: 'other' })).status, 200);
});

// --- reports + auto-hide ----------------------------------------------------

test('report increments count and auto-hides past the threshold', async () => {
  const env = baseEnv({ REPORT_HIDE_THRESHOLD: '2' });
  const out = await (await call(env, 'POST', '/api/p', { body: VALID })).json();

  const r1 = await (await call(env, 'POST', '/api/report', { body: { id: out.id, reason: 'spam' } })).json();
  assert.equal(r1.reports, 1);
  assert.equal(r1.hidden, false);
  assert.equal((await call(env, 'GET', `/api/p/${out.id}`)).status, 200);

  const r2 = await (await call(env, 'POST', '/api/report', { body: { id: out.id, reason: 'spam' } })).json();
  assert.equal(r2.reports, 2);
  assert.equal(r2.hidden, true);
  assert.equal((await call(env, 'GET', `/api/p/${out.id}`)).status, 451); // unavailable
});

test('report on unknown id → 404; missing id → 400', async () => {
  const env = baseEnv();
  assert.equal((await call(env, 'POST', '/api/report', { body: { id: 'nope' } })).status, 404);
  assert.equal((await call(env, 'POST', '/api/report', { body: {} })).status, 400);
});

// --- human redirect + misc routing ------------------------------------------

test('GET /p/:id redirects into the player app', async () => {
  // No APP_BASE in this env → defaults to the request origin's /app/.
  const res = await call(baseEnv(), 'GET', '/p/abc123');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://svc.example/app/?p=abc123');
});

test('APP_BASE overrides the redirect target', async () => {
  const res = await call(baseEnv({ APP_BASE: 'https://my.site/player' }), 'GET', '/p/xyz');
  assert.equal(res.headers.get('location'), 'https://my.site/player/?p=xyz');
});

test('OPTIONS preflight returns CORS headers', async () => {
  const res = await call(baseEnv(), 'OPTIONS', '/api/p');
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-methods'), /POST/);
});

test('GET / returns service info', async () => {
  const res = await call(baseEnv(), 'GET', '/');
  assert.equal(res.status, 200);
  const info = await res.json();
  assert.equal(info.ok, true);
  assert.equal(info.ipfsMirror, false);
});

test('missing KV binding → 500 misconfigured', async () => {
  const res = await worker.fetch(req('GET', '/'), {}, {});
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'misconfigured');
});

test('optional IPFS mirror pins on create when enabled', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ IpfsHash: 'bafkmock' }), { status: 200 });
  try {
    const env = baseEnv({ IPFS_PIN: 'true', IPFS_PIN_TOKEN: 'jwt' });
    const out = await (await call(env, 'POST', '/api/p', { body: VALID })).json();
    assert.equal(out.ipfs, 'ipfs://bafkmock');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- per-talk OG page (/p/:id) ------------------------------------------------

test('GET /p/:id for a KNOWN id serves a per-talk OG page (not a bare redirect)', async () => {
  const env = baseEnv();
  const { id } = await (await call(env, 'POST', '/api/p', { body: { ...VALID, title: 'OG <Talk> & Co', meta: { author: 'Shayan', event: 'Berlin 2026' } } })).json();
  const res = await call(env, 'GET', `/p/${id}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /property="og:title" content="OG &lt;Talk&gt; &amp; Co"/);   // escaped
  assert.match(html, /property="og:description" content="Shayan · Berlin 2026/);
  // VALID's youtube src ('abc') is too short for a thumb → site-card fallback
  assert.match(html, /content="https:\/\/svc\.example\/brand\/og-card\.png"/);
});

test('OG image prefers absolute poster, then YouTube thumb, then the site card', async () => {
  const { ogImageFor } = await import('../src/worker.js');
  const reqUrl = new URL('https://svc.example/p/x');
  assert.equal(
    ogImageFor({ video: { poster: 'https://cdn.example/p.jpg', sources: [] } }, {}, reqUrl),
    'https://cdn.example/p.jpg');
  assert.equal(
    ogImageFor({ video: { sources: [{ provider: 'youtube', src: 'uYygWN1MZDE' }] } }, {}, reqUrl),
    'https://i.ytimg.com/vi/uYygWN1MZDE/hqdefault.jpg');
  assert.equal(
    ogImageFor({ video: { sources: [{ provider: 'youtube', src: 'https://youtu.be/uYygWN1MZDE?t=1' }] } }, {}, reqUrl),
    'https://i.ytimg.com/vi/uYygWN1MZDE/hqdefault.jpg');
  assert.equal(
    ogImageFor({ video: { sources: [{ provider: 'mp4', src: 'talk.mp4' }] } }, { APP_BASE: 'https://p2present.com/app/' }, reqUrl),
    'https://p2present.com/brand/og-card.png');
  assert.equal(ogImageFor({}, {}, reqUrl), 'https://svc.example/brand/og-card.png');
});

test('GET /p/:id for a hidden or expired id falls back to the 302 redirect', async () => {
  const env = baseEnv();
  const { id } = await (await call(env, 'POST', '/api/p', { body: VALID })).json();
  const rec = await env.P2_KV.get(`doc:${id}`, 'json');
  rec.meta.hidden = true;
  await env.P2_KV.put(`doc:${id}`, JSON.stringify(rec));
  const res = await call(env, 'GET', `/p/${id}`);
  assert.equal(res.status, 302);
});

// --- /api/chapters --------------------------------------------------------------

test('videoIdFrom accepts urls, short links, shorts, and bare ids', async () => {
  const { videoIdFrom } = await import('../src/worker.js');
  assert.equal(videoIdFrom('https://www.youtube.com/watch?v=uYygWN1MZDE&t=5'), 'uYygWN1MZDE');
  assert.equal(videoIdFrom('https://youtu.be/uYygWN1MZDE'), 'uYygWN1MZDE');
  assert.equal(videoIdFrom('https://www.youtube.com/shorts/uYygWN1MZDE'), 'uYygWN1MZDE');
  assert.equal(videoIdFrom('uYygWN1MZDE'), 'uYygWN1MZDE');
  assert.equal(videoIdFrom('https://example.com/talk.mp4'), null);
  assert.equal(videoIdFrom(''), null);
});

test('chaptersFromText parses M:SS lines and rejects single timestamps', async () => {
  const { chaptersFromText } = await import('../src/worker.js');
  const list = chaptersFromText('intro text\n0:00 Title slide\n1:24 - The problem\n1:02:03 The fix\nno timestamp here');
  assert.deepEqual(list.map((c) => c.time), ['0:00', '1:24', '1:02:03']);
  assert.equal(list[1].label, 'The problem');
  assert.deepEqual(chaptersFromText('0:00 only one'), []);
});

test('extractChapters prefers chapterRenderer markers, falls back to description', async () => {
  const { extractChapters } = await import('../src/worker.js');
  const markers =
    '{"chapterRenderer":{"title":{"simpleText":"Intro"},"timeRangeStartMillis":0}}' +
    '{"chapterRenderer":{"title":{"simpleText":"The \\"fix\\""},"timeRangeStartMillis":84000}}';
  const viaMarkers = extractChapters(markers);
  assert.deepEqual(viaMarkers, [{ time: '0:00', label: 'Intro' }, { time: '1:24', label: 'The "fix"' }]);
  const viaDesc = extractChapters('"shortDescription":"hello\\n0:00 One\\n2:10 Two\\n"');
  assert.deepEqual(viaDesc.map((c) => c.label), ['One', 'Two']);
  assert.deepEqual(extractChapters('<html>nothing here</html>'), []);
});

test('GET /api/chapters proxies YouTube, caches in KV, and validates input', async () => {
  const realFetch = globalThis.fetch;
  const page = '"chapterRenderer":{"title":{"simpleText":"Start"},"timeRangeStartMillis":0}' +
               '"chapterRenderer":{"title":{"simpleText":"Middle"},"timeRangeStartMillis":90000}';
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls++; return new Response(page, { status: 200 }); };
  try {
    const env = baseEnv();
    const bad = await call(env, 'GET', '/api/chapters?u=nope');
    assert.equal(bad.status, 400);
    const res = await call(env, 'GET', '/api/chapters?u=https://youtu.be/uYygWN1MZDE');
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.videoId, 'uYygWN1MZDE');
    assert.deepEqual(out.chapters.map((c) => c.time), ['0:00', '1:30']);
    // second call is served from the KV cache (no new upstream fetch)
    const res2 = await call(env, 'GET', '/api/chapters?u=uYygWN1MZDE');
    assert.equal((await res2.json()).cached, true);
    assert.equal(upstreamCalls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
