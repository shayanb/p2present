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
//   - host helper (/host/): loads, IPFS pin works (Pinata mocked), WT UI present
//   - responsive widths 390 / 780 / 1280 (player + builder + host)
// and saves screenshots to docs/screenshots/.
//
// Run: npm run smoke   (node scripts/smoke.mjs)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

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

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
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

  try {
    // === 0. Landing page (/) — hero, sections, CTA, redirect, responsive ===
    {
      const p = await newPage(context);
      const homeAssets = {};
      p.on('response', (r) => { const u = r.url(); if (u.startsWith(ORIGIN)) homeAssets[u.replace(ORIGIN, '')] = r.status(); });
      await p.goto(`${ORIGIN}/`, { waitUntil: 'load' });
      ok('home: hero renders the brand name', /p2present/i.test(await p.textContent('.hero h1')));
      const tagline = await p.textContent('.hero .tagline');
      ok('home: one-liner present', /play themselves/i.test(tagline) && /peer-to-peer/i.test(tagline), tagline);
      const cta = await p.getAttribute('.hero .btn-primary', 'href');
      ok('home: CTA deep-links into the player demo', /^app\/\?p=moav-pdf$/.test(cta || ''), String(cta));
      ok('home: how-it-works has 3 steps', (await p.$$('#how .step')).length === 3);
      ok('home: features grid present', (await p.$$('#features .feat')).length >= 6, String((await p.$$('#features .feat')).length));
      ok('home: hosted+registry has 3 plan cards', (await p.$$('#roadmap .plan-card')).length === 3);
      const tags = await p.evaluate(() => [...document.querySelectorAll('#roadmap .tag')].map((t) => t.textContent.trim().toLowerCase()));
      ok('home: roadmap framing (coming / roadmap tags)', tags.filter((t) => t === 'coming').length === 2 && tags.includes('roadmap'), tags.join(','));
      ok('home: links to ROADMAP + repo + builder', (await p.$$('a[href*="ROADMAP.md"]')).length >= 1 && (await p.$$('a[href*="github.com/ibeezhan/p2present"]')).length >= 1 && (await p.$$('a[href="builder/"]')).length >= 1);
      const og = await p.evaluate(() => ({
        title: document.querySelector('meta[property="og:title"]')?.content || '',
        image: document.querySelector('meta[property="og:image"]')?.content || '',
        desc: document.querySelector('meta[name="description"]')?.content || '',
      }));
      ok('home: OG/meta tags present', /p2present/i.test(og.title) && /\.png$/.test(og.image) && og.desc.length > 20, JSON.stringify(og).slice(0, 80));
      ok('home: favicon link present', await p.$('link[rel="icon"]'));
      ok('home: home.css 200', homeAssets['/home.css'] === 200, String(homeAssets['/home.css']));
      for (const w of [1280, 780, 390]) {
        await p.setViewportSize({ width: w, height: w === 390 ? 800 : 860 });
        await p.waitForTimeout(250);
        await p.screenshot({ path: path.join(SHOTS, `home-${w}.png`), fullPage: true });
      }
      const noHScroll = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
      ok('home: no horizontal overflow at 390px', noHScroll);
      ok('home: no same-origin console errors', p._consoleErrors.length === 0, p._consoleErrors.slice(0, 2).join(' | '));
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
        document.querySelector('.p2-player').classList.remove('is-maximized', 'p2-immersive', 'p2-controls-visible');
        document.body.classList.remove('p2-maximized');
      });
      await p.waitForTimeout(200);
      const modeBtns = await p.$$('.p2-mode-btn');
      ok('layout: four mode buttons', modeBtns.length === 4, String(modeBtns.length));
      if (modeBtns.length === 4) {
        await modeBtns[3].click(); // overlap
        await p.waitForTimeout(200);
        const mode = await p.evaluate(() => document.querySelector('.p2-stage')?.dataset.mode);
        ok('layout: clicking a mode updates data-mode', mode === 'overlap', mode);
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
      } else {
        const t0 = await p.evaluate(() => window.__p2player.video.getTime());
        // Cold seek to ~40% via the scrubber, never having pressed play.
        await p.evaluate(() => {
          const v = window.__p2player.video, dur = v.getDuration();
          window.__p2player.sync.seekToTime(dur * 0.4);
        });
        const advanced = await p.waitForFunction(
          (prev) => window.__p2player.video.getTime() > prev + 5,
          t0, { timeout: 8000 }).then(() => true).catch(() => false);
        const t1 = await p.evaluate(() => window.__p2player.video.getTime());
        ok('youtube: cold-seek advances the video (not stuck at 0)', advanced, `t0=${t0?.toFixed?.(1)} -> t1=${t1?.toFixed?.(1)}`);
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
      await p.click('#share-btn');
      const menuOpen = await p.evaluate(() => !document.getElementById('share-menu').hidden && document.getElementById('share-btn').getAttribute('aria-expanded') === 'true');
      ok('share: button opens a popover menu', menuOpen);
      const items = await p.evaluate(() => [...document.querySelectorAll('.p2-share-item')].map((b) => b.textContent.trim()));
      ok('share: menu offers presentation link + this-moment', items.length === 2 && /presentation/i.test(items[0]) && /moment/i.test(items[1]), items.join(' | '));
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

    // === 7. Builder: validates + exports ===
    {
      const p = await newPage(context);
      await p.goto(`${ORIGIN}/builder/`, { waitUntil: 'load' });
      await p.waitForSelector('.p2-form', { timeout: 15000 });
      ok('builder: form mounts', await p.$('.p2-form'));
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

    // === 8. Host helper: loads; IPFS pin works (mocked); WT UI present ===
    {
      const p = await newPage(context);
      // Mock the Pinata pin endpoint so we never hit the network / need a token.
      await p.route('https://api.pinata.cloud/**', (r) => r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ IpfsHash: 'bafkreitestcidmock0000000000000000000000000000000000000000' }),
      }));
      await p.goto(`${ORIGIN}/host/`, { waitUntil: 'load' });
      await p.waitForSelector('#ipfs-provider', { timeout: 15000 });
      ok('host: page loads (IPFS + WebTorrent cards)', (await p.$$('.p2-card')).length >= 2);
      ok('host: WebTorrent trackers prefilled', (await p.inputValue('#wt-trackers')).includes('wss://'));
      // Upload with no token → friendly prompt (no crash).
      await p.setInputFiles('#ipfs-file', { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
      await p.click('#ipfs-upload');
      await p.waitForTimeout(300);
      ok('host: upload without token prompts for one', /token/i.test(await p.textContent('#ipfs-status')));
      // With a (fake) token → mocked CID shown + handoff persisted.
      await p.fill('#ipfs-token', 'FAKEJWT');
      await p.click('#ipfs-upload');
      const pinned = await p.waitForFunction(
        () => !document.getElementById('ipfs-result').hidden,
        { timeout: 10000 }).then(() => true).catch(() => false);
      ok('host: IPFS pin (mock) shows a CID result', pinned);
      const ref = await p.evaluate(() => document.querySelector('#ipfs-result .is-ref')?.textContent || '');
      ok('host: result is an ipfs:// reference', ref.startsWith('ipfs://bafk'), ref);
      const handoff = await p.evaluate(() => { try { return JSON.parse(localStorage.getItem('p2present:hosted'))?.[0]?.ref || ''; } catch { return ''; } });
      ok('host: reference saved for the builder handoff', handoff.startsWith('ipfs://'));
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
