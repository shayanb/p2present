// host.js — the "host your assets" helper, now driven by the pluggable
// persistence-provider registry (docs/src/persist/). Pick a provider, supply the
// config it needs (tokens/endpoints — kept ONLY in this browser), upload a file,
// and get back a manifest reference (ar:// / ipfs:// / magnet: / https) you paste
// into a source in the Builder. No p2present server sees your files or tokens.
//
//   • arweave (DEFAULT) — pay-once permanent; "Make permanent" routes through the
//                         payment hook (Stripe / on-chain rent — stubbed here).
//   • pinning           — IPFS pinning service (Pinata / web3.storage).
//   • seedbox           — WebTorrent seed (in-tab + optional always-on seedbox).
//   • s3                — S3 / presigned PUT → plain https.

import {
  persistProviders, listPersistProviders, DEFAULT_PERSIST_PROVIDER,
  PaymentNotConfiguredError,
} from '../src/persist/index.js';
import { getWebTorrentClient, DEFAULT_WEBTORRENT_TRACKERS } from '../src/resolve.js';

const $ = (id) => document.getElementById(id);
const HOSTED_KEY = 'p2present:hosted';
const configKey = (id) => `p2present:persist:${id}`;

// Shared injectable deps every provider gets (browser flavours of put()'s needs).
const DEPS = {
  getWebTorrent: getWebTorrentClient,
  get payments() { return (typeof window !== 'undefined' && window.__P2_PAYMENTS) || null; },
};

let lastTorrent = null;   // in-tab seed handle, so "Stop seeding" can destroy it

// --- provider config (localStorage, per provider) ---------------------------

function loadConfig(id) {
  try { return JSON.parse(localStorage.getItem(configKey(id))) || {}; } catch { return {}; }
}
function saveConfig(id, cfg) {
  try { localStorage.setItem(configKey(id), JSON.stringify(cfg)); } catch {}
}
function currentId() { return $('persist-provider').value; }
function currentClass() { return persistProviders.get(currentId()); }

// --- UI: provider picker + dynamic fields -----------------------------------

function buildProviderOptions() {
  const sel = $('persist-provider');
  sel.innerHTML = '';
  for (const P of listPersistProviders()) {
    const o = document.createElement('option');
    o.value = P.id;
    o.textContent = P.label + (P.permanent ? '  ·  ✦ permanent' : '');
    sel.appendChild(o);
  }
  sel.value = DEFAULT_PERSIST_PROVIDER;
}

function renderProvider() {
  const P = currentClass();
  $('persist-blurb').textContent = P.blurb || '';
  $('persist-note').textContent = P.note || '';
  $('persist-action').textContent = P.action || 'Upload';
  $('persist-action').classList.toggle('is-permanent', !!P.permanent);
  $('persist-stop').hidden = true;
  $('persist-result').hidden = true;
  $('persist-status').textContent = '';
  $('persist-status').className = 'p2-status-line';

  const cfg = loadConfig(P.id);
  const box = $('persist-fields');
  box.innerHTML = '';
  for (const f of P.fields) {
    box.appendChild(fieldEl(f, cfg[f.key]));
  }
  // Seedbox: prefill trackers with the defaults when nothing saved yet.
  if (P.id === 'seedbox') {
    const t = $('pf-trackers');
    if (t && !t.value) t.value = DEFAULT_WEBTORRENT_TRACKERS.join('\n');
  }
  $('config-state').textContent = Object.keys(cfg).length ? 'Config saved in this browser.' : '';
}

function fieldEl(f, value) {
  const label = document.createElement('label');
  label.className = 'p2-field';
  const span = document.createElement('span');
  span.textContent = f.label + (f.optional ? ' (optional)' : '');
  label.appendChild(span);

  let input;
  if (f.type === 'select') {
    input = document.createElement('select');
    for (const opt of f.options || []) {
      const o = document.createElement('option');
      o.value = opt.value; o.textContent = opt.label;
      input.appendChild(o);
    }
    input.value = value ?? f.default ?? (f.options?.[0]?.value || '');
  } else if (f.type === 'textarea') {
    input = document.createElement('textarea');
    input.rows = 3; input.spellcheck = false;
    input.value = value ?? f.default ?? '';
  } else {
    input = document.createElement('input');
    input.type = f.type === 'password' ? 'password' : 'text';
    input.autocomplete = 'off'; input.spellcheck = false;
    if (f.placeholder) input.placeholder = f.placeholder;
    input.value = value ?? f.default ?? '';
  }
  input.id = `pf-${f.key}`;
  input.dataset.key = f.key;
  label.appendChild(input);
  return label;
}

function collectConfig() {
  const cfg = {};
  for (const el of $('persist-fields').querySelectorAll('[data-key]')) {
    const v = (el.value ?? '').trim ? el.value.trim() : el.value;
    if (v !== '') cfg[el.dataset.key] = v;
  }
  return cfg;
}

// --- upload -----------------------------------------------------------------

async function doUpload() {
  const P = currentClass();
  const cfg = collectConfig();
  const file = $('persist-file').files?.[0];
  const status = $('persist-status');
  if (!file) { status.textContent = 'Choose a file first.'; return; }

  $('persist-action').disabled = true;
  status.className = 'p2-status-line';
  status.textContent = 'Working…';
  try {
    const inst = new (persistProviders.get(P.id))(cfg, DEPS);
    const result = await inst.put(file, { onProgress: (m) => { status.textContent = m; } });
    status.textContent = P.permanent ? 'Stored permanently ✓' : 'Done ✓';
    showResult(result);
    addHosted({ kind: result.scheme, ref: result.ref, name: result.name || file.name });

    // Seedbox keeps seeding in this tab — offer a stop button + peer count.
    if (result.extra?.torrent) {
      lastTorrent = result.extra.torrent;
      $('persist-stop').hidden = false;
    }
  } catch (err) {
    if (err instanceof PaymentNotConfiguredError) {
      // Expected, actionable guidance — not a failure of the app.
      status.className = 'p2-status-line is-note';
      status.textContent = err.message;
    } else {
      status.className = 'p2-status-line is-error';
      status.textContent = err.message || String(err);
    }
  } finally {
    $('persist-action').disabled = false;
  }
}

function stopSeeding() {
  try { lastTorrent?.destroy(); } catch {}
  lastTorrent = null;
  $('persist-stop').hidden = true;
  $('persist-status').textContent = 'Stopped seeding.';
}

function showResult(r) {
  const box = $('persist-result');
  box.hidden = false;
  box.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'p2-result-head';
  head.innerHTML = `<span class="p2-tag">${escapeHtml(r.scheme)}</span>` +
    (r.permanent ? '<span class="p2-tag p2-tag-perm">permanent ✦</span>' : '') +
    (r.extra?.alwaysOn ? '<span class="p2-tag">always-on</span>' : '');
  box.append(head, resultRow('Manifest reference', r.ref, true));
  if (r.gateway) box.append(linkRow('Gateway preview', r.gateway));
  if (r.scheme === 'magnet') {
    const peers = document.createElement('p');
    peers.className = 'p2-hint'; peers.id = 'wt-peers';
    peers.textContent = '0 peer(s) connected';
    box.append(peers);
    if (r.extra?.torrent) {
      const t = r.extra.torrent;
      const upd = () => { const el = $('wt-peers'); if (el) el.textContent = `${t.numPeers} peer(s) connected`; };
      t.on?.('wire', upd); upd();
    }
  }
}

// --- hosted references (handoff to builder) ---------------------------------

function getHosted() {
  try { return JSON.parse(localStorage.getItem(HOSTED_KEY)) || []; } catch { return []; }
}
function addHosted(entry) {
  const list = getHosted();
  if (!list.some((e) => e.ref === entry.ref)) {
    list.unshift({ ...entry, ts: Date.now() });
    try { localStorage.setItem(HOSTED_KEY, JSON.stringify(list.slice(0, 50))); } catch {}
  }
  renderHosted();
}
function renderHosted() {
  const list = getHosted();
  $('hosted-card').hidden = list.length === 0;
  const box = $('hosted-list');
  box.innerHTML = '';
  for (const e of list) {
    const row = document.createElement('div');
    row.className = 'p2-hosted-row';
    const meta = document.createElement('div');
    meta.className = 'p2-hosted-meta';
    meta.innerHTML = `<span class="p2-tag">${escapeHtml(e.kind)}</span> <span class="p2-hosted-name">${escapeHtml(e.name || '')}</span>`;
    const code = document.createElement('code');
    code.className = 'p2-hosted-ref'; code.textContent = e.ref;
    row.append(meta, code, copyButton(e.ref));
    box.appendChild(row);
  }
}

// --- shared UI helpers ------------------------------------------------------

function resultRow(label, value, mono) {
  const row = document.createElement('div');
  row.className = 'p2-result-row';
  const l = document.createElement('span'); l.className = 'p2-result-label'; l.textContent = label;
  const v = document.createElement('code'); v.className = mono ? 'p2-result-val is-ref' : 'p2-result-val'; v.textContent = value;
  row.append(l, v, copyButton(value));
  return row;
}
function linkRow(label, url) {
  const row = document.createElement('div');
  row.className = 'p2-result-row';
  const l = document.createElement('span'); l.className = 'p2-result-label'; l.textContent = label;
  const a = document.createElement('a'); a.className = 'p2-result-val'; a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = url;
  row.append(l, a);
  return row;
}
function copyButton(text) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'p2-load p2-copy'; b.textContent = '📋'; b.title = 'Copy';
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); b.textContent = '✓'; setTimeout(() => (b.textContent = '📋'), 1200); }
    catch { b.textContent = '✗'; setTimeout(() => (b.textContent = '📋'), 1200); }
  });
  return b;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// --- wire up ----------------------------------------------------------------

function init() {
  buildProviderOptions();
  $('persist-provider').addEventListener('change', renderProvider);
  renderProvider();

  $('config-save').addEventListener('click', () => {
    saveConfig(currentId(), collectConfig());
    $('config-state').textContent = 'Config saved in this browser.';
  });
  $('config-clear').addEventListener('click', () => {
    try { localStorage.removeItem(configKey(currentId())); } catch {}
    renderProvider();
    $('config-state').textContent = 'Config cleared.';
  });

  $('persist-action').addEventListener('click', doUpload);
  $('persist-stop').addEventListener('click', stopSeeding);
  $('hosted-clear').addEventListener('click', () => { try { localStorage.removeItem(HOSTED_KEY); } catch {} renderHosted(); });

  renderHosted();
}

init();
