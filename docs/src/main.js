// main.js — the resolver host. Turns a *source* into a running player, where a
// source can be an https URL, an ipfs:// CID, a magnet: link, an inline manifest,
// or a bundled local presentation. With no source it loads the bundled demo.
//
// Boot resolution order (first match wins):
//   1. ?src=<base64>   — decoded value is EITHER an inline p2present.json
//                        OR a source URL/CID/magnet (auto-detected).
//   2. ?manifest=<url> — load a p2present.json from any provider (https/ipfs/magnet).
//   3. ?p=<name>       — a bundled local manifest at content/<name>/manifest.json.
//   4. DEFAULT_SOURCE  — the bundled demo.
//
// The source box routes whatever you type through ?manifest=. The "Share" button
// builds a self-contained ?src=<base64> link for the current presentation.

import { loadPresentation } from './manifest.js';
import { encodeBase64, decodeBase64 } from './resolve.js';
import { Player } from './player.js';

const DEFAULT_SOURCE = 'content/demo/manifest.json';

const $src = document.getElementById('source-input');
const $form = document.getElementById('source-form');
const $app = document.getElementById('app');
const $status = document.getElementById('status');
const $title = document.getElementById('deck-title');
const $header = document.querySelector('.p2-header');
const $sourceToggle = document.getElementById('source-toggle');
const $share = document.getElementById('share-btn');
const $shareMenu = document.getElementById('share-menu');
const $shareWhole = document.getElementById('share-whole');
const $shareMoment = document.getElementById('share-moment');

/** Parse a deep-link hash like "#t=125&slide=7" → {t, slide} (or null). */
function parseDeepLink() {
  const h = window.location.hash.replace(/^#/, '');
  if (!h) return null;
  const q = new URLSearchParams(h);
  const out = {};
  if (q.has('t')) { const t = parseFloat(q.get('t')); if (Number.isFinite(t)) out.t = t; }
  if (q.has('slide')) { const s = parseInt(q.get('slide'), 10); if (Number.isFinite(s)) out.slide = s; }
  return (out.t != null || out.slide != null) ? out : null;
}

let player = null;
let shareValue = '';   // the string a Share link should base64-encode

function setStatus(msg, isError = false) {
  $status.textContent = msg || '';
  $status.classList.toggle('is-error', !!isError);
}

function absolute(rel) {
  try { return new URL(rel, window.location.href).href; } catch { return rel; }
}

/** Work out what to load from the URL query (see header comment for order). */
function parseBootSource() {
  const q = new URLSearchParams(window.location.search);

  const b64 = q.get('src');
  if (b64) {
    let decoded = '';
    try { decoded = decodeBase64(b64).trim(); } catch { decoded = ''; }
    if (decoded.startsWith('{')) {
      try {
        const obj = JSON.parse(decoded);
        return { source: obj, share: decoded, display: '' };
      } catch { /* not JSON — treat as a source string below */ }
    }
    if (decoded) return { source: decoded, share: decoded, display: decoded };
  }

  const manifest = q.get('manifest');
  if (manifest) return { source: manifest, share: manifest, display: manifest };

  const p = q.get('p');
  if (p && /^[\w.-]+$/.test(p)) {
    const url = `content/${p}/manifest.json`;
    return { source: url, share: absolute(url), display: '' };
  }

  return { source: DEFAULT_SOURCE, share: absolute(DEFAULT_SOURCE), display: '' };
}

async function run({ source, share, display }) {
  setStatus('Loading…');
  if (player) { try { player.destroy(); } catch {} player = null; }
  $app.innerHTML = '<div class="p2-empty">Loading…</div>';
  shareValue = share || '';
  if (typeof display === 'string') $src.value = display;
  try {
    const manifest = await loadPresentation(source);
    $title.textContent = manifest.title;
    document.title = `${manifest.title} · p2present`;
    $app.innerHTML = '';
    player = new Player(manifest, $app);
    await player.mount();
    // Expose the live player for debugging + headless tests (read-only handle).
    window.__p2player = player;
    const deep = parseDeepLink();
    if (deep) { try { player.applyDeepLink(deep); } catch (e) { console.warn(e); } }
    setStatus('');
    if ($share) $share.disabled = false;
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), true);
    $app.innerHTML = `<div class="p2-empty">⚠️ ${escapeHtml(err.message || String(err))}</div>`;
  }
}

// Typed source → route through ?manifest= (accepts https / ipfs:// / magnet:).
$form.addEventListener('submit', (e) => {
  e.preventDefault();
  const val = $src.value.trim();
  const url = new URL(window.location.href);
  url.searchParams.delete('src');
  url.searchParams.delete('p');
  if (val) url.searchParams.set('manifest', val); else url.searchParams.delete('manifest');
  history.replaceState(null, '', url);
  $header.classList.remove('p2-source-open');   // collapse the bar after loading
  $sourceToggle.setAttribute('aria-expanded', 'false');
  run(val ? { source: val, share: val, display: val } : parseBootSource());
});

// Build a self-contained ?src=<base64> share link for the current presentation
// and copy it to the clipboard. `withSpot` appends a #t=…&slide=… deep-link.
async function copyShareLink(withSpot) {
  if (!shareValue) return;
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('src', encodeBase64(shareValue));
  if (withSpot && player) {
    const { t, slide } = player.spot();
    url.hash = `t=${t}&slide=${slide}`;
  }
  const link = url.href;
  try {
    await navigator.clipboard.writeText(link);
    setStatus(withSpot ? 'Link to this moment copied to clipboard.' : 'Presentation link copied to clipboard.');
  } catch {
    // Clipboard blocked (insecure context / permissions) — surface the link.
    setStatus('Share link: ' + link);
  }
  history.replaceState(null, '', link);
}

// Share is a small popover (YouTube-style): "copy presentation link" vs "copy
// link to this moment" (the current #t=…&slide=… deep-link).
function openShareMenu(open) {
  if (!$shareMenu || !$share) return;
  $shareMenu.hidden = !open;
  $share.setAttribute('aria-expanded', open ? 'true' : 'false');
}
if ($share) {
  $share.addEventListener('click', (e) => {
    e.preventDefault();
    if ($share.disabled) return;
    openShareMenu($shareMenu.hidden);
  });
}
if ($shareWhole) $shareWhole.addEventListener('click', () => { copyShareLink(false); openShareMenu(false); });
if ($shareMoment) $shareMoment.addEventListener('click', () => { copyShareLink(true); openShareMenu(false); });
// Close the popover on outside click or Escape.
document.addEventListener('click', (e) => {
  if (!$shareMenu || $shareMenu.hidden) return;
  if (!e.target.closest('.p2-share-wrap')) openShareMenu(false);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openShareMenu(false); });

// Mobile: the source bar is collapsed by default behind a small disclosure
// button so the player gets the vertical room. Tapping it reveals the form.
$sourceToggle.addEventListener('click', () => {
  const open = $header.classList.toggle('p2-source-open');
  $sourceToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) $src.focus();
});

// Highlight the active demo in the nav (default boot === the html demo).
(function markActiveDemo() {
  const q = new URLSearchParams(window.location.search);
  const hasOtherSource = q.has('src') || q.has('manifest');
  const active = hasOtherSource ? null : (q.get('p') || 'demo');
  document.querySelectorAll('.p2-nav-link[data-demo]').forEach((a) => {
    a.classList.toggle('is-active', a.dataset.demo === active);
  });
})();

// Boot.
if ($share) $share.disabled = true;
run(parseBootSource());

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
