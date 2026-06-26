// scripts/smoke.mjs — headless Chrome smoke test + per-protocol screenshots.
//
// Serves ./docs over a local static server (plus a few in-memory /__fixtures__/
// manifests so we can exercise provider fallback / p2p routing without shipping
// test files to Pages), drives it with Playwright (cached Chromium), and checks:
//   - the demo player mounts; app assets return 200; no same-origin console errors
//   - resolver routing: ?manifest= / ?p= / ?src=<base64 url> / ?src=<base64 inline>
//   - p2p routing: ipfs:// and magnet: sources reach a real loading/fallback state
//     (NOT the old "coming soon" stub)
//   - provider source-fallback: ipfs(dead) → mp4(local) yields a working <video>
//   - fullscreen auto-hide overlay controls (immersive class + fixed overlay)
//   - layout modes switch; subtitle CC menu present
//   - PDF demo (?p=moav-pdf): pdf.js deck renders slide 1 visibly + syncs
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
        fs.readFile(file, (e2, buf) => {
          if (e2) { res.writeHead(404).end('not found'); return; }
          res.writeHead(200, {
            'content-type': MIME[path.extname(file)] || 'application/octet-stream',
            'access-control-allow-origin': '*',
          });
          res.end(buf);
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
    // === 1. Demo loads (https/youtube), responsive widths, asset 200s ===
    const page = await newPage(context);
    const assetStatus = {};
    page.on('response', (r) => {
      const u = r.url();
      if (u.startsWith(ORIGIN)) assetStatus[u.replace(ORIGIN, '')] = r.status();
    });
    await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
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
      await p.goto(`${ORIGIN}/${query}`, { waitUntil: 'load' });
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
      await p.goto(`${ORIGIN}/?src=${encodeURIComponent(b64(JSON.stringify(inline)))}`, { waitUntil: 'load' });
      const titled = await p.waitForFunction(
        () => document.getElementById('deck-title')?.textContent === 'Inline B64 Deck',
        { timeout: 15000 }).then(() => true).catch(() => false);
      ok('routing ?src=<base64 inline manifest>: loaded', titled);
      await p.close();
    }

    // === 3. Provider source-fallback: ipfs(dead) → mp4(local) ===
    {
      const p = await newPage(context);
      await p.goto(`${ORIGIN}/?manifest=${encodeURIComponent(`${ORIGIN}/__fixtures__/fallback.json`)}`, { waitUntil: 'load' });
      const hasVideo = await p.waitForSelector('.p2-video-pane video', { timeout: 20000 })
        .then(() => true).catch(() => false);
      ok('fallback: ipfs(dead)→mp4 yields <video>', hasVideo);
      await p.waitForTimeout(500);
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

    // === 4. p2p routing reaches real loading/fallback (not "coming soon") ===
    for (const [label, src, shot] of [
      ['ipfs://', 'ipfs://bafkreideadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef/p2present.json', 'ipfs-loading.png'],
      ['magnet:', 'magnet:?xt=urn:btih:deadbeefdeadbeefdeadbeefdeadbeefdeadbeef&dn=p2present.json', 'magnet-loading.png'],
    ]) {
      const p = await newPage(context);
      await p.goto(`${ORIGIN}/`, { waitUntil: 'load' });
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
      await p.goto(`${ORIGIN}/?p=moav-pdf`, { waitUntil: 'load' });
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
      let blackOrHidden = [];
      for (let i = 0; i < 7; i++) {
        await p.click('.p2-btn[aria-label^="Next"]');
        await p.waitForTimeout(620);   // > slowest transition (slide 360ms)
        const m = await measure();
        const good = m.visible === 1 && parseFloat(m.opacity) > 0.95 && typeof m.lum === 'number' && m.lum > 8;
        if (!good) blackOrHidden.push(`${m.slide}:vis=${m.visible},op=${m.opacity},lum=${m.lum}`);
      }
      // Stress overlapping transitions, then back down — must still land clean.
      for (let i = 0; i < 4; i++) await p.click('.p2-btn[aria-label^="Next"]');
      await p.waitForTimeout(800);
      const rapid = await measure();
      const rapidGood = rapid.visible === 1 && parseFloat(rapid.opacity) > 0.95 && rapid.lum > 8;
      ok('pdf demo: 7 slides render non-blank through transitions', blackOrHidden.length === 0, blackOrHidden.join(' | '));
      ok('pdf demo: rapid overlapping transitions land on one visible slide', rapidGood, JSON.stringify(rapid));
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

    // === 6. Deep-link hash opens the player at the right time/slide ===
    {
      const p = await newPage(context);
      await p.goto(`${ORIGIN}/?p=demo#t=575&slide=13`, { waitUntil: 'load' });
      await p.waitForSelector('.p2-deck-frame', { timeout: 30000 }).catch(() => {});
      const atSlide = await p.waitForFunction(
        () => /\b13 \//.test(document.querySelector('.p2-slidecount')?.textContent || ''),
        { timeout: 15000 }).then(() => true).catch(() => false);
      ok('deeplink: #t=575&slide=13 opens at slide 13', atSlide);
      // The "this spot" share button is present + enabled.
      ok('deeplink: "this spot" share button present', await p.$('#share-spot-btn'));
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
