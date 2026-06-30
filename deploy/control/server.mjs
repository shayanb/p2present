// deploy/control/server.mjs — the control API the p2present payments Worker calls.
//
// Reference implementation (zero npm deps; Node ≥ 20 built-ins only). Two
// audiences:
//   • the browser STAGES the file here before/at checkout:
//       POST /stage/<jobId>      raw body = file bytes        (unguessable jobId)
//   • the payments Worker's webhook ENQUEUES persistence after payment:
//       POST /jobs               Bearer CONTROL_TOKEN, { jobId, provider, bytes, name }
//     → reads the staged file, persists via the chosen backend, returns
//       { status, ref, scheme } (ar:// / ipfs:// / magnet:).
//   • the host page POLLS the Worker (which mirrors this) — and this also serves:
//       GET  /jobs/<jobId>       → { status, ref, scheme }
//       GET  /healthz
//
// Backends: `pinning` → kubo (`ipfs add` + pin); `seedbox` → the seed service
// (WebTorrent). `arweave`/`s3` require external credentials and return a clear
// `pending` unless their endpoint is configured. See deploy/README.md.
//
// SECURITY: /jobs requires CONTROL_TOKEN (a wrangler secret on the Worker side).
// /stage is intentionally token-less so a static browser can reach it — it is
// guarded by the unguessable jobId + a size cap; harden with a Worker-minted
// stage token or an allow-list at the proxy if you expose it widely (README).

import http from 'node:http';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const PORT = Number(process.env.CONTROL_PORT || 8090);
const TOKEN = process.env.CONTROL_TOKEN || '';
const IPFS_API_URL = (process.env.IPFS_API_URL || 'http://ipfs:5001').replace(/\/$/, '');
const SEED_API_URL = (process.env.SEED_API_URL || 'http://seed:8091').replace(/\/$/, '');
const IPFS_GATEWAY = (process.env.IPFS_GATEWAY_PUBLIC || 'https://ipfs.io').replace(/\/$/, '');
const ARWEAVE_BUNDLER_URL = process.env.ARWEAVE_BUNDLER_URL || '';
const ARWEAVE_BUNDLER_TOKEN = process.env.ARWEAVE_BUNDLER_TOKEN || '';
const STAGING_DIR = process.env.STAGING_DIR || '/staging';
const DATA_DIR = process.env.DATA_DIR || '/data';
const MAX_BYTES = Number(process.env.MAX_BYTES || 2 * 1024 * 1024 * 1024); // 2 GiB

const SCHEME = { arweave: 'ar', pinning: 'ipfs', seedbox: 'magnet', s3: 'https' };

// --- tiny helpers -----------------------------------------------------------

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
const jobPath = (id) => path.join(DATA_DIR, `${id.replace(/[^\w.-]/g, '')}.json`);
const stagePath = (id) => path.join(STAGING_DIR, id.replace(/[^\w.-]/g, ''));

async function readJob(id) {
  try { return JSON.parse(await readFile(jobPath(id), 'utf8')); } catch { return null; }
}
async function writeJob(job) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(jobPath(job.jobId), JSON.stringify(job));
}
function authed(req) {
  if (!TOKEN) return true; // no token configured → open (dev only; README warns)
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return !!m && m[1].trim() === TOKEN;
}

// --- staging: receive the file bytes ----------------------------------------

async function handleStage(req, res, jobId) {
  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_BYTES) return send(res, 413, { error: 'too_large', max: MAX_BYTES });
  await mkdir(STAGING_DIR, { recursive: true });
  const dest = stagePath(jobId);
  let received = 0;
  req.on('data', (c) => { received += c.length; if (received > MAX_BYTES) req.destroy(); });
  try {
    await pipeline(req, createWriteStream(dest));
  } catch {
    return send(res, 413, { error: 'too_large_or_aborted', max: MAX_BYTES });
  }
  const name = decodeURIComponent(String(req.headers['x-file-name'] || 'asset'));
  await writeFile(`${dest}.meta`, JSON.stringify({ name, bytes: received }));
  return send(res, 200, { staged: true, jobId, bytes: received });
}

// --- persistence backends ---------------------------------------------------

async function persistIpfs(buf, name) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), name);
  const res = await fetch(`${IPFS_API_URL}/api/v0/add?pin=true&cid-version=1&quieter=true`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`ipfs add HTTP ${res.status}`);
  // kubo streams ndjson; the final line carries the root CID.
  const lines = (await res.text()).trim().split('\n').filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  const cid = last.Hash || last.Cid?.['/'];
  if (!cid) throw new Error('ipfs add returned no CID');
  return { ref: `ipfs://${cid}`, scheme: 'ipfs', gateway: `${IPFS_GATEWAY}/ipfs/${cid}` };
}

async function persistSeed(jobId, name) {
  // The seed service reads the staged file from the shared volume by jobId.
  const res = await fetch(`${SEED_API_URL}/seed`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId, name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.magnet) throw new Error(`seed failed: HTTP ${res.status} ${data.error || ''}`);
  return { ref: data.magnet, scheme: 'magnet' };
}

async function persistArweave(buf, name, type) {
  if (!ARWEAVE_BUNDLER_URL) {
    const e = new Error('arweave bundler not configured (set ARWEAVE_BUNDLER_URL/TOKEN)');
    e.pending = true; throw e;
  }
  const headers = { 'content-type': type || 'application/octet-stream' };
  if (ARWEAVE_BUNDLER_TOKEN) headers.authorization = `Bearer ${ARWEAVE_BUNDLER_TOKEN}`;
  const res = await fetch(ARWEAVE_BUNDLER_URL, { method: 'POST', headers, body: buf });
  if (!res.ok) throw new Error(`arweave upload HTTP ${res.status}`);
  const j = await res.json().catch(() => ({}));
  const txid = j.id || j.txid || j.transaction;
  if (!txid) throw new Error('arweave upload returned no tx id');
  return { ref: `ar://${txid}`, scheme: 'ar', gateway: `https://arweave.net/${txid}` };
}

async function persist(provider, jobId, name) {
  if (provider === 'seedbox') return persistSeed(jobId, name);
  const buf = await readFile(stagePath(jobId)); // staged bytes
  if (provider === 'pinning') return persistIpfs(buf, name);
  if (provider === 'arweave') return persistArweave(buf, name);
  if (provider === 's3') { const e = new Error('s3 backend not configured on this host'); e.pending = true; throw e; }
  throw new Error(`unknown provider: ${provider}`);
}

// --- enqueue: the Worker webhook calls this after payment -------------------

async function handleEnqueue(req, res, body) {
  let payload;
  try { payload = JSON.parse(body); } catch { return send(res, 400, { error: 'invalid_json' }); }
  const jobId = String(payload?.jobId || '').trim();
  const provider = String(payload?.provider || '').trim();
  if (!jobId || !SCHEME[provider]) return send(res, 400, { error: 'jobId + valid provider required' });

  // Idempotent: a job already persisted just echoes its ref.
  const existing = await readJob(jobId);
  if (existing && existing.status === 'persisted') return send(res, 200, existing);

  // Seedbox seeds from the shared volume; others need a staged file present.
  if (provider !== 'seedbox') {
    try { await stat(stagePath(jobId)); }
    catch { return send(res, 409, { error: 'not_staged', detail: 'POST /stage/<jobId> the bytes first' }); }
  }

  const name = String(payload?.name || 'asset');
  const job = { jobId, provider, name, status: 'persisting', created: Date.now() };
  await writeJob(job);
  try {
    const out = await persist(provider, jobId, name);
    Object.assign(job, { status: 'persisted', ...out, updated: Date.now() });
    await writeJob(job);
    return send(res, 200, job);
  } catch (err) {
    job.status = err.pending ? 'pending_backend' : 'error';
    job.note = String(err?.message || err);
    job.updated = Date.now();
    await writeJob(job);
    return send(res, err.pending ? 202 : 500, job);
  }
}

// --- router -----------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/healthz') return send(res, 200, { ok: true });

  const stageM = /^\/stage\/([\w.-]+)$/.exec(pathname);
  if (req.method === 'POST' && stageM) return void handleStage(req, res, stageM[1]);

  if (req.method === 'POST' && pathname === '/jobs') {
    if (!authed(req)) return send(res, 403, { error: 'forbidden' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', () => handleEnqueue(req, res, body));
    return;
  }

  const jobM = /^\/jobs\/([\w.-]+)$/.exec(pathname);
  if (req.method === 'GET' && jobM) {
    return void readJob(jobM[1]).then((job) => job ? send(res, 200, job) : send(res, 404, { error: 'not_found' }));
  }

  send(res, 404, { error: 'not_found' });
});

server.listen(PORT, () => console.log(`[control] listening on :${PORT}`));
