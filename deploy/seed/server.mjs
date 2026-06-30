// deploy/seed/server.mjs — always-on WebTorrent seeder.
//
// The control API calls POST /seed { jobId, name }: this reads the file the
// browser staged at /staging/<jobId>, copies it into the persistent /seed volume
// (so it survives restarts), seeds it with the SAME wss:// WebRTC trackers the
// in-browser player uses, and returns the magnet: URI. On boot it re-seeds every
// file already in /seed so magnets keep resolving across restarts.
//
//   POST /seed     { jobId, name }  → { magnet, infoHash }
//   GET  /healthz                   → { ok, seeding }
//
// Reference implementation — not load-tested. See deploy/README.md for ports
// (WebRTC peers connect via the trackers; 6881 is for classic BitTorrent peers).

import http from 'node:http';
import { readdir, mkdir, copyFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import WebTorrent from 'webtorrent';

const PORT = Number(process.env.SEED_PORT || 8091);
const STAGING_DIR = process.env.STAGING_DIR || '/staging';
const SEED_DIR = process.env.SEED_DIR || '/seed';
const TRACKERS = String(process.env.TRACKERS || 'wss://tracker.openwebtorrent.com,wss://tracker.webtorrent.dev')
  .split(',').map((s) => s.trim()).filter(Boolean);

const client = new WebTorrent();
const byJob = new Map(); // jobId → magnet

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function seedPath(p, name) {
  return new Promise((resolve, reject) => {
    client.seed(p, { announce: TRACKERS, name }, (torrent) => resolve(torrent));
    client.once('error', reject);
  });
}

async function handleSeed(jobId, name) {
  if (byJob.has(jobId)) return { magnet: byJob.get(jobId), infoHash: null, cached: true };

  const safe = jobId.replace(/[^\w.-]/g, '');
  const dir = path.join(SEED_DIR, safe);
  await mkdir(dir, { recursive: true });
  const fileName = (name || 'asset').replace(/[^\w.\- ]/g, '_');
  const dest = path.join(dir, fileName);
  // Copy the staged bytes into the persistent seed volume.
  await copyFile(path.join(STAGING_DIR, safe), dest);

  const torrent = await seedPath(dest, fileName);
  byJob.set(jobId, torrent.magnetURI);
  return { magnet: torrent.magnetURI, infoHash: torrent.infoHash };
}

// Re-seed everything already persisted so magnets survive a restart.
async function reseedOnBoot() {
  let entries = [];
  try { entries = await readdir(SEED_DIR); } catch { return; }
  for (const jobId of entries) {
    const dir = path.join(SEED_DIR, jobId);
    try {
      if (!(await stat(dir)).isDirectory()) continue;
      const files = await readdir(dir);
      if (!files.length) continue;
      const torrent = await seedPath(path.join(dir, files[0]), files[0]);
      byJob.set(jobId, torrent.magnetURI);
      console.log(`[seed] re-seeding ${jobId} → ${torrent.infoHash}`);
    } catch (e) { console.warn(`[seed] re-seed ${jobId} failed: ${e.message}`); }
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/healthz') {
    return send(res, 200, { ok: true, seeding: client.torrents.length });
  }
  if (req.method === 'POST' && url.pathname === '/seed') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 100_000) req.destroy(); });
    req.on('end', async () => {
      let p; try { p = JSON.parse(body); } catch { return send(res, 400, { error: 'invalid_json' }); }
      if (!p?.jobId) return send(res, 400, { error: 'jobId required' });
      try { send(res, 200, await handleSeed(String(p.jobId), p.name)); }
      catch (e) { send(res, 500, { error: String(e?.message || e) }); }
    });
    return;
  }
  send(res, 404, { error: 'not_found' });
});

await reseedOnBoot();
server.listen(PORT, () => console.log(`[seed] listening on :${PORT}; trackers: ${TRACKERS.join(', ')}`));
