// scripts/smoke.mjs — headless Chrome smoke test + per-protocol screenshots.
//
// Serves ./docs over a local static server (plus a few in-memory /__fixtures__/
// manifests so we can exercise provider fallback / p2p routing without shipping
// test files to Pages), drives it with Playwright (cached Chromium), and checks:
//   - the landing page (/) renders hero + how-it-works + features + roadmap; the
//     "Load the MoaV demo" CTA deep-links into /app/; legacy ?demo/?p redirect to /app/
//   - the demo player mounts (now at /app/); app assets return 200; no console errors
//   - resolver routing: ?manifest= / ?p= / ?src=<base64 url> / ?src=<base64 inline>
//   - p2p routing: ipfs:// and magnet: sources reach a real loading/fallback state
//     (NOT the old "coming soon" stub)
//   - provider source-fallback: ipfs(dead) → mp4(local) yields a working <video>
//   - fullscreen auto-hide overlay controls (immersive class + fixed overlay)
//   - layout modes switch; subtitle CC menu present
//   - timeline seek (mp4): scrubber seeks the VIDEO + jumps the slide together in
//     paused AND playing states; YouTube cold-seek advances getCurrentTime (best-effort)
//   - PDF demo (?p=moav-pdf): pdf.js deck renders slide 1 visibly + syncs; every
//     slide stays non-blank sweeping forward AND backward (luminance regression)
//   - scrubber thumbnail preview (PDF page render) appears on hover
//   - deep-link hash (#t=…&slide=…) opens at the right time/slide
//   - builder (/builder/): mounts, flags invalid, validates the demo, exports
//   - host helper (/host/): pluggable persistence providers — picker has all 4,
//     Arweave default + "Make permanent" payment-stub note, IPFS pin (Pinata
//     mocked) → ipfs:// ref + builder handoff, seedbox trackers prefilled
//   - responsive widths 390 / 780 / 1280 (player + builder + host)
// and saves screenshots to docs/screenshots/.
//
// Run: npm run smoke   (node scripts/smoke.mjs)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { signEip191WithKey } from '../docs/src/sign.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const SHOTS = path.join(DOCS, 'screenshots');
const PORT = 5179;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.vtt': 'text/vtt',
  '.srt': 'application/x-subrip', '.md': 'text/markdown',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

// In-memory fixtures (kept out of the committed site). A dead IPFS gateway on a
// closed port makes the ipfs source fail fast so fallback is quick + offline.
const DEAD = ['http://127.0.0.1:1/{cid}'];
const FIXTURES = {
  // ipfs(dead) video → mp4(local) fallback; local html deck.
  'fallback.json': {
    p2present: '1.0', title: 'Fallback Fixture',
    video: {
      sources: [
        { provider: 'ipfs', src: 'ipfs://bafkreideadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef/x.mp4' },
        { provider: 'mp4', src: `${ORIGIN}/content/demo/slides/assets/nedagram-demo.mp4` },
      ],
    },
    deck: { type: 'html', sources: [{ src: `${ORIGIN}/content/demo/slides/index.html` }], slideCount: 23 },
    timing: [{ time: 0, slide: 1 }, { time: 2, slide: 2 }],
    subtitles: [{ lang: 'en', label: 'English', src: `${ORIGIN}/content/demo/subtitles/sample-en.vtt`, default: true }],
    resolvers: { ipfsGateways: DEAD },
    layout: { split: 0.6, mode: 'split' },
  },
  // The manifest the mock pastebin service returns for GET /api/p/smoke01 — a
  // tiny self-contained deck pointing at local assets so the service-load path
  // mounts a real player offline.
  'service-doc': {
    p2present: '1.0', title: 'Smoke Service Deck',
    video: { sources: [{ provider: 'mp4', src: `${ORIGIN}/content/demo/slides/assets/nedagram-demo.mp4` }] },
    deck: { type: 'html', sources: [{ src: `${ORIGIN}/content/demo/slides/index.html` }], slideCount: 23 },
    timing: [{ time: 0, slide: 1 }],
  },
  // A local-mp4 deck with several timing cues spread across the 63s clip, so a
  // timeline seek can be asserted to move the VIDEO + jump to a distinct slide
  // (deterministic + offline; the YouTube path is checked best-effort separately).
  'seek.json': {
    p2present: '1.0', title: 'Seek Fixture',
    video: { sources: [{ provider: 'mp4', src: `${ORIGIN}/content/demo/slides/assets/nedagram-demo.mp4` }] },
    deck: { type: 'html', sources: [{ src: `${ORIGIN}/content/demo/slides/index.html` }], slideCount: 23 },
    timing: [
      { time: 0, slide: 1 }, { time: 10, slide: 2 }, { time: 20, slide: 3 },
      { time: 30, slide: 4 }, { time: 45, slide: 5 }, { time: 55, slide: 6 },
    ],
    layout: { split: 0.6, mode: 'split' },
  },
};

// Signed fixtures (Phase 8): a self-contained local-asset deck signed with the
// web3.js test key, plus a tampered copy. Built at runtime so the canonical bytes
// match exactly what gets served. Address for this key: 0x2c7536…65c23.
const SIGN_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const SIGNED_ADDR = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const signedBase = {
  p2present: '1.0', title: 'Signed Deck',
  video: { sources: [{ provider: 'mp4', src: `${ORIGIN}/content/demo/slides/assets/nedagram-demo.mp4` }] },
  deck: { type: 'html', sources: [{ src: `${ORIGIN}/content/demo/slides/index.html` }], slideCount: 23 },
  timing: [{ time: 0, slide: 1 }],
};
FIXTURES['signed.json'] = signEip191WithKey(signedBase, SIGN_KEY);
FIXTURES['tampered.json'] = (() => {
  const t = JSON.parse(JSON.stringify(FIXTURES['signed.json']));
  t.title = 'Tampered Deck';   // changed AFTER signing → must fail verification
  return t;
})();

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      // --- mock pastebin-lite service (the app's service base points here) ---
      if (url === '/api/p' && req.method === 'POST') {
        // Accept the POSTed manifest (drained) and return a fixed short id.
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          res.end(JSON.stringify({ id: 'smoke01', editToken: 'tok_smoke_0000', visibility: 'unlisted', url: `${ORIGIN}/p/smoke01`, manifestUrl: `${ORIGIN}/api/p/smoke01`, ipfs: null, expires: null }));
        });
        return;
      }
      const apiGet = url.match(/^\/api\/p\/([\w.-]+)$/);
      if (apiGet && req.method === 'GET') {
        res.writeHead(apiGet[1] === 'smoke01' ? 200 : 404, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(apiGet[1] === 'smoke01' ? JSON.stringify(FIXTURES['service-doc']) : JSON.stringify({ error: 'not_found' }));
        return;
      }
      if (url.startsWith('/__fixtures__/')) {
        const name = url.slice('/__fixtures__/'.length);
        const fx = FIXTURES[name];
        if (!fx) { res.writeHead(404).end('no fixture'); return; }
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify(fx));
        return;
      }
      let file = path.join(DOCS, url === '/' ? 'index.html' : url);
      if (!file.startsWith(DOCS)) { res.writeHead(403).end('no'); return; }
      fs.stat(file, (err, st) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        if (st.isDirectory()) file = path.join(file, 'index.html');
        fs.stat(file, (e0, st2) => {
          if (e0) { res.writeHead(404).end('not found'); return; }
          const type = MIME[path.extname(file)] || 'application/octet-stream';
          const base = { 'content-type': type, 'access-control-allow-origin': '*', 'accept-ranges': 'bytes' };
          // Honour HTTP Range so <video> can SEEK to unbuffered positions (without
          // a 206 the browser refuses to move currentTime past what's buffered —
          // which is exactly what the timeline-seek check exercises).
          const range = req.headers.range;
          const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
          if (m) {
            const size = st2.size;
            let start = m[1] ? parseInt(m[1], 10) : 0;
            let end = m[2] ? parseInt(m[2], 10) : size - 1;
            if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) {
              res.writeHead(416, { ...base, 'content-range': `bytes */${size}` }).end();
              return;
            }
            res.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
            fs.createReadStream(file, { start, end }).pipe(res);
            return;
          }
          res.writeHead(200, { ...base, 'content-length': st2.size });
          fs.createReadStream(file).pipe(res);
        });
      });
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

// --- assertion bookkeeping --------------------------------------------------
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };

const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');

async function newPage(context) {
  const page = await context.newPage();
  page._consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const u = msg.location()?.url || '';
    // Only count SAME-ORIGIN (app) errors; external (youtube/gateway) noise ignored.
    if (u.startsWith(ORIGIN) || u === '') page._consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => page._consoleErrors.push('pageerror: ' + err.message));
  return page;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  // Prefer the installed system Chrome (channel) so we don't depend on a
  // version-matched Playwright browser download; fall back to bundled Chromium.
  let browser;
  try { browser = await chromium.launch({ channel: 'chrome' }); }
  catch { browser = await chromium.launch(); }
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Point the app's "Save & share" + service-id loader at our mock service above
  // (instead of the production default) for every page in this run.
  // Point "Save & share"/service loads at our mock backend, and disable ENS
  // reverse-resolution (no public-RPC calls during the offline smoke run).
  await context.addInitScript(() => { window.__P2_SERVICE_BASE = location.origin; window.__P2_ENS = false; });

  try {
    // === 0. Landing page (/) — cinematic redesign: hero, scroll-morph showcase,
    //        sources, kept-alive teaser, demo picker, redirect, responsive ===
    {
      const p = await newPage(context);
      const homeAssets = {};
      p.on('response', (r) => { const u = r.url(); if (u.startsWith(ORIGIN)) homeAssets[u.replace(ORIGIN, '')] = r.status(); });
      await p.goto(`${ORIGIN}/`, { waitUntil: 'load' });
      ok('home: hero renders the brand name', /p2present/i.test(await p.textContent('.brand')));
      const h1 = await p.textContent('.hero h1');
      const tagline = await p.textContent('.hero .tagline');
      ok('home: one-liner present', /play themselves/i.test(h1) && /sync/i.test(tagline) && /scrub/i.test(tagline), `${h1.trim()} | ${tagline.replace(/\s+/g, ' ').trim()}`);
      // the near-wordless 3-beat replaces the old deck+JSON+link explainer
      ok('home: bring→sync→share beats present', (await p.$$('.hero .beats .beat')).length === 3);
      const cta = await p.getAttribute('.hero .btn-primary', 'href');
      ok('home: CTA deep-links into the player demo', /^app\/\?p=moav-pdf$/.test(cta || ''), String(cta));
      // landing page must never surface manifest/JSON/git mechanics (those live in /docs)
      const bodyText = (await p.textContent('main')) || '';
      ok('home: no JSON/manifest/git mechanics surfaced', !/\bJSON\b|\bmanifest\b|git clone|npm run/i.test(bodyText), bodyText.match(/\bJSON\b|\bmanifest\b|git clone|npm run/i)?.[0] || 'clean');

      // --- the scroll-morph centerpiece ---
      ok('home: scroll-morph mock present', await p.$('.morph[data-step]'));
      ok('home: showcase morphs through 4 layout modes', (await p.$$('.morph-cap')).length === 4, String((await p.$$('.morph-cap')).length));
      // walk the pinned track and confirm the mock morphs split(0) → PiP(3).
      // (Smooth-scroll lags a single jump, so step through and collect states.)
      const stepStart = await p.getAttribute('.morph', 'data-step');
      const seen = new Set([stepStart]);
      // Sample finely — smooth-scroll trails large jumps, so step in small
      // increments (and let it settle) to pass through every layout band.
      for (let f = 0; f <= 1.0001; f += 0.05) {
        await p.evaluate((frac) => { const s = document.getElementById('showcase'); window.scrollTo(0, s.offsetTop + (s.offsetHeight - window.innerHeight) * frac); }, f);
        await p.waitForTimeout(160);
        seen.add(await p.getAttribute('.morph', 'data-step'));
      }
      // overshoot past the pin end and let smooth-scroll settle so the final mode (PiP) registers
      await p.evaluate(() => { const s = document.getElementById('showcase'); window.scrollTo(0, s.offsetTop + s.offsetHeight); });
      await p.waitForTimeout(600);
      seen.add(await p.getAttribute('.morph', 'data-step'));
      ok('home: morph advances through all 4 modes on scroll', stepStart === '0' && ['0', '1', '2', '3'].every((s) => seen.has(s)), [...seen].sort().join('→'));
      await p.evaluate(() => window.scrollTo(0, 0));
      await p.waitForTimeout(200);

      // --- the source constellation (climax of the morph journey) ---
      ok('home: source constellation lists 5 source nodes', (await p.$$('#sources .src-node')).length === 5, String((await p.$$('#sources .src-node')).length));
      ok('home: source streams + nodes are SVG/graphic, not a card grid', await p.$('#sources .streams path'));
      // scrolling to the end of the showcase ignites the source-streaming phase
      await p.evaluate(() => { const s = document.getElementById('showcase'); window.scrollTo(0, s.offsetTop + s.offsetHeight); });
      await p.waitForTimeout(600);
      ok('home: morph journey flows into the source-streaming climax', await p.evaluate(() => document.querySelector('.showcase-sticky')?.classList.contains('sourcing') === true));
      await p.evaluate(() => window.scrollTo(0, 0));
      await p.waitForTimeout(200);

      // --- kept-alive teaser ---
      ok('home: kept-alive teaser links the ROADMAP', (await p.$$('#alive a[href*="ROADMAP.md"]')).length >= 1);
      ok('home: roadmap framing (coming / roadmap pills)', await p.evaluate(() => {
        const t = [...document.querySelectorAll('#alive .pill .t')].map((e) => e.textContent.trim().toLowerCase());
        return t.filter((x) => x === 'coming').length === 2 && t.includes('roadmap');
      }));

      // --- the demo picker (gallery, opens on the CTA) ---
      ok('home: demo picker dialog + gallery present', await p.evaluate(() => {
        const d = document.getElementById('demo-picker');
        const cards = document.querySelectorAll('#demo-list .demo-card');
        const loadable = [...cards].some((c) => (c.getAttribute('href') || '') === 'app/?p=moav-pdf');
        return !!d && cards.length >= 1 && loadable;
      }));
      await p.click('.hero .btn-primary');
      await p.waitForTimeout(250);
      const pickerOpen = await p.evaluate(() => document.getElementById('demo-picker')?.open === true);
      ok('home: CTA opens the demo picker', pickerOpen);
      await p.keyboard.press('Escape').catch(() => {});
      await p.waitForTimeout(150);

      ok('home: nav links Docs + repo + builder', (await p.$$('a[href="docs/"]')).length >= 1 && (await p.$$('a[href*="github.com/shayanb/p2present"]')).length >= 1 && (await p.$$('a[href="builder/"]')).length >= 1);
      const og = await p.evaluate(() => ({
        title: document.querySelector('meta[property="og:title"]')?.content || '',
        image: document.querySelector('meta[property="og:image"]')?.content || '',
        desc: document.querySelector('meta[name="description"]')?.content || '',
      }));
      ok('home: OG/meta tags present', /p2present/i.test(og.title) && /\.png$/.test(og.image) && og.desc.length > 20, JSON.stringify(og).slice(0, 80));
      ok('home: favicon link present', await p.$('link[rel="icon"]'));
      ok('home: home.css 200', homeAssets['/home.css'] === 200, String(homeAssets['/home.css']));
      ok('home: home.js 200', homeAssets['/home.js'] === 200, String(homeAssets['/home.js']));
      ok('home: vendored Lenis 200', homeAssets['/vendor/lenis.min.js'] === 200, String(homeAssets['/vendor/lenis.min.js']));
      for (const w of [1280, 780, 390]) {
        await p.setViewportSize({ width: w, height: w === 390 ? 800 : 860 });
        await p.waitForTimeout(200);
        // walk the page so reveal-on-scroll + morph settle before the shot
        await p.evaluate(async () => {
          const h = document.body.scrollHeight;
          for (let y = 0; y <= h; y += Math.floor(window.innerHeight * 0.6)) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 30)); }
          window.scrollTo(0, 0);
        });
        await p.waitForTimeout(250);
        await p.screenshot({ path: path.join(SHOTS, `home-${w}.png`), fullPage: true });
      }
      const noHScroll = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
      ok('home: no horizontal overflow at 390px', noHScroll);
      ok('home: no same-origin console errors', p._consoleErrors.length === 0, p._consoleErrors.slice(0, 2).join(' | '));
      await p.close();
    }

    // === 0a. Docs hub (/docs/) — the moved-out tech depth ===
    {
      const p = await newPage(context);
      const a = {};
      p.on('response', (r) => { const u = r.url(); if (u.startsWith(ORIGIN)) a[u.replace(ORIGIN, '')] = r.status(); });
      await p.goto(`${ORIGIN}/docs/`, { waitUntil: 'load' });
      ok('docs: hub renders', /spec|format|tooling/i.test(await p.textContent('.docs-hero h1')));
      ok('docs: has doc cards', (await p.$$('.doc-card')).length >= 6, String((await p.$$('.doc-card')).length));
      ok('docs: links SPEC + AUTHORING + schema', (await p.$$('a[href*="SPEC.md"]')).length >= 1 && (await p.$$('a[href*="AUTHORING.md"]')).length >= 1 && (await p.$$('a[href*="p2present.schema.json"]')).length >= 1);
      ok('docs: schema asset resolves 200', a['/p2present.schema.json'] === 200 || (await p.evaluate(() => fetch('../p2present.schema.json').then((r) => r.ok).catch(() => false))));
      for (const w of [1280, 780, 390]) {
        await p.setViewportSize({ width: w, height: w === 390 ? 800 : 860 });
        await p.waitForTimeout(150);
        await p.screenshot({ path: path.join(SHOTS, `docs-${w}.png`), fullPage: true });
      }
      const noHScroll = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
      ok('docs: no horizontal overflow at 390px', noHScroll);
      ok('docs: no same-origin console errors', p._consoleErrors.length === 0, p._consoleErrors.slice(0, 2).join(' | '));
      await p.close();
    }

    // === 0b. Legacy/aliased player links on / redirect to /app/ ===
    {
      const p = await newPage(context);
      await p.goto(`${ORIGIN}/?demo`, { waitUntil: 'load' });
      const landed = await p.waitForFunction(() => location.pathname.endsWith('/app/'), { timeout: 8000 }).then(() => true).catch(() => false);
      ok('home: ?demo redirects to /app/', landed, await p.evaluate(() => location.pathname));
      const mounted = await p.waitForSelector('.p2-stage', { timeout: 30000 }).then(() => true).catch(() => false);
      ok('home: redirected demo mounts the player', mounted);
      await p.close();
    }

    // === 1. Demo loads (https/youtube), responsive widths, asset 200s ===
    const page = await newPage(context);
    const assetStatus = {};
    page.on('response', (r) => {
      const u = r.url();
      if (u.startsWith(ORIGIN)) assetStatus[u.replace(ORIGIN, '')] = r.status();
    });
    await page.goto(`${ORIGIN}/app/`, { waitUntil: 'load' });
    // The deck iframe loads LAST in Player.mount(), so waiting for it means the
    // whole player (video + deck + controls + subs) finished mounting.
    const mounted = await page.waitForSelector('.p2-deck-frame', { timeout: 30000 })
      .then(() => true).catch(() => false);
    ok('demo: player stage mounts', await page.$('.p2-stage'));
    ok('demo: deck iframe present (full mount)', mounted);
    // The control bar (and CC menu) are built after video+deck+subs all load, so
    // wait for it rather than racing the deck-iframe load event.
    const controlsBuilt = await page.waitForSelector('.p2-controls', { timeout: 15000 }).then(() => true).catch(() => false);
    ok('demo: controls bar present', controlsBuilt);
    const defaultMode = await page.evaluate(() => document.querySelector('.p2-stage')?.dataset.mode);
    ok('demo: default player layout is p2p/PiP view', defaultMode === 'overlap', defaultMode);
    const floatingControls = await page.evaluate(() => {
      const root = document.querySelector('.p2-player');
      const bar = document.querySelector('.p2-controls');
      const cs = getComputedStyle(bar);
      return {
        floating: root.classList.contains('p2-floating-controls'),
        visible: root.classList.contains('p2-controls-visible'),
        absolute: cs.position === 'absolute',
        glass: cs.backdropFilter !== 'none' || cs.webkitBackdropFilter !== 'none',
      };
    });
    ok('controls: normal player uses floating overlay chrome', floatingControls.floating && floatingControls.absolute, JSON.stringify(floatingControls));
    ok('controls: initially visible for play', floatingControls.visible, JSON.stringify(floatingControls));
    const ccPresent = await page.waitForSelector('.p2-cc-btn', { timeout: 15000 }).then(() => true).catch(() => false);
    ok('demo: CC (subtitles) menu present', ccPresent);
    ok('demo: app.css 200', assetStatus['/app.css'] === 200, String(assetStatus['/app.css']));
    ok('demo: main.js 200', assetStatus['/src/main.js'] === 200, String(assetStatus['/src/main.js']));
    ok('demo: resolve.js 200', assetStatus['/src/resolve.js'] === 200, String(assetStatus['/src/resolve.js']));

    // Give YT a moment, then screenshot at three widths.
    await page.waitForTimeout(3500);
    for (const w of [1280, 780, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 760 : 800 });
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(SHOTS, `demo-youtube-${w}.png`) });
    }
    ok('demo: no same-origin console errors', page._consoleErrors.length === 0, page._consoleErrors.slice(0, 2).join(' | '));
    await page.close();

    // === 2. Resolver routing ===
    const demoAbs = `${ORIGIN}/content/demo/manifest.json`;
    const routeCases = [
      ['?p=demo', `?p=demo`],
      ['?manifest=<abs>', `?manifest=${encodeURIComponent(demoAbs)}`],
      ['?src=<base64 url>', `?src=${encodeURIComponent(b64(demoAbs))}`],
    ];
    for (const [label, query] of routeCases) {
      const p = await newPage(context);
      await p.goto(`${ORIGIN}/app/${query}`, { waitUntil: 'load' });
      const titled = await p.waitForFunction(
        () => document.getElementById('deck-title')?.textContent?.includes('Rage-Coding'),
        { timeout: 20000 }).then(() => true).catch(() => false);
      ok(`routing ${label}: manifest resolved`, titled);
      await p.close();
    }
    // inline base64 manifest (a tiny self-contained one pointing at local assets)
    const inline = {
      p2present: '1.0', title: 'Inline B64 Deck',
      video: { sources: [{ provider: 'mp4', src: `${ORIGIN}/content/demo/slides/assets/nedagram-demo.mp4` }] },
      deck: { type: 'html', sources: [{ src: `${ORIGIN}/content/demo/slides/index.html` }], slideCount: 23 },
      timing: [{ time: 0, slide: 1 }],
    };
    {
      const p = await newPage(context);
      await p.goto(`${ORIGIN}/app/?src=${encodeURIComponent(b64(JSON.stringify(inline)))}`, { waitUntil: 'load' });
      const titled = await p.waitForFunction(
        () => document.getElementById('deck-title')?.textContent === 'Inline B64 Deck',
        { timeout: 15000 }).then(() => true).catch(() => false);
      ok('routing ?src=<base64 inline manifest>: loaded', titled);
      await p.close();
    }

    // === 3. Provider source-fallback: ipfs(dead) → mp4(local) ===
    {
      const p = await newPage(context);
      await p.goto(`${ORIGIN}/app/?manifest=${encodeURIComponent(`${ORIGIN}/__fixtures__/fallback.json`)}`, { waitUntil: 'load' });
      const hasVideo = await p.waitForSelector('.p2-video-pane video', { timeout: 20000 })
        .then(() => true).catch(() => false);
      ok('fallback: ipfs(dead)→mp4 yields <video>', hasVideo);

      // --- Subtitles: renamed control + full-window caption overlay ---
      await p.waitForSelector('.p2-cc-btn', { timeout: 15000 }).catch(() => {});
      const subBtn = await p.evaluate(() => ({
        label: document.querySelector('.p2-cc-btn .p2-btn-label')?.textContent || '',
        aria: document.querySelector('.p2-cc-btn')?.getAttribute('aria-label') || '',
        places: document.querySelectorAll('.p2-cc-place').length,
      }));
      ok('subtitles: control labelled "Subtitles" (not CC)', /subtitle/i.test(subBtn.label) && /subtitle/i.test(subBtn.aria), JSON.stringify(subBtn));
      ok('subtitles: placement menu offers both options', subBtn.places === 2, String(subBtn.places));
      // Drive a cue + confirm the overlay defaults to the WHOLE player stage.
      await p.evaluate(() => { const v = document.querySelector('.p2-video-pane video'); if (v) v.currentTime = 2; });
      await p.waitForTimeout(500);
      const winCap = await p.evaluate(() => {
        const ov = document.querySelector('.p2-cc-overlay');
        return { onStage: ov?.parentElement?.classList.contains('p2-stage'), isWindow: ov?.classList.contains('p2-cc-window'), text: (ov?.textContent || '').trim().length };
      });
      ok('subtitles: full-window overlay mounts on the player stage', winCap.onStage && winCap.isWindow);
      ok('subtitles: full-window overlay renders cue text', winCap.text > 0, `len=${winCap.text}`);
      // Toggle to "Over video" → native <track> takes over, overlay detaches.
      await p.click('.p2-cc-btn'); await p.waitForTimeout(120);
      await p.click('.p2-cc-place[data-place="video"]'); await p.waitForTimeout(250);
      const vidCap = await p.evaluate(() => ({
        overlayGone: !document.querySelector('.p2-cc-overlay'),
        track: [...document.querySelectorAll('.p2-video-pane video track')].some((t) => t.track?.mode === 'showing'),
      }));
      ok('subtitles: "over video" switches to native track', vidCap.overlayGone && vidCap.track, JSON.stringify(vidCap));
      // Back to full window for the screenshot + later checks.
      await p.click('.p2-cc-place[data-place="window"]'); await p.waitForTimeout(200);
      await p.click('.p2-cc-btn');   // close the menu
      await p.waitForTimeout(300);
      await p.screenshot({ path: path.join(SHOTS, 'mp4-fallback.png') });

      // --- fullscreen auto-hide overlay controls (exercised on this working player) ---
      // Trigger via the real Fullscreen button. In headless Chrome the native
      // request may reject and the player falls back to its CSS-maximized mode;
      // either way _isImmersive() is true and the .p2-immersive overlay applies.
      await p.click('[aria-label^="Fullscreen"]');
      await p.waitForTimeout(400);
      // Dispatch pointer activity to reveal the auto-hidden bar.
      await p.evaluate(() => document.querySelector('.p2-player')?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })));
      await p.waitForTimeout(200);
      const immersive = await p.evaluate(() => {
        const root = document.querySelector('.p2-player');
        const bar = document.querySelector('.p2-controls');
        const pos = getComputedStyle(bar).position;
        return {
          hasImmersive: root.classList.contains('p2-immersive'),
          visible: root.classList.contains('p2-controls-visible'),
          fixed: pos === 'fixed',
        };
      });
      ok('fullscreen: controls become immersive overlay', immersive.hasImmersive);
      ok('fullscreen: overlay is position:fixed (no reflow)', immersive.fixed);
      ok('fullscreen: pointer activity reveals controls', immersive.visible);
      await p.waitForTimeout(300);
      await p.screenshot({ path: path.join(SHOTS, 'fullscreen-controls.png') });

      // Auto-hide after inactivity (timer is 2.5s).
      await p.waitForTimeout(3000);
      const hidden = await p.evaluate(() => !document.querySelector('.p2-player').classList.contains('p2-controls-visible'));
      ok('fullscreen: controls auto-hide after inactivity', hidden);

      // --- layout modes switch ---
      await p.evaluate(async () => { // leave immersive so the controls are clickable normally
        try { if (document.fullscreenElement) await document.exitFullscreen(); } catch {}
        document.querySelector('.p2-player').classList.remove('is-maximized', 'p2-immersive');
        document.querySelector('.p2-player').classList.add('p2-controls-visible');
        document.body.classList.remove('p2-maximized');
      });
      await p.waitForTimeout(200);
      const modeBtns = await p.$$('.p2-mode-btn');
      ok('layout: four mode buttons', modeBtns.length === 4, String(modeBtns.length));
      if (modeBtns.length === 4) {
        await p.click('.p2-fold-trigger');
        await p.waitForTimeout(120);
        await modeBtns[1].click(); // slides-focus
        await p.waitForTimeout(200);
        const mode = await p.evaluate(() => document.querySelector('.p2-stage')?.dataset.mode);
        ok('layout: clicking a folded mode updates data-mode', mode === 'slides-focus', mode);
      }
      await p.close();
    }

    // === 3b. Timeline seek moves the VIDEO + slide together (bug-1 regression) ===
    // The scrubber is authoritative over the video: dragging/clicking it must seek
    // the provider AND jump to the slide for that time — in BOTH paused & playing
    // states. Uses the deterministic local-mp4 fixture (offline). YouTube is checked
    // best-effort below (needs network) since its known race was the original bug.
    {
      const p = await newPage(context);
      await p.goto(`${ORIGIN}/app/?manifest=${encodeURIComponent(`${ORIGIN}/__fixtures__/seek.json`)}`, { waitUntil: 'load' });
      await p.waitForSelector('.p2-video-pane video', { timeout: 20000 }).catch(() => {});
      await p.waitForFunction(() => { const v = document.querySelector('.p2-video-pane video'); return v && v.duration > 1; }, { timeout: 15000 }).catch(() => {});

      const seekTo = (frac) => p.evaluate((f) => {
        const s = document.querySelector('.p2-scrub');
        s.value = String(Math.round(f * 1000));
        s.dispatchEvent(new Event('input', { bubbles: true }));   // == click/drag result
      }, frac);
      const snap = () => p.evaluate(() => {
        const v = document.querySelector('.p2-video-pane video');
        return { t: v?.currentTime || 0, dur: v?.duration || 0, paused: v ? v.paused : true,
          slide: document.querySelector('.p2-slidecount')?.textContent || '' };
      });

      // PAUSED: seek to ~middle. Time jumps there; stays paused; slide moves.
      await p.evaluate(() => document.querySelector('.p2-video-pane video')?.pause());
      const before = await snap();
      await seekTo(0.5);
      await p.waitForTimeout(300);
      const pausedSeek = await snap();
      ok('seek(paused): video.currentTime jumps to the seek point',
        Math.abs(pausedSeek.t - pausedSeek.dur * 0.5) < 4 && pausedSeek.t > before.t + 1,
        `t=${pausedSeek.t.toFixed(1)} dur=${pausedSeek.dur.toFixed(1)}`);
      ok('seek(paused): stays paused at that frame', pausedSeek.paused);
      ok('seek(paused): slide jumps with the video', pausedSeek.slide !== before.slide, `${before.slide} -> ${pausedSeek.slide}`);

      // PLAYING: play, then seek elsewhere. Time jumps; keeps playing; slide moves.
      await p.evaluate(() => document.querySelector('.p2-video-pane video')?.play().catch(() => {}));
      await p.waitForTimeout(400);
      const playBefore = await snap();
      await seekTo(0.85);
      await p.waitForTimeout(300);
      const playSeek = await snap();
      ok('seek(playing): video.currentTime jumps to the seek point',
        Math.abs(playSeek.t - playSeek.dur * 0.85) < 6,
        `t=${playSeek.t.toFixed(1)} dur=${playSeek.dur.toFixed(1)}`);
      ok('seek(playing): keeps playing from there', !playSeek.paused);
      ok('seek(playing): slide jumps with the video', playSeek.slide !== playBefore.slide, `${playBefore.slide} -> ${playSeek.slide}`);
      await p.close();
    }

    // === 3c. YouTube cold-seek (best-effort; needs network) ===
    // The original bug: seeking before pressing play left the YouTube iframe stuck
    // on the poster at 0. With the fix a cold seek must advance getCurrentTime().
    // Skipped (counted as pass) when the iframe API can't load in this environment.
    {
      const p = await newPage(context);
      await p.goto(`${ORIGIN}/app/?p=demo`, { waitUntil: 'load' });
      await p.waitForSelector('.p2-deck-frame', { timeout: 30000 }).catch(() => {});
      // Wait until the YT provider reports a real duration (i.e. the API loaded).
      const ytReady = await p.waitForFunction(
        () => (window.__p2player?.video?.getDuration?.() || 0) > 1,
        { timeout: 12000 }).then(() => true).catch(() => false);
      if (!ytReady) {
        ok('youtube: cold-seek advances the video (skipped — API offline)', true, 'no network');
        ok('youtube: cold-seek stays paused (skipped — API offline)', true, 'no network');
      } else {
        const t0 = await p.evaluate(() => window.__p2player.video.getTime());
        // Cold seek to ~40% by driving the REAL scrubber element (== a user drag /
        // click), never having pressed play. currentTime must track the slider.
        await p.evaluate(() => {
          const s = document.querySelector('.p2-scrub');
          s.value = '400';
          s.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const advanced = await p.waitForFunction(
          (prev) => window.__p2player.video.getTime() > prev + 5,
          t0, { timeout: 8000 }).then(() => true).catch(() => false);
        const t1 = await p.evaluate(() => window.__p2player.video.getTime());
        ok('youtube: cold-seek advances the video (not stuck at 0)', advanced, `t0=${t0?.toFixed?.(1)} -> t1=${t1?.toFixed?.(1)}`);
        // The slider is a scrub, not a play button: a cold drag lands the frame but
        // must NOT start playback (the kick play→pauses itself).
        await p.waitForTimeout(800);
        const stillPaused = await p.evaluate(() => !window.__p2player.video.isPlaying());
        ok('youtube: cold-seek lands the frame without starting playback', stillPaused);
      }
      await p.close();
    }

    // === 4. p2p routing reaches real loading/fallback (not "coming soon") ===
    for (const [label, src, shot] of [
      ['ipfs://', 'ipfs://bafkreideadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef/p2present.json', 'ipfs-loading.png'],
      ['magnet:', 'magnet:?xt=urn:btih:deadbeefdeadbeefdeadbeefdeadbeefdeadbeef&dn=p2present.json', 'magnet-loading.png'],
    ]) {
      const p = await newPage(context);
      await p.goto(`${ORIGIN}/app/`, { waitUntil: 'load' });
      // Open the source bar + type the p2p source, submit.
      await p.click('#brand-toggle'); // desktop header starts as a collapsed logo pill
      await p.click('#source-toggle');
      await p.fill('#source-input', src);
      // Capture the loading state shortly after submit.
      await p.click('.p2-load[type="submit"], .p2-load:not(.p2-share)');
      await p.waitForTimeout(400);
      const status = await p.evaluate(() => document.getElementById('status')?.textContent || '');
      const noStub = !/coming soon|phase-2 feature|not yet implemented/i.test(status);
      ok(`p2p ${label}: routed (no 'coming soon' stub)`, noStub, status.slice(0, 60));
      await p.screenshot({ path: path.join(SHOTS, shot) });
      await p.close();
    }

    // === 5. PDF demo (pdf.js deck adapter) renders + syncs ===
    {
      const p = await newPage(context);
      await p.goto(`${ORIGIN}/app/?p=moav-pdf`, { waitUntil: 'load' });
      await p.waitForSelector('.p2-pdf-stage', { timeout: 30000 }).catch(() => {});
      // Wait for slide 1 to actually be rendered + visible (not display:none).
      const visible = await p.waitForFunction(() => {
        const c = document.querySelector('.p2-pdf-page');
        return c && c.style.display !== 'none' && c.width > 0;
      }, { timeout: 30000 }).then(() => true).catch(() => false);
      ok('pdf demo: slide 1 canvas renders visibly', visible);
      // Sync: advancing the deck via the Next button updates the counter.
      const before = await p.evaluate(() => document.querySelector('.p2-slidecount')?.textContent);
      await p.click('.p2-btn[aria-label^="Next"]');
      await p.waitForTimeout(700);
      const after = await p.evaluate(() => document.querySelector('.p2-slidecount')?.textContent);
      ok('pdf demo: next-slide advances the deck', !!after && after !== before, `${before} -> ${after}`);
      await p.waitForTimeout(500);
      await p.screenshot({ path: path.join(SHOTS, 'pdf-demo.png') });

      // --- regression: every PDF slide renders + STAYS visible (the black-slide
      // bug). Unlink sync so the (paused) video can't fight deck navigation, then
      // walk N slides through cut/fade/slide transitions. After each step exactly
      // ONE canvas must be visible at full opacity with real (non-black) pixels.
      await p.click('.p2-link');     // unlink sync
      const measure = () => p.evaluate(() => {
        const cs = [...document.querySelectorAll('.p2-pdf-page')];
        const vis = cs.filter((c) => c.style.display !== 'none' && getComputedStyle(c).display !== 'none');
        const c = vis[0];
        let lum = null;
        if (c) {
          const tmp = document.createElement('canvas'); tmp.width = 32; tmp.height = 24;
          const ctx = tmp.getContext('2d');
          try { ctx.drawImage(c, 0, 0, 32, 24); const d = ctx.getImageData(0, 0, 32, 24).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3; lum = Math.round(s / (32 * 24)); } catch { lum = -1; }
        }
        return { visible: vis.length, opacity: c ? getComputedStyle(c).opacity : null, lum, slide: document.querySelector('.p2-slidecount')?.textContent };
      });
      // Drive to a slide via its authored transition (exercises cut/fade/slide on
      // BOTH directions — the back-and-forth black-slide path).
      const nav = (n) => p.evaluate((n) => {
        const cues = window.__p2player.sync.cues;
        const cue = cues.find((c) => c.slide === n);
        return window.__p2player.deck.goTo(n, { transition: cue?.transition || 'cut' });
      }, n);
      const total = await p.evaluate(() => window.__p2player.deck.slideCount);
      const blackOrHidden = [];
      const check = (m) => m.visible === 1 && parseFloat(m.opacity) > 0.95 && typeof m.lum === 'number' && m.lum > 8;
      // FORWARD across every slide 1 → N.
      for (let n = 2; n <= total; n++) {
        await nav(n);
        await p.waitForTimeout(120);
        const m = await measure();
        if (!check(m)) blackOrHidden.push(`fwd ${m.slide}:vis=${m.visible},op=${m.opacity},lum=${m.lum}`);
      }
      // BACKWARD across every slide N → 1 (where the bug bit hardest).
      for (let n = total - 1; n >= 1; n--) {
        await nav(n);
        await p.waitForTimeout(120);
        const m = await measure();
        if (!check(m)) blackOrHidden.push(`rev ${m.slide}:vis=${m.visible},op=${m.opacity},lum=${m.lum}`);
        if (n === Math.round(total / 2)) await p.screenshot({ path: path.join(SHOTS, 'pdf-reverse.png') });
      }
      ok(`pdf demo: all ${total} slides render non-blank forward AND backward`, blackOrHidden.length === 0, blackOrHidden.slice(0, 4).join(' | '));

      // Stress overlapping transitions (rapid fire, then back down) — must land clean.
      for (let i = 0; i < 5; i++) p.click('.p2-btn[aria-label^="Next"]').catch(() => {});
      await p.waitForTimeout(900);
      const rapid = await measure();
      ok('pdf demo: rapid overlapping transitions land on one visible slide', check(rapid), JSON.stringify(rapid));
      await p.click('.p2-link');     // re-link sync for any later checks

      // --- scrubber thumbnail preview (PDF renders real page thumbnails) ---
      const box = await p.$eval('.p2-scrub', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
      await p.mouse.move(box.x + box.w * 0.55, box.y + box.h / 2);
      await p.waitForTimeout(1400);
      const prev = await p.evaluate(() => {
        const pv = document.querySelector('.p2-scrub-preview');
        return {
          vis: pv?.classList.contains('is-visible'),
          hasImg: pv?.classList.contains('has-img'),
          cap: pv?.querySelector('.p2-preview-cap')?.textContent || '',
          img: pv?.querySelector('.p2-preview-img')?.getAttribute('src') || '',
        };
      });
      ok('scrubber: preview visible on hover', !!prev.vis);
      ok('scrubber: preview caption names a slide', /Slide \d/.test(prev.cap), prev.cap);
      ok('scrubber: PDF thumbnail image shown', prev.hasImg && /^data:image\//.test(prev.img));
      await p.close();
    }

    // === 5b. Embed deck adapter (external slide URL in an <iframe>) ===
    {
      const p = await newPage(context);
      // A local HTML page stands in for an external embed (Google Slides etc.).
      const embed = {
        p2present: '1.0', title: 'Embed Deck',
        video: { sources: [{ provider: 'mp4', src: `${ORIGIN}/content/demo/slides/assets/nedagram-demo.mp4` }] },
        deck: { type: 'embed', sources: [{ src: `${ORIGIN}/content/demo/slides/index.html` }], slideCount: 7, embed: { nav: 'hash', param: 'slide' } },
        timing: [{ time: 0, slide: 1 }, { time: 2, slide: 2 }],
      };
      await p.goto(`${ORIGIN}/app/?src=${encodeURIComponent(b64(JSON.stringify(embed)))}`, { waitUntil: 'load' });
      const frame = await p.waitForSelector('.p2-embed-frame', { timeout: 20000 }).then(() => true).catch(() => false);
      ok('embed deck: external slides render in an <iframe>', frame);
      const sc = await p.evaluate(() => document.querySelector('.p2-slidecount')?.textContent || '');
      ok('embed deck: slide count comes from the manifest', /\/\s*7/.test(sc), sc);
      ok('embed deck: no same-origin console errors', p._consoleErrors.length === 0, p._consoleErrors.slice(0, 2).join(' | '));
      await p.close();
    }

    // === 6. Deep-link hash opens the player at the right time/slide ===
    {
      const p = await newPage(context);
      await p.goto(`${ORIGIN}/app/?p=demo#t=575&slide=13`, { waitUntil: 'load' });
      await p.waitForSelector('.p2-deck-frame', { timeout: 30000 }).catch(() => {});
      const atSlide = await p.waitForFunction(
        () => /\b13 \//.test(document.querySelector('.p2-slidecount')?.textContent || ''),
        { timeout: 15000 }).then(() => true).catch(() => false);
      ok('deeplink: #t=575&slide=13 opens at slide 13', atSlide);

      // --- Share menu (YouTube-style popover): two clear options, copies links ---
      // Grant clipboard + spy on writeText so we can assert WHAT gets copied.
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN }).catch(() => {});
      await p.evaluate(() => { window.__copied = []; const o = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = (t) => { window.__copied.push(t); return o(t); }; });
      ok('share: standalone "this spot" button removed', !(await p.$('#share-spot-btn')));
      await p.click('#brand-toggle');
      await p.click('#share-btn');
      const menuOpen = await p.evaluate(() => !document.getElementById('share-menu').hidden && document.getElementById('share-btn').getAttribute('aria-expanded') === 'true');
      ok('share: button opens a popover menu', menuOpen);
      const items = await p.evaluate(() => [...document.querySelectorAll('.p2-share-item')].map((b) => b.textContent.trim()));
      ok('share: menu offers presentation link + this-moment + export', items.length === 3 && /presentation/i.test(items[0]) && /moment/i.test(items[1]) && /export/i.test(items[2]), items.join(' | '));
      // "Copy link to this moment" → a #t=…&slide=… deep-link.
      await p.click('#share-moment');
      await p.waitForTimeout(150);
      const moment = await p.evaluate(() => window.__copied.at(-1) || '');
      ok('share: "this moment" copies a #t=&slide= deep-link', /#t=\d+&slide=\d+/.test(moment), moment.slice(-40));
      const closed = await p.evaluate(() => document.getElementById('share-menu').hidden);
      ok('share: menu closes after copying', closed);
      // "Copy presentation link" → a ?src= link with no deep-link hash.
      await p.click('#share-btn');
      await p.click('#share-whole');
      await p.waitForTimeout(150);
      const whole = await p.evaluate(() => window.__copied.at(-1) || '');
      ok('share: "presentation link" copies a hash-free ?src= link', /[?&]src=/.test(whole) && !/#t=/.test(whole), whole.slice(0, 40));
      await p.close();
    }

    // === 6b. Save & share (pastebin-lite) + ?p=<id> service load ===
    {
      const p = await newPage(context);
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN }).catch(() => {});
      await p.goto(`${ORIGIN}/app/?p=demo`, { waitUntil: 'load' });
      await p.waitForSelector('.p2-deck-frame', { timeout: 30000 }).catch(() => {});
      const saveEnabled = await p.waitForFunction(
        () => { const b = document.getElementById('save-btn'); return b && !b.disabled; },
        { timeout: 15000 }).then(() => true).catch(() => false);
      ok('save: "Save & share" button enabled once a manifest is loaded', saveEnabled);
      await p.evaluate(() => { window.__copied = []; const o = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = (t) => { window.__copied.push(t); return o(t); }; });
      await p.click('#brand-toggle');
      await p.click('#save-btn');
      const savedMsg = await p.waitForFunction(
        () => /\/p\/smoke01/.test(document.getElementById('status')?.textContent || ''),
        { timeout: 10000 }).then(() => true).catch(() => false);
      ok('save: POSTs the manifest + surfaces a short /p/<id> link', savedMsg, (await p.evaluate(() => document.getElementById('status')?.textContent || '')).slice(0, 60));
      const copied = await p.evaluate(() => window.__copied.at(-1) || '');
      ok('save: short link copied to clipboard', /\/p\/smoke01$/.test(copied), copied);
      const tokenSaved = await p.evaluate(() => { try { return JSON.parse(localStorage.getItem('p2present:tokens') || '{}').smoke01 || ''; } catch { return ''; } });
      ok('save: edit token kept in the author browser', tokenSaved === 'tok_smoke_0000', tokenSaved);
      await p.close();
    }
    {
      // ?p=<service id> (not a bundled demo) resolves through the backend.
      const p = await newPage(context);
      await p.goto(`${ORIGIN}/app/?p=smoke01`, { waitUntil: 'load' });
      const titled = await p.waitForFunction(
        () => document.getElementById('deck-title')?.textContent === 'Smoke Service Deck',
        { timeout: 15000 }).then(() => true).catch(() => false);
      ok('service load: ?p=<id> fetches the manifest from the service', titled);
      const mounted = await p.waitForSelector('.p2-deck-frame', { timeout: 20000 }).then(() => true).catch(() => false);
      ok('service load: service-hosted presentation mounts the player', mounted);
      ok('service load: no same-origin console errors', p._consoleErrors.length === 0, p._consoleErrors.slice(0, 2).join(' | '));
      await p.close();
    }

    // === 7. Builder: validates + exports ===
    {
      const p = await newPage(context);
      await p.goto(`${ORIGIN}/builder/`, { waitUntil: 'load' });
      await p.waitForSelector('.p2-form', { timeout: 15000 });
      ok('builder: form mounts', await p.$('.p2-form'));
      // Default view is the guided Simple flow; the advanced cards are hidden.
      const simpleDefault = await p.evaluate(() =>
        !!document.getElementById('s-video') &&
        getComputedStyle(document.querySelector('.p2-adv')).display === 'none');
      ok('builder: simple view is the default (guided fields; advanced hidden)', simpleDefault);
      // Simple flow auto-detects a Google Slides URL as an embed deck.
      await p.fill('#s-deck', 'https://docs.google.com/presentation/d/ABC123/edit?slide=id.g1#slide=id.g1');
      await p.waitForTimeout(150);
      const gslides = await p.evaluate(() => {
        try { return JSON.parse(document.querySelector('#json code').textContent).deck.type; } catch { return null; }
      });
      ok('builder: Google Slides URL → embed deck type', gslides === 'embed', gslides);
      await p.evaluate(() => { const i = document.getElementById('s-deck'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
      // Switch to Advanced for the field-level checks below.
      await p.click('#mode-advanced');
      await p.waitForTimeout(150);
      const advShown = await p.evaluate(() => getComputedStyle(document.querySelector('.p2-adv')).display !== 'none');
      ok('builder: advanced view reveals the full form', advShown);
      // Blank → invalid; Load demo → valid.
      const blankBadge = await p.evaluate(() => document.getElementById('valid-badge')?.textContent || '');
      ok('builder: blank manifest flagged invalid', /issue/i.test(blankBadge), blankBadge);
      await p.click('#load-demo');
      const valid = await p.waitForFunction(
        () => /valid/i.test(document.getElementById('valid-badge')?.textContent || ''),
        { timeout: 10000 }).then(() => true).catch(() => false);
      ok('builder: demo loads + validates against schema', valid);
      const exported = await p.evaluate(() => {
        try { const m = JSON.parse(document.querySelector('#json code').textContent); return !!(m.video && m.deck && Array.isArray(m.timing)); }
        catch { return false; }
      });
      ok('builder: exports a structured manifest (video+deck+timing)', exported);
      // Deck source selection: protocol dropdown (like video) + embed deck type.
      const deckRow = await p.evaluate(() => {
        const row = document.querySelector('#list-deck .p2-row');
        const sel = row?.querySelector('select');
        return { hasProto: !!sel, opts: [...(sel?.options || [])].map((o) => o.value) };
      });
      ok('builder: deck rows have a protocol dropdown (https/ipfs/webtorrent)',
        deckRow.hasProto && ['https', 'ipfs', 'webtorrent'].every((x) => deckRow.opts.includes(x)), deckRow.opts.join(','));
      const deckTypeOpts = await p.evaluate(() => [...document.getElementById('f-deck-type').options].map((o) => o.value));
      ok('builder: deck type offers html/pdf/embed', ['html', 'pdf', 'embed'].every((x) => deckTypeOpts.includes(x)), deckTypeOpts.join(','));
      // Switch to embed + point at an external slide URL → still validates.
      await p.selectOption('#f-deck-type', 'embed');
      await p.evaluate(() => { const i = document.querySelector('#list-deck input'); i.value = 'https://docs.google.com/presentation/d/X/embed'; i.dispatchEvent(new Event('input', { bubbles: true })); });
      await p.fill('#f-slidecount', '12');
      await p.waitForTimeout(200);
      const embedValid = await p.evaluate(() => {
        const ok = /valid/i.test(document.getElementById('valid-badge')?.textContent || '');
        let t = null; try { t = JSON.parse(document.querySelector('#json code').textContent).deck.type; } catch {}
        return ok && t === 'embed';
      });
      ok('builder: embed deck type validates + exports', embedValid);
      // Reset to the demo so the screenshots/overflow checks below are unaffected.
      await p.click('#load-demo');
      await p.waitForFunction(() => /valid/i.test(document.getElementById('valid-badge')?.textContent || ''), { timeout: 10000 }).catch(() => {});
      // Responsive: the two-column layout collapses to one column on narrow widths.
      for (const w of [1280, 780, 390]) {
        await p.setViewportSize({ width: w, height: 800 });
        await p.waitForTimeout(250);
        await p.screenshot({ path: path.join(SHOTS, `builder-${w}.png`) });
      }
      const noHScroll = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
      ok('builder: no horizontal overflow at 390px', noHScroll);
      ok('builder: no same-origin console errors', p._consoleErrors.length === 0, p._consoleErrors.slice(0, 2).join(' | '));
      await p.close();
    }

    // === 8. Host helper: pluggable persistence providers ===
    {
      const p = await newPage(context);
      // Mock the Pinata pin endpoint so we never hit the network / need a token.
      await p.route('https://api.pinata.cloud/**', (r) => r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ IpfsHash: 'bafkreitestcidmock0000000000000000000000000000000000000000' }),
      }));
      await p.goto(`${ORIGIN}/host/`, { waitUntil: 'load' });
      await p.waitForSelector('#persist-provider', { timeout: 15000 });
      const providers = await p.evaluate(() =>
        [...document.querySelectorAll('#persist-provider option')].map((o) => o.value));
      ok('host: 4 persistence providers in the picker', providers.length === 4 && providers.includes('arweave'), providers.join(','));
      ok('host: Arweave is the default + "Make permanent" action',
        (await p.inputValue('#persist-provider')) === 'arweave' && /permanent/i.test(await p.textContent('#persist-action')));

      // Arweave with no endpoint → the payment hook surfaces a documented note (no crash).
      await p.setInputFiles('#persist-file', { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
      await p.click('#persist-action');
      const payNote = await p.waitForFunction(
        () => document.getElementById('persist-status')?.classList.contains('is-note'),
        { timeout: 8000 }).then(() => true).catch(() => false);
      ok('host: Arweave "Make permanent" stub shows the payment-wiring note', payNote,
        await p.textContent('#persist-status'));

      // Switch to the IPFS pinning provider → token field renders.
      await p.selectOption('#persist-provider', 'pinning');
      await p.waitForSelector('#pf-token', { timeout: 5000 });
      await p.setInputFiles('#persist-file', { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
      await p.click('#persist-action');
      await p.waitForTimeout(300);
      ok('host: pinning upload without a token prompts for one', /token/i.test(await p.textContent('#persist-status')));
      await p.fill('#pf-token', 'FAKEJWT');
      await p.click('#persist-action');
      const pinned = await p.waitForFunction(
        () => !document.getElementById('persist-result').hidden,
        { timeout: 10000 }).then(() => true).catch(() => false);
      ok('host: IPFS pin (mock) shows a result', pinned);
      const ref = await p.evaluate(() => document.querySelector('#persist-result .is-ref')?.textContent || '');
      ok('host: result is an ipfs:// reference', ref.startsWith('ipfs://bafk'), ref);
      const handoff = await p.evaluate(() => { try { return JSON.parse(localStorage.getItem('p2present:hosted'))?.[0]?.ref || ''; } catch { return ''; } });
      ok('host: reference saved for the builder handoff', handoff.startsWith('ipfs://'));

      // Seedbox provider → WebTorrent trackers prefilled (UI present; no live seed).
      await p.selectOption('#persist-provider', 'seedbox');
      await p.waitForSelector('#pf-trackers', { timeout: 5000 });
      ok('host: seedbox trackers prefilled', (await p.inputValue('#pf-trackers')).includes('wss://'));
      await p.selectOption('#persist-provider', 'arweave');   // reset for screenshots
      for (const w of [1280, 780, 390]) {
        await p.setViewportSize({ width: w, height: 800 });
        await p.waitForTimeout(250);
        await p.screenshot({ path: path.join(SHOTS, `host-${w}.png`) });
      }
      const noHScroll = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
      ok('host: no horizontal overflow at 390px', noHScroll);
      ok('host: no same-origin console errors', p._consoleErrors.length === 0, p._consoleErrors.slice(0, 2).join(' | '));
      await p.close();
    }

    // === 9. Signed manifests (Phase 8): verify badge states ===
    {
      // Valid signature → "✓ signed by 0x…" badge (ENS disabled, so the address
      // form is shown), and the player still mounts normally.
      const p = await newPage(context);
      await p.goto(`${ORIGIN}/app/?manifest=${encodeURIComponent(`${ORIGIN}/__fixtures__/signed.json`)}`, { waitUntil: 'load' });
      await p.waitForSelector('.p2-video-pane video', { timeout: 20000 }).catch(() => {});
      const valid = await p.waitForFunction(
        () => document.getElementById('sig-badge')?.classList.contains('is-valid'),
        { timeout: 15000 }).then(() => true).catch(() => false);
      const badge = await p.evaluate(() => ({
        text: document.getElementById('sig-badge')?.textContent || '',
        title: document.getElementById('sig-badge')?.getAttribute('title') || '',
        hidden: document.getElementById('sig-badge')?.hidden,
      }));
      ok('signed: valid signature shows a "✓ signed by" badge', valid && /✓ signed by/.test(badge.text), badge.text);
      ok('signed: badge names the signer address', /0x2c75/i.test(badge.text + badge.title), badge.text);
      ok('signed: player still mounts a working deck', await p.$('.p2-video-pane video'));
      ok('signed: no same-origin console errors', p._consoleErrors.length === 0, p._consoleErrors.slice(0, 2).join(' | '));
      await p.screenshot({ path: path.join(SHOTS, 'signed-badge.png') });
      await p.close();
    }
    {
      // Tampered manifest → "⚠ signature invalid"; playback NOT blocked.
      const p = await newPage(context);
      await p.goto(`${ORIGIN}/app/?manifest=${encodeURIComponent(`${ORIGIN}/__fixtures__/tampered.json`)}`, { waitUntil: 'load' });
      await p.waitForSelector('.p2-video-pane video', { timeout: 20000 }).catch(() => {});
      const invalid = await p.waitForFunction(
        () => document.getElementById('sig-badge')?.classList.contains('is-invalid'),
        { timeout: 15000 }).then(() => true).catch(() => false);
      ok('signed: tampered manifest shows "⚠ signature invalid"', invalid,
        await p.evaluate(() => document.getElementById('sig-badge')?.textContent || ''));
      ok('signed: tampered manifest still plays (not blocked)', await p.$('.p2-video-pane video'));
      await p.close();
    }
    {
      // Unsigned manifest → subtle "unsigned" pill.
      const p = await newPage(context);
      await p.goto(`${ORIGIN}/app/?manifest=${encodeURIComponent(`${ORIGIN}/__fixtures__/seek.json`)}`, { waitUntil: 'load' });
      await p.waitForSelector('.p2-video-pane video', { timeout: 20000 }).catch(() => {});
      const unsigned = await p.waitForFunction(
        () => document.getElementById('sig-badge')?.classList.contains('is-unsigned'),
        { timeout: 15000 }).then(() => true).catch(() => false);
      ok('unsigned: shows a subtle "unsigned" pill', unsigned,
        await p.evaluate(() => document.getElementById('sig-badge')?.textContent || ''));
      await p.close();
    }
    {
      // Builder: sign with an Ethereum private key → signed status; tampering a
      // field after signing flags it stale.
      const p = await newPage(context);
      await p.goto(`${ORIGIN}/builder/`, { waitUntil: 'load' });
      await p.waitForSelector('.p2-form', { timeout: 15000 });
      await p.click('#mode-advanced');   // signing lives in the advanced view
      await p.click('#load-demo');
      await p.waitForFunction(() => /valid/i.test(document.getElementById('valid-badge')?.textContent || ''), { timeout: 10000 }).catch(() => {});
      await p.evaluate(() => { document.getElementById('sign-card').open = true; });   // expand the collapsed Sign card
      await p.fill('#sign-ethkey', SIGN_KEY);
      await p.click('#sign-ethkey-btn');
      const signed = await p.waitForFunction(
        () => /✓ signed \(eip191\)/.test(document.getElementById('sign-status')?.textContent || ''),
        { timeout: 10000 }).then(() => true).catch(() => false);
      ok('builder: sign with an ETH key embeds a sig + shows signed status', signed,
        await p.evaluate(() => document.getElementById('sign-status')?.textContent || ''));
      const exported = await p.evaluate(() => {
        try { const m = JSON.parse(document.querySelector('#json code').textContent); return m.sig?.alg === 'eip191' && /^0x/.test(m.sig.signature); } catch { return false; }
      });
      ok('builder: exported manifest carries the sig block', exported);
      // Edit the title → the embedded sig is now stale.
      await p.fill('#f-title', 'Edited After Signing');
      const stale = await p.waitForFunction(
        () => /re-sign/i.test(document.getElementById('sign-status')?.textContent || ''),
        { timeout: 5000 }).then(() => true).catch(() => false);
      ok('builder: editing after signing flags the sig stale', stale,
        await p.evaluate(() => document.getElementById('sign-status')?.textContent || ''));
      await p.close();
    }

    // === summary ===
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed${failed.length ? `, ${failed.length} FAILED` : ''}.`);
    console.log(`Screenshots → ${path.relative(ROOT, SHOTS)}/`);
    fs.readdirSync(SHOTS).filter((f) => f.endsWith('.png')).forEach((f) => console.log('   •', f));
    if (failed.length) process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
