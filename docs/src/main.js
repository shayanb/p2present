// main.js — the resolver host. Turns a *source* into a running player, where a
// source can be an https URL, an ipfs:// CID, a magnet: link, an inline manifest,
// or a bundled local presentation. With no source it loads the bundled demo.
//
// Boot resolution order (first match wins):
//   1. ?src=<base64>   — decoded value is EITHER an inline p2present.json
//                        OR a source URL/CID/magnet (auto-detected).
//   2. ?manifest=<url> — load a p2present.json from any provider (https/ipfs/magnet).
//   3. ?p=<name>       — a bundled local manifest at content/<name>/manifest.json.
//   4. ?demo           — alias for the bundled MoaV PDF demo (?p=moav-pdf).
//   5. DEFAULT_SOURCE  — the bundled HTML demo.
//
// The source box routes whatever you type through ?manifest=. The "Share" button
// builds a self-contained ?src=<base64> link for the current presentation.
//
// The player lives at /app/ but its bundled content (content/…) sits at the docs
// ROOT, so every bundled path is resolved against ROOT (derived from this module's
// URL) rather than the page — keeping the player path-independent.

import { loadPresentation } from './manifest.js';
import { encodeBase64, decodeBase64 } from './resolve.js';
import { Player } from './player.js';
import { saveManifest, manifestApiUrl, shareUrl, serviceBase } from './service.js';
import { verifyManifest, describeSigner } from './sign.js';

// Bundled local demos resolve to content/<name>/manifest.json; any OTHER ?p=
// value is treated as a *service id* and loaded from the pastebin backend.
const BUNDLED = new Set(['demo', 'moav-pdf']);

// This module is docs/src/main.js, so '../' is the docs root that holds content/.
const ROOT = new URL('../', import.meta.url).href;
const DEFAULT_SOURCE = 'content/demo/manifest.json';   // relative to ROOT

const $src = document.getElementById('source-input');
const $form = document.getElementById('source-form');
const $app = document.getElementById('app');
const $status = document.getElementById('status');
const $title = document.getElementById('deck-title');
const $header = document.querySelector('.p2-header');
const $shellToggle = document.getElementById('shell-toggle');
const $sourceToggle = document.getElementById('source-toggle');
const $share = document.getElementById('share-btn');
const $shareMenu = document.getElementById('share-menu');
const $shareWhole = document.getElementById('share-whole');
const $shareMoment = document.getElementById('share-moment');
const $save = document.getElementById('save-btn');
const $sigBadge = document.getElementById('sig-badge');

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
let currentRaw = null; // the raw manifest currently playing (for "Save & share")
let statusSeq = 0;
let activeStatus = null;

function setStatus(msg, isError = false, opts = {}) {
  if (!$status) return;
  if (!msg) {
    $status.innerHTML = '';
    activeStatus = null;
    return;
  }
  const kind = isError ? 'error' : (opts.working ? 'working' : 'note');
  const item = document.createElement('div');
  item.className = `p2-status-item is-${kind}`;
  item.dataset.statusId = String(++statusSeq);
  item.innerHTML =
    `<span class="p2-status-dot" aria-hidden="true"></span>` +
    `<span class="p2-status-text"></span>` +
    (isError ? `<button class="p2-status-close" type="button" aria-label="Close status">×</button>` : '');
  item.querySelector('.p2-status-text').textContent = msg;
  if (isError) item.querySelector('.p2-status-close')?.addEventListener('click', () => dismissStatus(item));
  $status.replaceChildren(item);
  activeStatus = item;
  if (!isError && !opts.working) {
    const timeout = opts.timeout ?? 3600;
    window.setTimeout(() => { if (item.isConnected && activeStatus === item) dismissStatus(item); }, timeout);
  }
}

function dismissStatus(item) {
  item.classList.add('is-leaving');
  window.setTimeout(() => {
    if (item.isConnected) item.remove();
    if (activeStatus === item) activeStatus = null;
  }, 280);
}

// Bundled content paths resolve against the docs ROOT (not the /app/ page URL).
function absolute(rel) {
  try { return new URL(rel, ROOT).href; } catch { return rel; }
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

  // ?p=<name|id>, the /p/<id> path form (when served behind the Worker domain),
  // or the ?demo alias for the bundled MoaV PDF demo.
  let p = q.get('p');
  if (!p) { const m = window.location.pathname.match(/\/p\/([\w.-]+)\/?$/); if (m) p = m[1]; }
  if (!p && q.has('demo')) p = 'moav-pdf';
  if (p && /^[\w.-]+$/.test(p)) {
    if (BUNDLED.has(p)) {
      const url = absolute(`content/${p}/manifest.json`);   // bundled local demo
      return { source: url, share: url, display: '' };
    }
    // Otherwise it's a saved presentation id → fetch it from the service. Share
    // the pretty /p/<id> link; load via the JSON API endpoint.
    return { source: manifestApiUrl(p), share: manifestApiUrl(p), display: '', shortLink: shareUrl(p) };
  }

  const def = absolute(DEFAULT_SOURCE);
  return { source: def, share: def, display: '' };
}

async function run({ source, share, display }) {
  setStatus('Loading…', false, { working: true });
  if (player) { try { player.destroy(); } catch {} player = null; }
  $app.innerHTML = '<div class="p2-empty">Loading…</div>';
  shareValue = share || '';
  currentRaw = null;
  if ($save) $save.disabled = true;
  if ($sigBadge) { sigToken++; $sigBadge.hidden = true; }   // drop any stale badge / in-flight ENS
  if (typeof display === 'string') $src.value = display;
  try {
    const manifest = await loadPresentation(source);
    currentRaw = manifest._raw || null;
    $title.textContent = manifest.title;
    document.title = `${manifest.title} · p2present`;
    $app.innerHTML = '';
    player = new Player(manifest, $app);
    await player.mount();
    // Expose the live player for debugging + headless tests (read-only handle).
    window.__p2player = player;
    const deep = parseDeepLink();
    if (deep) { try { player.applyDeepLink(deep); } catch (e) { console.warn(e); } }
    renderSignature(manifest._raw || currentRaw);   // async; never blocks playback
    setStatus('');
    if ($share) $share.disabled = false;
    if ($save) $save.disabled = !currentRaw;
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), true);
    $app.innerHTML = `<div class="p2-empty">⚠️ ${escapeHtml(err.message || String(err))}</div>`;
  }
}

// Verify the manifest's author signature (Phase 8) and reflect it in a header
// badge: "✓ signed by <ENS/domain/0x…>" when valid, a subtle "unsigned" pill
// otherwise, "⚠ signature invalid" if a sig is present but doesn't verify. This
// runs AFTER the player mounts and NEVER blocks playback — a bad/absent sig is
// purely informational. ENS reverse-resolution upgrades the label when it lands.
let sigToken = 0;
async function renderSignature(raw) {
  if (!$sigBadge) return;
  const token = ++sigToken;
  $sigBadge.hidden = false;
  $sigBadge.className = 'p2-sig-badge is-checking';
  $sigBadge.textContent = '…';
  $sigBadge.title = 'Checking signature…';

  let result;
  try { result = await verifyManifest(raw || {}); }
  catch { result = { state: 'unsigned' }; }
  if (token !== sigToken) return;   // another presentation loaded meanwhile

  if (result.state === 'unsigned') {
    $sigBadge.className = 'p2-sig-badge is-unsigned';
    $sigBadge.textContent = 'unsigned';
    $sigBadge.title = 'This presentation carries no author signature.';
    return;
  }
  if (result.state === 'invalid') {
    $sigBadge.className = 'p2-sig-badge is-invalid';
    $sigBadge.textContent = '⚠ signature invalid';
    $sigBadge.title = `A signature is present but does not verify: ${result.reason || 'mismatch'}.`;
    return;
  }

  // Valid — show an instant label (abbreviated address / domain / key), then
  // upgrade an Ethereum address to its ENS name if reverse-resolution succeeds.
  const quick = await describeSigner(result, { resolveEns: false });
  if (token !== sigToken) return;
  $sigBadge.className = 'p2-sig-badge is-valid';
  $sigBadge.textContent = `✓ signed by ${quick.label}`;
  $sigBadge.title = `Signature verified (${result.alg}).` +
    (quick.address ? ` Address ${quick.address}` : '');
  // ENS reverse-resolution hits a public RPC; on by default, off when a host sets
  // window.__P2_ENS === false (tests / offline / privacy).
  const ensOn = !(typeof window !== 'undefined' && window.__P2_ENS === false);
  if (ensOn && result.alg === 'eip191' && quick.kind === 'address') {
    describeSigner(result, { resolveEns: true }).then((full) => {
      if (token !== sigToken || full.kind !== 'ens') return;
      $sigBadge.textContent = `✓ signed by ${full.label}`;
      $sigBadge.classList.add('has-ens');
      $sigBadge.title = `Signature verified (eip191). ENS ${full.label} → ${full.address}`;
    }).catch(() => {});
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
    setStatus('Share link: ' + link, false, { timeout: 8000 });
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

// "Save & share" — POST the current manifest to the pastebin backend and get a
// short p2present.com/p/<id> link back (copied to the clipboard). The edit token
// is kept in this browser (see service.js) so the author can update it later.
async function saveAndShare() {
  if (!currentRaw) { setStatus('Nothing to save yet.', true); return; }
  const base = serviceBase();
  $save.disabled = true;
  setStatus(`Saving to ${base}…`, false, { working: true });
  try {
    const { id, url } = await saveManifest(currentRaw, { visibility: 'unlisted' });
    const link = url || shareUrl(id);
    try {
      await navigator.clipboard.writeText(link);
      setStatus(`Saved. Short link copied: ${link}`, false, { timeout: 6000 });
    } catch {
      setStatus(`Saved. Share link: ${link}`, false, { timeout: 9000 });
    }
  } catch (err) {
    setStatus(err.message || String(err), true);
  } finally {
    $save.disabled = !currentRaw;
  }
}
if ($save) $save.addEventListener('click', saveAndShare);
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

if ($shellToggle) {
  const setShellState = ({ collapsed, pinned = false }) => {
    $header.classList.toggle('p2-shell-collapsed', collapsed);
    $header.classList.toggle('p2-shell-pinned', pinned);
    const expanded = !collapsed || pinned;
    $shellToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    $shellToggle.title = expanded ? 'Collapse player header controls' : 'Show player header controls';
    $shellToggle.setAttribute('aria-label', $shellToggle.title);
  };
  $shellToggle.addEventListener('click', () => {
    const collapsed = $header.classList.contains('p2-shell-collapsed');
    const pinned = $header.classList.contains('p2-shell-pinned');
    if (!collapsed) setShellState({ collapsed: true });
    else setShellState({ collapsed: true, pinned: !pinned });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      setShellState({ collapsed: $header.classList.contains('p2-shell-collapsed') });
      $header.classList.remove('p2-source-open');
      $sourceToggle.setAttribute('aria-expanded', 'false');
    }
  });
}

// Highlight the active demo in the nav (default boot === the html demo).
(function markActiveDemo() {
  const q = new URLSearchParams(window.location.search);
  const hasOtherSource = q.has('src') || q.has('manifest');
  const active = hasOtherSource ? null
    : (q.get('p') || (q.has('demo') ? 'moav-pdf' : 'demo'));
  document.querySelectorAll('.p2-nav-link[data-demo]').forEach((a) => {
    a.classList.toggle('is-active', a.dataset.demo === active);
  });
})();

// Boot.
if ($share) $share.disabled = true;
if ($save) $save.disabled = true;
run(parseBootSource());

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
