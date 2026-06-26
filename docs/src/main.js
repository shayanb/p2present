// main.js — the resolver host. A thin loader that turns a "source" (today: an
// https URL to a manifest.json; phase 2: WebTorrent magnet / IPFS CID) into a
// running player. With no source it falls back to the bundled demo, so visitors
// immediately see slides + video in sync.
//
// Source resolution order:
//   1. ?src=<url>  query parameter
//   2. the value typed into the source box (updates ?src= and reloads the player)
//   3. DEFAULT_SOURCE — the bundled demo manifest

import { loadManifest } from './manifest.js';
import { Player } from './player.js';

const DEFAULT_SOURCE = 'content/demo/manifest.json';

const $src = document.getElementById('source-input');
const $form = document.getElementById('source-form');
const $app = document.getElementById('app');
const $status = document.getElementById('status');
const $title = document.getElementById('deck-title');
const $header = document.querySelector('.p2-header');
const $sourceToggle = document.getElementById('source-toggle');

let player = null;

function setStatus(msg, isError = false) {
  $status.textContent = msg || '';
  $status.classList.toggle('is-error', !!isError);
}

/** Translate a raw source string into a fetchable manifest URL (phase 1: http(s)). */
function resolveSource(source) {
  const s = (source || '').trim();
  if (!s) return DEFAULT_SOURCE;
  if (/^magnet:/i.test(s)) {
    throw new Error('WebTorrent magnets are a phase-2 feature (resolver stub). Coming soon.');
  }
  if (/^(ipfs:\/\/|baf[a-z0-9]{20,}|Qm[a-zA-Z0-9]{44})/.test(s)) {
    throw new Error('IPFS CIDs are a phase-2 feature (resolver stub). Coming soon.');
  }
  // Otherwise treat as an http(s) URL (absolute or relative).
  return s;
}

async function run(source) {
  setStatus('Loading…');
  if (player) { try { player.destroy(); } catch {} player = null; }
  $app.innerHTML = '';
  try {
    const manifestUrl = resolveSource(source);
    const manifest = await loadManifest(manifestUrl);
    $title.textContent = manifest.title;
    document.title = `${manifest.title} · p2present`;
    player = new Player(manifest, $app);
    await player.mount();
    setStatus('');
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), true);
    $app.innerHTML = `<div class="p2-empty">⚠️ ${escapeHtml(err.message || String(err))}</div>`;
  }
}

$form.addEventListener('submit', (e) => {
  e.preventDefault();
  const val = $src.value.trim();
  const url = new URL(window.location.href);
  if (val) url.searchParams.set('src', val); else url.searchParams.delete('src');
  history.replaceState(null, '', url);
  $header.classList.remove('p2-source-open');   // collapse the bar after loading
  $sourceToggle.setAttribute('aria-expanded', 'false');
  run(val);
});

// Mobile: the source bar is collapsed by default behind a small disclosure
// button so the player gets the vertical room. Tapping it reveals the form.
$sourceToggle.addEventListener('click', () => {
  const open = $header.classList.toggle('p2-source-open');
  $sourceToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) $src.focus();
});

// Boot: honour ?src= if present, else load the demo.
const initial = new URLSearchParams(window.location.search).get('src') || '';
if (initial) $src.value = initial;
run(initial);

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
