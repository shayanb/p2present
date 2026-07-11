// worker.js — p2present "pastebin-lite": a tiny Cloudflare Worker + KV backend.
// that hosts p2present.json manifests behind short ids.
//
// This is the OPTIONAL community-hosting backend. The p2present app is a static
// site that works without it (paste a URL / ipfs:// / magnet:, or build + host
// your own). The service just gives authors a one-click "Save & share" → short
// link flow on top of that. Self-hosters deploy their own copy (see SERVICE.md)
// and point a domain at it.
//
// API (all JSON, CORS-enabled):
//   POST   /api/p            body = p2present.json   → { id, editToken, url, ... }
//   GET    /api/p/:id                                → the manifest JSON (player fetch)
//   PUT    /api/p/:id        Authorization: Bearer <editToken>, body = manifest
//   DELETE /api/p/:id        Authorization: Bearer <editToken>
//   POST   /api/report       body = { id, reason }   → records a report
//   GET    /api/chapters?u=… YouTube chapter proxy for the Builder (KV-cached)
//   GET    /api/recent                               → recent PUBLIC ids (listing)
//   GET    /p/:id            → per-talk OG page + instant redirect into the player
//                              (unknown/hidden/expired ids → plain 302)
//   GET    /                                         → service info
//
// Query params on create: ?visibility=public|unlisted (default unlisted),
//                         ?ttl=<seconds> (alias ?expiry=) for optional expiry.
//
// Storage (KV binding P2_KV):
//   doc:<id>        → { manifest, meta:{ id, created, updated, visibility,
//                       tokenHash, reports, hidden?, expires?, ipfs? } }
//   pub:<id>        → created-ts marker for public listing (mirrors doc TTL)
//   rl:<ip>         → per-IP write counter (short TTL) for rate limiting
//   report:<id>:<ts>→ individual report records (TTL'd)
//
// Edit tokens are stored ONLY as a SHA-256 hash; the plaintext is returned once
// at create time and kept by the author's browser. No secrets are committed —
// the optional IPFS pin token is a wrangler secret read from env at runtime.

// --- config helpers ---------------------------------------------------------

const DEFAULTS = {
  MAX_BYTES: 262144,      // 256 KiB manifest cap
  RATE_MAX: 40,           // writes per window per IP
  RATE_WINDOW: 600,       // seconds
  MAX_TTL: 31536000,      // 1 year (KV max-ish; clamp requested expiry to this)
  REPORT_HIDE_THRESHOLD: 5,
  RECENT_LIMIT: 50,
};

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const cfg = (env, key) => num(env?.[key], DEFAULTS[key]);

// --- ids, tokens, hashing ---------------------------------------------------

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Random url-safe base62 string of `len` chars (crypto-strong). */
export function randId(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % 62];
  return s;
}

export async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --- responses / CORS -------------------------------------------------------

function corsHeaders(env) {
  return {
    'access-control-allow-origin': env?.ALLOW_ORIGIN || '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '86400',
  };
}

function json(data, status, env, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(env), ...extra },
  });
}

// --- validation -------------------------------------------------------------

/** Light structural check that a body really is a p2present manifest. */
export function validateManifest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, error: 'manifest must be a JSON object' };
  if (!m.video || typeof m.video !== 'object' || !Array.isArray(m.video.sources) || !m.video.sources.length) {
    return { ok: false, error: 'manifest.video.sources[] is required' };
  }
  if (!m.deck || typeof m.deck !== 'object' || !m.deck.type) {
    return { ok: false, error: 'manifest.deck{type,sources} is required' };
  }
  return { ok: true };
}

function clampTtl(raw, env) {
  if (raw == null || raw === '') return null;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, cfg(env, 'MAX_TTL'));
}

// --- rate limiting ----------------------------------------------------------

async function allowWrite(env, ip) {
  const max = cfg(env, 'RATE_MAX');
  const win = Math.max(60, cfg(env, 'RATE_WINDOW')); // KV TTL floor is 60s
  const key = `rl:${ip || 'unknown'}`;
  const cur = parseInt((await env.P2_KV.get(key)) || '0', 10) || 0;
  if (cur >= max) return false;
  await env.P2_KV.put(key, String(cur + 1), { expirationTtl: win });
  return true;
}

// --- optional IPFS mirror ---------------------------------------------------

export function ipfsEnabled(env) {
  return String(env?.IPFS_PIN) === 'true' && !!env?.IPFS_PIN_TOKEN;
}

async function pinToIpfs(env, manifest) {
  const endpoint = env.IPFS_PIN_ENDPOINT || 'https://api.pinata.cloud/pinning/pinJSONToIPFS';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.IPFS_PIN_TOKEN}` },
    body: JSON.stringify({ pinataContent: manifest }),
  });
  if (!res.ok) throw new Error(`pin failed: HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  const cid = data.IpfsHash || data.cid || data.Hash;
  if (!cid) throw new Error('pin response missing CID');
  return `ipfs://${cid}`;
}

// --- URL builders -----------------------------------------------------------

const humanUrl = (id, reqUrl) => `${reqUrl.origin}/p/${id}`;
const apiUrl = (id, reqUrl) => `${reqUrl.origin}/api/p/${id}`;

function appUrl(id, env, reqUrl) {
  let base = env?.APP_BASE || `${reqUrl.origin}/app/`;
  if (!base.endsWith('/')) base += '/';
  return `${base}?p=${encodeURIComponent(id)}`;
}

function appRedirect(id, env, reqUrl) {
  return new Response(null, {
    status: 302,
    headers: { location: appUrl(id, env, reqUrl), ...corsHeaders(env) },
  });
}

// --- /p/:id — per-talk OG page ------------------------------------------------
// Social crawlers (X / Slack / Discord / LinkedIn / FB) don't run JS and read
// only the HTML served at the shared URL — a bare 302 gives every talk the same
// generic card. So a KNOWN id serves a tiny 200 page carrying the talk's own
// title / description / thumbnail as OG tags plus an instant redirect for
// humans (meta refresh + script + a visible link). Unknown / hidden / expired
// ids keep the plain 302 so the player surfaces its own error.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Best per-talk preview image: absolute poster → YouTube thumb → site card. */
export function ogImageFor(manifest, env, reqUrl) {
  const poster = manifest?.video?.poster;
  if (typeof poster === 'string' && /^https?:\/\//i.test(poster)) return poster;
  const yt = (manifest?.video?.sources || []).find((s) => s?.provider === 'youtube' && s.src);
  if (yt) {
    const s = String(yt.src).trim();
    const m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/) || s.match(/^([\w-]{11})$/);
    if (m) return `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`;   // hqdefault always exists
  }
  // the site's generic card, served next to the player
  let origin = reqUrl.origin;
  try { if (env?.APP_BASE) origin = new URL(env.APP_BASE).origin; } catch { /* keep request origin */ }
  return `${origin}/brand/og-card.png`;
}

async function handleHumanLink(id, env, reqUrl) {
  const rec = await env.P2_KV.get(`doc:${id}`, 'json');
  const gone = !rec || rec.meta?.hidden || (rec.meta?.expires && Date.now() > rec.meta.expires);
  if (gone) return appRedirect(id, env, reqUrl);

  const m = rec.manifest || {};
  const title = m.title || 'A p2present presentation';
  const byline = [m.meta?.author, m.meta?.event, m.meta?.date].filter(Boolean).join(' · ');
  const desc = [byline, m.meta?.description].filter(Boolean).join(' — ')
    || 'Slides in sync with the talk video — scrub to any moment.';
  const img = ogImageFor(m, env, reqUrl);
  const url = humanUrl(id, reqUrl);
  const target = appUrl(id, env, reqUrl);

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)} — p2present</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="video.other">
<meta property="og:site_name" content="p2present">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(img)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img)}">
<meta http-equiv="refresh" content="0;url=${esc(target)}">
<style>body{background:#06070b;color:#98a1af;font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}a{color:#4fd1c5}</style>
</head><body><p>Opening <a href="${esc(target)}">${esc(title)}</a>…</p>
<script>location.replace(${JSON.stringify(target)});</script></body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      ...corsHeaders(env),
    },
  });
}

// --- /api/chapters — YouTube chapter proxy -------------------------------------
// The Builder's "Auto-detect chapters" can't read a YouTube description from a
// static page (CORS), so the Worker fetches the watch page and extracts chapters:
// first the explicit chapter markers (the segmented player bar), then "M:SS
// Title" lines in the description. Results cache in KV for a day; misses count
// against the same per-IP rate limit as writes.

/** Pull an 11-char YouTube id out of a URL or bare id; null when it isn't one. */
export function videoIdFrom(u) {
  const s = String(u || '').trim();
  const m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/) || s.match(/^([\w-]{11})$/);
  return m ? m[1] : null;
}

/** Parse "M:SS Title" / "1:02:03 - Title" lines out of description text. */
export function chaptersFromText(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*[-•([]?\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–—).:\]]?\s+(.+)$/);
    if (m) out.push({ time: m[1], label: m[2].trim() });
  }
  return out.length >= 2 ? out : [];   // a single timestamp is rarely a chapter list
}

const fmtSecs = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
           : `${m}:${String(s).padStart(2, '0')}`;
};

/** Extract chapters from a YouTube watch-page HTML string. */
export function extractChapters(html) {
  // 1) explicit chapter markers (chapterRenderer entries in ytInitialData)
  const chapters = [];
  const rx = /"chapterRenderer":\{"title":\{"simpleText":"((?:[^"\\]|\\.)*)"\},"timeRangeStartMillis":(\d+)/g;
  let m;
  while ((m = rx.exec(html))) {
    let title = m[1];
    try { title = JSON.parse(`"${m[1]}"`); } catch { /* keep raw */ }
    chapters.push({ time: fmtSecs(Math.round(Number(m[2]) / 1000)), label: title });
  }
  if (chapters.length >= 2) return chapters;
  // 2) fall back to timestamp lines in the description
  const d = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
  if (d) { try { return chaptersFromText(JSON.parse(`"${d[1]}"`)); } catch { /* fall through */ } }
  return [];
}

async function handleChapters(env, ip, reqUrl) {
  const u = reqUrl.searchParams.get('u') || reqUrl.searchParams.get('v') || '';
  const vid = videoIdFrom(u);
  if (!vid) return json({ error: 'invalid_video', detail: 'pass a YouTube URL or 11-char id as ?u=' }, 400, env);

  const cacheKey = `chapters:${vid}`;
  const cached = await env.P2_KV.get(cacheKey, 'json');
  if (cached) return json({ videoId: vid, chapters: cached, cached: true }, 200, env);

  if (!(await allowWrite(env, ip))) return json({ error: 'rate_limited' }, 429, env);

  let html;
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${vid}&hl=en`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'accept-language': 'en',
      },
    });
    if (!res.ok) return json({ error: 'upstream', detail: `YouTube answered HTTP ${res.status}` }, 502, env);
    html = await res.text();
  } catch (err) {
    return json({ error: 'upstream', detail: String(err?.message || err) }, 502, env);
  }

  const chapters = extractChapters(html);
  if (chapters.length) await env.P2_KV.put(cacheKey, JSON.stringify(chapters), { expirationTtl: 86400 });
  return json({ videoId: vid, chapters }, 200, env);
}

// KV put options that preserve a record's remaining TTL on update.
function ttlOpts(rec) {
  if (!rec.meta?.expires) return {};
  const remaining = Math.floor((rec.meta.expires - Date.now()) / 1000);
  return remaining > 60 ? { expirationTtl: remaining } : {};
}

function bearer(request) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : (request.headers.get('x-edit-token') || '').trim() || null;
}

// --- handlers ---------------------------------------------------------------

export async function handleCreate(request, env, ctx, ip, reqUrl) {
  if (!(await allowWrite(env, ip))) return json({ error: 'rate_limited' }, 429, env);

  const max = cfg(env, 'MAX_BYTES');
  const text = await request.text();
  if (text.length > max) return json({ error: 'too_large', max }, 413, env);

  let manifest;
  try { manifest = JSON.parse(text); } catch { return json({ error: 'invalid_json' }, 400, env); }
  const v = validateManifest(manifest);
  if (!v.ok) return json({ error: 'invalid_manifest', detail: v.error }, 400, env);

  const visibility = (reqUrl.searchParams.get('visibility') || 'unlisted').toLowerCase() === 'public'
    ? 'public' : 'unlisted';
  const ttl = clampTtl(reqUrl.searchParams.get('ttl') ?? reqUrl.searchParams.get('expiry'), env);

  const id = randId(8);
  const editToken = randId(40);
  const tokenHash = await sha256hex(editToken);
  const now = Date.now();
  const rec = {
    manifest,
    meta: { id, created: now, updated: now, visibility, tokenHash, reports: 0, expires: ttl ? now + ttl * 1000 : null },
  };

  if (ipfsEnabled(env)) {
    try { rec.meta.ipfs = await pinToIpfs(env, manifest); }
    catch (e) { rec.meta.ipfsError = String(e?.message || e); }
  }

  const opts = ttl ? { expirationTtl: ttl } : {};
  await env.P2_KV.put(`doc:${id}`, JSON.stringify(rec), opts);
  if (visibility === 'public') await env.P2_KV.put(`pub:${id}`, String(now), opts);

  return json({
    id, editToken, visibility,
    url: humanUrl(id, reqUrl),
    manifestUrl: apiUrl(id, reqUrl),
    ipfs: rec.meta.ipfs || null,
    ipfsError: rec.meta.ipfsError,
    expires: rec.meta.expires,
  }, 200, env);
}

export async function handleGet(id, env) {
  const rec = await env.P2_KV.get(`doc:${id}`, 'json');
  if (!rec) return json({ error: 'not_found' }, 404, env);
  if (rec.meta?.hidden) return json({ error: 'unavailable', reason: 'reported' }, 451, env);
  if (rec.meta?.expires && Date.now() > rec.meta.expires) return json({ error: 'expired' }, 410, env);
  return json(rec.manifest, 200, env, { 'cache-control': 'public, max-age=60' });
}

export async function handleUpdate(request, id, env, reqUrl) {
  const rec = await env.P2_KV.get(`doc:${id}`, 'json');
  if (!rec) return json({ error: 'not_found' }, 404, env);

  const token = bearer(request);
  if (!token || (await sha256hex(token)) !== rec.meta.tokenHash) {
    return json({ error: 'forbidden' }, 403, env);
  }

  const max = cfg(env, 'MAX_BYTES');
  const text = await request.text();
  if (text.length > max) return json({ error: 'too_large', max }, 413, env);

  let manifest;
  try { manifest = JSON.parse(text); } catch { return json({ error: 'invalid_json' }, 400, env); }
  const v = validateManifest(manifest);
  if (!v.ok) return json({ error: 'invalid_manifest', detail: v.error }, 400, env);

  // visibility may be toggled on update via ?visibility=
  const reqVis = (reqUrl.searchParams.get('visibility') || '').toLowerCase();
  if (reqVis === 'public' || reqVis === 'unlisted') rec.meta.visibility = reqVis;

  rec.manifest = manifest;
  rec.meta.updated = Date.now();
  if (ipfsEnabled(env)) {
    try { rec.meta.ipfs = await pinToIpfs(env, manifest); }
    catch (e) { rec.meta.ipfsError = String(e?.message || e); }
  }

  const opts = ttlOpts(rec);
  await env.P2_KV.put(`doc:${id}`, JSON.stringify(rec), opts);
  if (rec.meta.visibility === 'public') await env.P2_KV.put(`pub:${id}`, String(rec.meta.created), opts);
  else await env.P2_KV.delete(`pub:${id}`);

  return json({ id, updated: rec.meta.updated, visibility: rec.meta.visibility, ipfs: rec.meta.ipfs || null }, 200, env);
}

export async function handleDelete(request, id, env) {
  const rec = await env.P2_KV.get(`doc:${id}`, 'json');
  if (!rec) return json({ error: 'not_found' }, 404, env);
  const token = bearer(request);
  if (!token || (await sha256hex(token)) !== rec.meta.tokenHash) {
    return json({ error: 'forbidden' }, 403, env);
  }
  await env.P2_KV.delete(`doc:${id}`);
  await env.P2_KV.delete(`pub:${id}`);
  return json({ id, deleted: true }, 200, env);
}

export async function handleReport(request, env, ip) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400, env); }
  const id = String(body?.id || '').trim();
  if (!id) return json({ error: 'id_required' }, 400, env);
  const reason = String(body?.reason || '').slice(0, 500);

  const rec = await env.P2_KV.get(`doc:${id}`, 'json');
  if (!rec) return json({ error: 'not_found' }, 404, env);

  const now = Date.now();
  await env.P2_KV.put(`report:${id}:${now}`, JSON.stringify({ reason, ip, ts: now }), { expirationTtl: 30 * 24 * 3600 });
  rec.meta.reports = (rec.meta.reports || 0) + 1;
  if (rec.meta.reports >= cfg(env, 'REPORT_HIDE_THRESHOLD')) {
    rec.meta.hidden = true;
    await env.P2_KV.delete(`pub:${id}`);
  }
  await env.P2_KV.put(`doc:${id}`, JSON.stringify(rec), ttlOpts(rec));
  return json({ ok: true, reports: rec.meta.reports, hidden: !!rec.meta.hidden }, 200, env);
}

export async function handleRecent(env) {
  const limit = cfg(env, 'RECENT_LIMIT');
  const { keys } = await env.P2_KV.list({ prefix: 'pub:', limit });
  const ids = keys.map((k) => k.name.slice('pub:'.length));
  return json({ ids, count: ids.length }, 200, env);
}

// --- router -----------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    try {
      if (!env || !env.P2_KV) return json({ error: 'misconfigured', detail: 'KV binding P2_KV missing' }, 500, env);

      // GET / → info
      if (pathname === '/' && request.method === 'GET') {
        return json({ service: 'p2present pastebin-lite', ok: true, ipfsMirror: ipfsEnabled(env) }, 200, env);
      }

      // POST /api/p — create
      if ((pathname === '/api/p' || pathname === '/api/p/') && request.method === 'POST') {
        return await handleCreate(request, env, ctx, ip, url);
      }

      // POST /api/report — report
      if (pathname === '/api/report' && request.method === 'POST') {
        return await handleReport(request, env, ip);
      }

      // GET /api/recent — public listing
      if (pathname === '/api/recent' && request.method === 'GET') {
        return await handleRecent(env);
      }

      // /api/p/:id — get / update / delete
      const apiMatch = /^\/api\/p\/([\w.-]+)$/.exec(pathname);
      if (apiMatch) {
        const id = apiMatch[1];
        if (request.method === 'GET') return await handleGet(id, env);
        if (request.method === 'PUT') return await handleUpdate(request, id, env, url);
        if (request.method === 'DELETE') return await handleDelete(request, id, env);
        return json({ error: 'method_not_allowed' }, 405, env);
      }

      // GET /api/chapters?u=<youtube url|id> — chapter proxy for the Builder
      if (pathname === '/api/chapters' && request.method === 'GET') {
        return await handleChapters(env, ip, url);
      }

      // /p/:id — human link → per-talk OG page (302 fallback for unknown ids)
      const humanMatch = /^\/p\/([\w.-]+)\/?$/.exec(pathname);
      if (humanMatch && request.method === 'GET') {
        return await handleHumanLink(humanMatch[1], env, url);
      }

      return json({ error: 'not_found' }, 404, env);
    } catch (err) {
      return json({ error: 'server_error', detail: String(err?.message || err) }, 500, env);
    }
  },
};
