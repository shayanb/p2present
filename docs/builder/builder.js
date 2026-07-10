// builder.js — the visual p2present.json manifest builder / editor.
//
// A form drives a single `state` object; every change rebuilds the manifest,
// re-renders the live JSON, and re-validates it against the real schema file
// (../p2present.schema.json) via the dependency-free validator. Actions export
// the manifest (download / copy / open-in-player ?src=base64). A timing-capture
// panel mounts the real Player so you can stamp the current video time against
// the current slide to build the timing[] quickly.

import { encodeBase64 } from '../src/resolve.js';
import { normaliseManifest, loadPresentation } from '../src/manifest.js';
import { validate } from '../src/schema-validate.js';
import { Player } from '../src/player.js';
import {
  signEip191WithKey, signEip191WithWallet, signEd25519, generateEd25519,
  signingString, describeSigner, abbreviateAddress,
} from '../src/sign.js';

const $ = (id) => document.getElementById(id);

// --- state ------------------------------------------------------------------

function blankState() {
  return {
    title: '',
    meta: { author: '', event: '', date: '', description: '' },
    video: { sources: [{ provider: 'youtube', src: '' }], poster: '' },
    deck: { type: 'html', sources: [{ protocol: 'https', src: '' }], slideCount: '' },
    timing: [{ time: 0, slide: 1, transition: 'cut', label: '' }],
    subtitles: [],
    resolvers: { ipfsGateways: [], webtorrentTrackers: [] },
    layout: { split: 0.6, mode: 'split', transition: 'fade' },
    sig: null,          // the embedded `sig` block once signed
    sigPayload: null,   // the exact canonical string signed (for staleness detection)
  };
}

let state = blankState();
let schema = null;

// --- build a clean manifest object from state -------------------------------

function buildManifest(s) {
  const m = { p2present: '1.0' };
  if (s.title) m.title = s.title;

  const meta = {};
  for (const k of ['author', 'event', 'date', 'description']) {
    if (s.meta[k]?.trim()) meta[k] = s.meta[k].trim();
  }
  if (Object.keys(meta).length) m.meta = meta;

  m.video = { sources: s.video.sources.filter((v) => v.src.trim()).map((v) => ({ provider: v.provider, src: v.src.trim() })) };
  if (s.video.poster?.trim()) m.video.poster = s.video.poster.trim();

  m.deck = { type: s.deck.type, sources: s.deck.sources.filter((d) => d.src.trim()).map((d) => ({ src: d.src.trim() })) };
  if (String(s.deck.slideCount).trim() && Number.isFinite(Number(s.deck.slideCount))) {
    m.deck.slideCount = Math.floor(Number(s.deck.slideCount));
  }

  const timing = s.timing
    .filter((t) => String(t.slide).trim() !== '')
    .map((t) => {
      const cue = { time: normTime(t.time), slide: Math.floor(Number(t.slide)) || 1 };
      if (t.transition && t.transition !== 'cut') cue.transition = t.transition;
      if (t.label?.trim()) cue.label = t.label.trim();
      return cue;
    });
  if (timing.length) m.timing = timing;

  const subs = s.subtitles.filter((x) => x.src.trim()).map((x) => {
    const o = { src: x.src.trim() };
    if (x.lang?.trim()) o.lang = x.lang.trim();
    if (x.label?.trim()) o.label = x.label.trim();
    if (x.format) o.format = x.format;
    if (x.default) o.default = true;
    return o;
  });
  if (subs.length) m.subtitles = subs;

  const gw = s.resolvers.ipfsGateways.filter((x) => x.trim());
  const tr = s.resolvers.webtorrentTrackers.filter((x) => x.trim());
  if (gw.length || tr.length) {
    m.resolvers = {};
    if (gw.length) m.resolvers.ipfsGateways = gw;
    if (tr.length) m.resolvers.webtorrentTrackers = tr;
  }

  m.layout = { split: clamp(Number(s.layout.split) || 0.6, 0.15, 0.85), mode: s.layout.mode, transition: s.layout.transition };

  // Author signature (Phase 8). Kept verbatim; goes LAST so the signed block is
  // easy to spot in the export. If the manifest changed since signing it'll be
  // flagged stale (see updateSignStatus) — the player would show it as invalid.
  if (s.sig && s.sig.alg && s.sig.signature) m.sig = s.sig;
  return m;
}

// A time string that looks numeric becomes a number; "MM:SS" stays a string.
function normTime(v) {
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (s === '') return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  return s; // "MM:SS" / "HH:MM:SS.mmm"
}

// Parse a cue value (number, plain seconds, or "M:SS"/"H:MM:SS(.ms)") → seconds.
function toSeconds(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim();
  if (s === '') return NaN;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^(\d+):([0-5]?\d)(?::([0-5]?\d))?(\.\d+)?$/);
  if (!m) return NaN;
  const a = Number(m[1]), b = Number(m[2]), c = m[3] != null ? Number(m[3]) : null;
  const frac = m[4] ? Number(m[4]) : 0;
  return (c != null ? a * 3600 + b * 60 + c : a * 60 + b) + frac;
}
// Format a cue value as clock time: "M:SS" / "H:MM:SS", keeping sub-second precision.
// Leaves unparseable / mid-edit input untouched so typing isn't fought.
function fmtClock(v) {
  const sec = toSeconds(v);
  if (!Number.isFinite(sec)) return String(v ?? '');
  const a = Math.abs(sec), h = Math.floor(a / 3600), m = Math.floor((a % 3600) / 60);
  const whole = Math.floor(a % 60);
  const sub = a - Math.floor(a);
  let ss = String(whole).padStart(2, '0');
  if (sub > 0.0005) ss += sub.toFixed(3).slice(1).replace(/0+$/, '');
  return (sec < 0 ? '-' : '') + (h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`);
}
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

// --- dynamic-list rendering -------------------------------------------------
// Each list rebuilds its rows on add/remove; per-input listeners mutate state
// in place and call updatePreview() (so typing never loses focus).

const TRANSITIONS = ['cut', 'fade', 'slide', 'none'];
const PROVIDERS = ['youtube', 'mp4', 'webtorrent', 'ipfs'];
const DECK_TYPES = ['html', 'pdf', 'embed'];
const DECK_PROTOCOLS = ['https', 'arweave', 'ipfs', 'webtorrent'];   // transport for a deck source

// The transport a deck source uses, inferred from its src scheme (the loader
// keys off the same scheme — ar:// / ipfs:// / magnet: / http(s)).
function inferProtocol(src) {
  const s = String(src || '').trim().toLowerCase();
  if (s.startsWith('ar://')) return 'arweave';
  if (s.startsWith('ipfs://')) return 'ipfs';
  if (s.startsWith('magnet:')) return 'webtorrent';
  return 'https';
}
// Per-row src placeholder, sensitive to deck type + chosen transport.
function deckPlaceholder(type, protocol) {
  if (protocol === 'arweave') return 'ar://TXID/slides.' + (type === 'pdf' ? 'pdf' : 'html');
  if (protocol === 'ipfs') return 'ipfs://CID/slides.' + (type === 'pdf' ? 'pdf' : 'html');
  if (protocol === 'webtorrent') return 'magnet:?xt=urn:btih:…';
  if (type === 'pdf') return 'https://…/slides.pdf';
  if (type === 'embed') return 'https://docs.google.com/presentation/d/…/embed  ·  speakerdeck/canva embed URL';
  return 'https://…/deck/index.html';
}

function el(tag, cls, attrs = {}) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const [k, v] of Object.entries(attrs)) n[k] = v;
  return n;
}
function input(value, oninput, attrs = {}) {
  const i = el('input', 'p2-cell', { type: 'text', value: value ?? '', ...attrs });
  i.addEventListener('input', () => { oninput(i.value); updatePreview(); });
  return i;
}
function select(value, options, onchange) {
  const s = el('select', 'p2-cell');
  for (const o of options) {
    const opt = el('option', '', { value: o, textContent: o });
    if (o === value) opt.selected = true;
    s.appendChild(opt);
  }
  s.addEventListener('change', () => { onchange(s.value); updatePreview(); });
  return s;
}
function delBtn(onclick) {
  const b = el('button', 'p2-del', { type: 'button', textContent: '✕', title: 'Remove' });
  b.addEventListener('click', onclick);
  return b;
}

function renderVideo() {
  const c = $('list-video'); c.innerHTML = '';
  state.video.sources.forEach((row, i) => {
    const r = el('div', 'p2-row');
    r.append(
      select(row.provider, PROVIDERS, (v) => { row.provider = v; }),
      input(row.src, (v) => { row.src = v; }, { placeholder: 'youtube id / url · mp4 url · ar://TXID · magnet: · ipfs://CID' }),
      delBtn(() => { state.video.sources.splice(i, 1); renderVideo(); updatePreview(); }),
    );
    c.appendChild(r);
  });
  $('count-video').textContent = state.video.sources.length ? `(${state.video.sources.length})` : '';
}

function renderDeck() {
  const c = $('list-deck'); c.innerHTML = '';
  state.deck.sources.forEach((row, i) => {
    if (!row.protocol) row.protocol = inferProtocol(row.src);
    const r = el('div', 'p2-row');
    const src = input(row.src, (v) => { row.src = v; }, { placeholder: deckPlaceholder(state.deck.type, row.protocol) });
    const proto = select(row.protocol, DECK_PROTOCOLS, (v) => {
      row.protocol = v; src.placeholder = deckPlaceholder(state.deck.type, v);
    });
    r.append(
      proto, src,
      delBtn(() => { state.deck.sources.splice(i, 1); renderDeck(); updatePreview(); }),
    );
    c.appendChild(r);
  });
}

function renderTiming() {
  const c = $('list-timing'); c.innerHTML = '';
  state.timing.forEach((row, i) => {
    const r = el('div', 'p2-row p2-row-timing');
    // Show the cue as M:SS; normalise the display on blur but keep raw text while typing.
    const timeCell = input(fmtClock(row.time), (v) => { row.time = v; }, { placeholder: 'm:ss' });
    timeCell.addEventListener('blur', () => { timeCell.value = fmtClock(row.time); });
    r.append(
      timeCell,
      input(row.slide, (v) => { row.slide = v; }, { placeholder: 'slide', inputMode: 'numeric' }),
      select(row.transition || 'cut', TRANSITIONS, (v) => { row.transition = v; }),
      input(row.label, (v) => { row.label = v; }, { placeholder: 'label (optional)' }),
      delBtn(() => { state.timing.splice(i, 1); renderTiming(); updatePreview(); }),
    );
    c.appendChild(r);
  });
  $('count-timing').textContent = state.timing.length ? `(${state.timing.length})` : '';
}

function renderSubs() {
  const c = $('list-subs'); c.innerHTML = '';
  state.subtitles.forEach((row, i) => {
    const r = el('div', 'p2-row p2-row-sub');
    const def = el('label', 'p2-checkbox');
    const cb = el('input', '', { type: 'checkbox', checked: !!row.default });
    cb.addEventListener('change', () => { row.default = cb.checked; updatePreview(); });
    def.append(cb, document.createTextNode(' default'));
    r.append(
      input(row.lang, (v) => { row.lang = v; }, { placeholder: 'lang (en)' }),
      input(row.label, (v) => { row.label = v; }, { placeholder: 'label (English)' }),
      input(row.src, (v) => { row.src = v; }, { placeholder: '…vtt / …srt url' }),
      select(row.format || 'vtt', ['vtt', 'srt'], (v) => { row.format = v; }),
      def,
      delBtn(() => { state.subtitles.splice(i, 1); renderSubs(); updatePreview(); }),
    );
    c.appendChild(r);
  });
  $('count-subs').textContent = state.subtitles.length ? `(${state.subtitles.length})` : '';
}

function renderStrList(listId, arr, placeholder, rerender) {
  const c = $(listId); c.innerHTML = '';
  arr.forEach((val, i) => {
    const r = el('div', 'p2-row');
    r.append(
      input(val, (v) => { arr[i] = v; }, { placeholder }),
      delBtn(() => { arr.splice(i, 1); rerender(); updatePreview(); }),
    );
    c.appendChild(r);
  });
}
const renderGateways = () => renderStrList('list-gateways', state.resolvers.ipfsGateways, 'https://{cid}.ipfs.dweb.link', renderGateways);
const renderTrackers = () => renderStrList('list-trackers', state.resolvers.webtorrentTrackers, 'wss://tracker.example', renderTrackers);

function renderAllLists() {
  renderVideo(); renderDeck(); renderTiming(); renderSubs(); renderGateways(); renderTrackers();
}

// --- static fields ----------------------------------------------------------

function bindStatic() {
  const bind = (id, fn) => $(id).addEventListener('input', () => { fn($(id).value); updatePreview(); });
  bind('f-title', (v) => state.title = v);
  bind('f-author', (v) => state.meta.author = v);
  bind('f-event', (v) => state.meta.event = v);
  bind('f-date', (v) => state.meta.date = v);
  bind('f-description', (v) => state.meta.description = v);
  bind('f-poster', (v) => state.video.poster = v);
  bind('f-slidecount', (v) => state.deck.slideCount = v);
  bind('f-split', (v) => state.layout.split = v);
  $('f-deck-type').addEventListener('change', () => { state.deck.type = $('f-deck-type').value; renderDeck(); updatePreview(); });
  $('f-mode').addEventListener('change', () => { state.layout.mode = $('f-mode').value; updatePreview(); });
  $('f-transition').addEventListener('change', () => { state.layout.transition = $('f-transition').value; updatePreview(); });
}

function fillStatic() {
  $('f-title').value = state.title || '';
  $('f-author').value = state.meta.author || '';
  $('f-event').value = state.meta.event || '';
  $('f-date').value = state.meta.date || '';
  $('f-description').value = state.meta.description || '';
  $('f-poster').value = state.video.poster || '';
  $('f-deck-type').value = state.deck.type || 'html';
  $('f-slidecount').value = state.deck.slideCount ?? '';
  $('f-split').value = state.layout.split ?? 0.6;
  $('f-mode').value = state.layout.mode || 'split';
  $('f-transition').value = state.layout.transition || 'fade';
}

// --- simple view (guided: video → slides → chapters → capture) --------------

function inferVideoProvider(url) {
  const s = String(url || '').trim().toLowerCase();
  if (!s) return 'youtube';
  if (s.startsWith('magnet:')) return 'webtorrent';
  if (s.startsWith('ipfs://')) return 'ipfs';
  if (/youtube\.com|youtu\.be/.test(s) || /^[\w-]{11}$/.test(String(url).trim())) return 'youtube';
  return 'mp4';  // any other http(s) file
}
const VIDEO_KIND = { youtube: 'YouTube', mp4: 'MP4 / direct file', webtorrent: 'WebTorrent magnet', ipfs: 'IPFS' };

// Guess the deck type from a slides URL: a .pdf → pdf, a Google Slides / SpeakerDeck /
// Canva / generic embed → embed, an HTML page/dir → html. null = leave as chosen.
function inferDeckType(url) {
  const s = String(url || '').trim().toLowerCase();
  if (!s) return null;
  if (/\.pdf($|[?#])/.test(s)) return 'pdf';
  if (/docs\.google\.com\/presentation|speakerdeck\.com|canva\.com\/design|\/embed($|[?#/])/.test(s)) return 'embed';
  if (/\.html?($|[?#])|\/$/.test(s)) return 'html';
  return null;
}

const DECK_KIND = { pdf: 'PDF deck', html: 'HTML deck', embed: 'embedded slides (display-only)' };
function deckKindHint() {
  return $('s-deck').value.trim() ? `Detected: ${DECK_KIND[state.deck.type] || state.deck.type}` : '';
}

function bindSimple() {
  $('s-title').addEventListener('input', () => { state.title = $('s-title').value; $('f-title').value = state.title; updatePreview(); });
  $('s-video').addEventListener('input', () => {
    const url = $('s-video').value;
    if (!state.video.sources.length) state.video.sources = [{ provider: 'youtube', src: '' }];
    state.video.sources[0].src = url;
    state.video.sources[0].provider = inferVideoProvider(url);
    $('s-video-kind').textContent = url.trim() ? `Detected: ${VIDEO_KIND[state.video.sources[0].provider]}` : '';
    renderVideo(); updatePreview();
  });
  $('s-deck').addEventListener('input', () => {
    const url = $('s-deck').value;
    if (!state.deck.sources.length) state.deck.sources = [{ protocol: 'https', src: '' }];
    state.deck.sources[0].src = url;
    state.deck.sources[0].protocol = inferProtocol(url);
    // deck type is fully auto-detected in Simple (PDF / Google-Slides embed / HTML)
    const t = inferDeckType(url);
    if (t && t !== state.deck.type) { state.deck.type = t; $('f-deck-type').value = t; }
    $('s-deck-kind').textContent = deckKindHint();
    renderDeck(); updatePreview();
  });
  $('s-chapters-apply').addEventListener('click', applyChapters);
  $('s-chapters-auto').addEventListener('click', autoDetectChapters);
  $('s-load-demo')?.addEventListener('click', loadDemoPdf);
}

function fillSimple() {
  $('s-title').value = state.title || '';
  $('s-video').value = state.video.sources?.[0]?.src || '';
  $('s-deck').value = state.deck.sources?.[0]?.src || '';
  $('s-deck-kind').textContent = deckKindHint();
  const p = state.video.sources?.[0]?.provider;
  $('s-video-kind').textContent = ($('s-video').value.trim() && p) ? `Detected: ${VIDEO_KIND[p] || p}` : '';
}

// The Simple view's friendly readiness card (replaces the raw JSON + validator
// output): what's in, what's missing, and whether it's ready to play.
function renderSimpleSummary(manifest) {
  const box = $('simple-summary');
  if (!box) return;
  const hasVideo = !!manifest.video?.sources?.length;
  const hasDeck = !!manifest.deck?.sources?.length;
  const cues = manifest.timing?.length || 0;
  const ready = hasVideo && hasDeck;
  const li = (done, text) =>
    `<li class="${done ? 'is-done' : ''}"><span class="m">${done ? '✓' : '○'}</span>${text}</li>`;
  const kind = hasVideo ? (VIDEO_KIND[state.video.sources[0].provider] || 'video') : '';
  box.innerHTML =
    `<div class="p2-sum-badge${ready ? ' is-ready' : ''}">${ready ? '✓ Ready to play' : 'Add two links and it plays'}</div>` +
    '<ul class="p2-sum-list">' +
    li(hasVideo, hasVideo ? `Video — ${escapeText(kind)}` : 'Paste your talk video') +
    li(hasDeck, hasDeck ? `Slides — ${escapeText(DECK_KIND[state.deck.type] || state.deck.type)}` : 'Paste your slides') +
    li(cues > 1, cues > 1 ? `Timing — ${cues} cues` : 'Timing — add chapters or capture (optional)') +
    '</ul>';
}
const escapeText = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function setView(simple) {
  $('builder-main').classList.toggle('is-simple', simple);
  $('mode-simple').classList.toggle('is-on', simple);
  $('mode-advanced').classList.toggle('is-on', !simple);
  $('mode-simple').setAttribute('aria-selected', String(simple));
  $('mode-advanced').setAttribute('aria-selected', String(!simple));
  if (simple) fillSimple(); else { fillStatic(); renderAllLists(); }
}

// Parse a pasted chapter list ("0:00 Intro", "1:23 - Topic", "1:02:03 Title") into
// timing cues — one slide per chapter, the chapter title as the cue label.
function parseChapters(text) {
  const cues = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\s*[-–—).:]?\s*(.*)$/);
    if (!m || !Number.isFinite(toSeconds(m[1]))) continue;
    cues.push({ time: m[1], slide: cues.length + 1, transition: 'cut', label: (m[2] || '').trim() });
  }
  return cues;
}
function applyChapters() {
  const cues = parseChapters($('s-chapters').value);
  if (!cues.length) { $('s-chapters-status').textContent = 'No “M:SS Title” lines found.'; return; }
  state.timing = cues;
  renderTiming(); updatePreview();
  $('s-chapters-status').textContent = `Added ${cues.length} cue${cues.length > 1 ? 's' : ''} (one slide each) — refine with capture below.`;
}

// Best-effort chapter auto-detect. A pure-static page can't read a YouTube video's
// chapters (they live in the description, behind CORS), so this only succeeds when
// the optional service exposes a /chapters proxy; otherwise it falls back to paste.
async function fetchChapters(videoUrl) {
  const base = (window.P2PRESENT_SERVICE || '').replace(/\/$/, '');
  if (!base) return null;
  const res = await fetch(`${base}/chapters?u=${encodeURIComponent(videoUrl)}`, { headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const list = Array.isArray(data?.chapters) ? data.chapters : (Array.isArray(data) ? data : null);
  return list && list.length ? list : null;
}
async function autoDetectChapters() {
  const url = ($('s-video').value || '').trim();
  const status = $('s-chapters-status');
  if (!url) { status.textContent = 'Add a video URL first.'; return; }
  status.textContent = 'Looking for chapters…';
  try {
    const chapters = await fetchChapters(url);
    if (chapters) {
      $('s-chapters').value = chapters.map((c) => `${c.time || fmtClock(c.start || 0)} ${c.label || c.title || ''}`.trim()).join('\n');
      status.textContent = `Found ${chapters.length} chapters — review, then “Use these as timing”.`;
      return;
    }
    status.textContent = 'No auto-source available — paste chapters below (copy them from the video description).';
  } catch {
    status.textContent = 'Auto-detect needs the optional service — paste chapters below instead.';
  }
  $('s-chapters').focus();
}

// --- preview + validation ---------------------------------------------------

let lastManifest = null;
function updatePreview() {
  const manifest = buildManifest(state);
  lastManifest = manifest;
  $('json').firstElementChild.textContent = JSON.stringify(manifest, null, 2);

  const errors = [];
  if (schema) {
    for (const e of validate(manifest, schema).errors) errors.push(`${e.path || '/'} ${e.message}`);
  }
  // Also run the real loader — it catches structural issues the schema can't.
  try { normaliseManifest(JSON.parse(JSON.stringify(manifest)), window.location.href); }
  catch (err) { errors.push(`loader: ${err.message}`); }

  const badge = $('valid-badge');
  const list = $('errors');
  if (errors.length) {
    badge.textContent = `⚠ ${errors.length} issue${errors.length > 1 ? 's' : ''}`;
    badge.className = 'p2-valid is-invalid';
    list.hidden = false;
    list.innerHTML = '';
    for (const e of errors.slice(0, 30)) { const li = el('li', '', { textContent: e }); list.appendChild(li); }
  } else {
    badge.textContent = '✓ valid';
    badge.className = 'p2-valid is-valid';
    list.hidden = true; list.innerHTML = '';
  }
  updateSignStatus(manifest);
  renderSimpleSummary(manifest);
  updateSimpleSteps(manifest);
  return errors;
}

// Mark the Simple steps done as they're filled: the number badge flips to an
// accent ✓ and the input picks up an accent border — instant "that worked" cue.
function updateSimpleSteps(manifest) {
  const mark = (stepId, done) => {
    const step = $(stepId);
    if (!step) return;
    step.classList.toggle('is-done', done);
    const n = step.querySelector('.p2-step-n');
    if (n) n.textContent = done ? '✓' : (n.dataset.n || n.textContent);
  };
  mark('s-step-video', !!manifest.video?.sources?.length);
  mark('s-step-deck', !!manifest.deck?.sources?.length);
  mark('s-step-title', !!(manifest.title || '').trim());
  mark('s-step-timing', (manifest.timing?.length || 0) > 1);
}

// --- signing (Phase 8) ------------------------------------------------------

let edKey = null;   // last generated Ed25519 keypair, kept in memory to re-sign

// Build the manifest to sign — never include an existing sig in the signed bytes.
function manifestForSigning() { return buildManifest({ ...state, sig: null }); }

function setSignResult(msg, isError = false) {
  const r = $('sign-result');
  if (!r) return;
  r.hidden = !msg;
  r.textContent = msg || '';
  r.classList.toggle('is-error', !!isError);
}

function applySignature(signed) {
  const sig = signed.sig;
  state.sig = sig;
  state.sigPayload = signingString(signed, { alg: sig.alg, signer: sig.signer });
  updatePreview();
}

async function signWithWallet() {
  const provider = (typeof window !== 'undefined') && window.ethereum;
  if (!provider) { setSignResult('No injected wallet (e.g. MetaMask) detected in this browser.', true); return; }
  if (updatePreview().length) { setSignResult('Fix the manifest issues before signing.', true); return; }
  try {
    setSignResult('Check your wallet to approve the signature…');
    applySignature(await signEip191WithWallet(manifestForSigning(), { provider }));
  } catch (err) { setSignResult('Wallet signing failed: ' + (err?.message || err), true); }
}

function signWithEthKey() {
  const field = $('sign-ethkey');
  const key = field.value.trim();
  if (!key) { setSignResult('Paste an Ethereum private key first.', true); return; }
  if (updatePreview().length) { setSignResult('Fix the manifest issues before signing.', true); return; }
  try {
    applySignature(signEip191WithKey(manifestForSigning(), key));
    field.value = '';   // don't leave the secret sitting in the field
  } catch (err) { setSignResult('Signing failed: ' + (err?.message || err), true); }
}

async function signWithEd25519() {
  if (updatePreview().length) { setSignResult('Fix the manifest issues before signing.', true); return; }
  try {
    if (!edKey) edKey = await generateEd25519();
    const domain = $('sign-ed-domain').value.trim() || undefined;
    applySignature(await signEd25519(manifestForSigning(), { ...edKey, domain }));
    const saved = $('sign-ed-saved');
    saved.hidden = false; saved.innerHTML = '';
    saved.append(
      el('div', '', { textContent: '🔑 Private key (base64url pkcs8) — save it to re-sign with the same identity:' }),
      el('code', 'p2-hosted-ref', { textContent: edKey.privateKeyPkcs8 }),
    );
  } catch (err) { setSignResult('Ed25519 signing failed: ' + (err?.message || err), true); }
}

function removeSignature() {
  state.sig = null; state.sigPayload = null; edKey = null;
  const saved = $('sign-ed-saved'); if (saved) saved.hidden = true;
  setSignResult('');
  updatePreview();
}

function updateSignStatus(manifest) {
  const badge = $('sign-status');
  const removeBtn = $('sign-remove');
  if (!badge) return;
  if (!state.sig) { badge.textContent = ''; badge.className = 'p2-count'; if (removeBtn) removeBtn.hidden = true; return; }
  if (removeBtn) removeBtn.hidden = false;
  const sig = state.sig;
  const label = sig.alg === 'eip191'
    ? abbreviateAddress(sig.signer?.address)
    : (sig.signer?.domain || ('key ' + String(sig.signer?.key || '').slice(0, 10) + '…'));
  const stale = signingString(manifest, { alg: sig.alg, signer: sig.signer }) !== state.sigPayload;
  if (stale) {
    badge.textContent = '⚠ edited since signing — re-sign';
    badge.className = 'p2-count is-stale';
    setSignResult('The manifest changed since you signed it — re-sign (or remove the signature) before publishing, or the player will mark it invalid.', true);
  } else {
    badge.textContent = `✓ signed (${sig.alg}) · ${label}`;
    badge.className = 'p2-count is-signed';
  }
}

// --- load existing ----------------------------------------------------------

function loadState(raw) {
  const s = blankState();
  s.title = str(raw.title);
  s.meta = { author: str(raw.meta?.author), event: str(raw.meta?.event), date: str(raw.meta?.date), description: str(raw.meta?.description) };
  s.video.sources = Array.isArray(raw.video?.sources) && raw.video.sources.length
    ? raw.video.sources.map((v) => ({ provider: PROVIDERS.includes(v.provider) ? v.provider : 'mp4', src: str(v.src) }))
    : [{ provider: 'youtube', src: '' }];
  s.video.poster = str(raw.video?.poster);
  s.deck.type = DECK_TYPES.includes(raw.deck?.type) ? raw.deck.type : 'html';
  s.deck.sources = Array.isArray(raw.deck?.sources) && raw.deck.sources.length
    ? raw.deck.sources.map((d) => ({ protocol: inferProtocol(d.src), src: str(d.src) }))
    : [{ protocol: 'https', src: '' }];
  s.deck.slideCount = raw.deck?.slideCount ?? '';
  s.timing = Array.isArray(raw.timing)
    ? raw.timing.map((t) => ({ time: t.time ?? 0, slide: t.slide ?? 1, transition: t.transition || 'cut', label: str(t.label) }))
    : [];
  if (!s.timing.length) s.timing = [{ time: 0, slide: 1, transition: 'cut', label: '' }];
  s.subtitles = Array.isArray(raw.subtitles)
    ? raw.subtitles.map((x) => ({ lang: str(x.lang), label: str(x.label), src: str(x.src), format: x.format || 'vtt', default: !!x.default })) : [];
  s.resolvers.ipfsGateways = arr(raw.resolvers?.ipfsGateways);
  s.resolvers.webtorrentTrackers = arr(raw.resolvers?.webtorrentTrackers);
  s.layout = { split: raw.layout?.split ?? 0.6, mode: raw.layout?.mode || 'split', transition: raw.layout?.transition || 'fade' };
  // Preserve an existing signature when editing a signed manifest (it'll be
  // flagged stale the moment any signed field changes).
  if (raw.sig && raw.sig.alg && raw.sig.signature) {
    s.sig = raw.sig;
    try { s.sigPayload = signingString(raw, { alg: raw.sig.alg, signer: raw.sig.signer }); } catch { s.sigPayload = null; }
  }
  state = s;
  fillStatic(); fillSimple(); renderAllLists(); updatePreview();
}
const str = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));
const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

// Absolutise a manifest's relative srcs against its own location so the capture
// player + "Open in player" (inline ?src=) can load the bundled assets from any
// page (the builder lives at /builder/, not next to /content/).
function absolutiseManifest(raw, manifestPath) {
  const base = new URL(manifestPath, window.location.href).href;
  const abs = (u) => (u && !/^(https?:|ipfs:|magnet:|[\w.-]+:)/i.test(u) && !u.startsWith('//') ? new URL(u, base).href : u);
  // Only file-path video providers get absolutised — youtube srcs are bare IDs.
  if (raw.video?.sources) raw.video.sources = raw.video.sources.map((v) => (v.provider === 'mp4' ? { ...v, src: abs(v.src) } : v));
  if (raw.deck?.sources) raw.deck.sources = raw.deck.sources.map((d) => ({ ...d, src: abs(d.src) }));
  if (raw.subtitles) raw.subtitles = raw.subtitles.map((x) => ({ ...x, src: abs(x.src) }));
  if (raw.video?.poster) raw.video.poster = abs(raw.video.poster);
  return raw;
}
async function loadDemoFrom(manifestPath) {
  try {
    const raw = await (await fetch(manifestPath)).json();
    loadState(absolutiseManifest(raw, manifestPath));
  } catch (err) {
    alert('Could not load the demo manifest: ' + err.message);
  }
}
const loadDemo = () => loadDemoFrom('../content/demo/manifest.json');
const loadDemoPdf = () => loadDemoFrom('../content/moav-pdf/manifest.json');

// --- actions ----------------------------------------------------------------

function jsonText() { return JSON.stringify(lastManifest || buildManifest(state), null, 2); }

function openInPlayer() {
  const errs = updatePreview();
  if (errs.length && !confirm(`This manifest has ${errs.length} issue(s). Open in the player anyway?`)) return;
  const b64 = encodeBase64(jsonText());
  window.open(`../app/?src=${encodeURIComponent(b64)}`, '_blank');
}
async function copyJson() {
  try { await navigator.clipboard.writeText(jsonText()); flash('act-copy', 'Copied ✓'); }
  catch { flash('act-copy', 'Copy blocked'); }
}
function downloadJson() {
  const blob = new Blob([jsonText()], { type: 'application/json' });
  const a = el('a', '', { href: URL.createObjectURL(blob), download: 'p2present.json' });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function flash(id, msg) {
  const b = $(id); const old = b.textContent; b.textContent = msg;
  setTimeout(() => { b.textContent = old; }, 1400);
}

// --- timing capture (mount the real Player) ---------------------------------

let capturePlayer = null;
async function toggleCapture() {
  const panel = $('capture-panel');
  if (!panel.hidden) { destroyCapture(); panel.hidden = true; $('capture-toggle').textContent = '🎬 Open timing-capture player'; return; }
  const errs = updatePreview();
  if (errs.length) { alert('Fix the manifest issues first — the capture player needs a loadable video + deck.'); return; }
  panel.hidden = false;
  $('capture-toggle').textContent = '✕ Close capture player';
  $('capture-status').textContent = 'Loading…';
  try {
    const manifest = await loadPresentation(JSON.parse(jsonText()));
    const mount = $('capture-mount'); mount.innerHTML = '';
    capturePlayer = new Player(manifest, mount, { captureMode: true });
    await capturePlayer.mount();
    // UNLINK sync while capturing: linked mode would drive the deck from the
    // OLD cues as the video plays (fighting manual navigation) and seek the
    // video whenever we advance the deck. Capture wants them independent.
    capturePlayer.sync?.setLinked(false);
    renderCaptureCues();
    $('capture-status').textContent = 'Play the video — the moment the talk moves to the next slide, hit Stamp.';
  } catch (err) {
    $('capture-status').textContent = 'Could not mount: ' + err.message;
  }
}
function destroyCapture() {
  try { capturePlayer?.destroy(); } catch {}
  capturePlayer = null;
  $('capture-mount').innerHTML = '';
}
// Stamp = "the talk just moved on": record that the NEXT slide starts at the
// current video time, then advance the deck to it — so capturing a whole talk
// is play + one button. (Slide 1 at 0:00 is the seed cue every deck starts with.)
function stampTiming() {
  if (!capturePlayer) { $('capture-status').textContent = 'Open the capture player first.'; return; }
  const { t, slide } = capturePlayer.spot();
  const count = capturePlayer.deck?.slideCount || Infinity;
  if (slide >= count) {
    $('capture-status').textContent = `Already at the last slide (${slide}) — all cues captured.`;
    return;
  }
  const next = slide + 1;
  state.timing.push({ time: t, slide: next, transition: 'cut', label: '' });
  state.timing.sort((a, b) => toSeconds(a.time) - toSeconds(b.time));
  capturePlayer.sync?.gotoSlide(next);          // unlinked → moves the deck only
  renderTiming(); renderCaptureCues(); updatePreview();
  $('capture-status').textContent = `✓ Slide ${next} starts at ${fmtClock(t)} — deck advanced, stamp again at the next change.`;
}

// Compact chips of the captured cues, visible right under the capture player
// (the full editable table lives in the Advanced view's Timing card).
function renderCaptureCues() {
  const box = $('capture-cues');
  if (!box) return;
  box.innerHTML = '';
  const cues = [...state.timing].sort((a, b) => toSeconds(a.time) - toSeconds(b.time));
  box.hidden = cues.length === 0;
  for (const c of cues) {
    box.appendChild(el('span', 'p2-cue-chip', { textContent: `${fmtClock(c.time)} → ${c.slide}` }));
  }
}

// --- wire up ----------------------------------------------------------------

function addRow(kind) {
  ({
    video: () => { state.video.sources.push({ provider: 'mp4', src: '' }); renderVideo(); },
    deck: () => { state.deck.sources.push({ protocol: 'https', src: '' }); renderDeck(); },
    timing: () => { state.timing.push({ time: '', slide: '', transition: 'cut', label: '' }); renderTiming(); },
    subs: () => { state.subtitles.push({ lang: '', label: '', src: '', format: 'vtt', default: false }); renderSubs(); },
    gateways: () => { state.resolvers.ipfsGateways.push(''); renderGateways(); },
    trackers: () => { state.resolvers.webtorrentTrackers.push(''); renderTrackers(); },
  }[kind] || (() => {}))();
  updatePreview();
}

// Hosted references produced by the Host page (localStorage handoff).
function renderHosted() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem('p2present:hosted')) || []; } catch {}
  const card = $('hosted-card');
  if (!card) return;
  card.hidden = list.length === 0;
  $('hosted-count').textContent = list.length ? `(${list.length})` : '';
  const box = $('hosted-list'); box.innerHTML = '';
  for (const e of list) {
    const r = el('div', 'p2-row');
    const tag = el('span', 'p2-tag', { textContent: e.kind });
    const code = el('code', 'p2-hosted-ref', { textContent: e.ref });
    const btn = el('button', 'p2-load p2-copy', { type: 'button', textContent: '📋', title: 'Copy reference' });
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(e.ref); btn.textContent = '✓'; setTimeout(() => (btn.textContent = '📋'), 1200); } catch {}
    });
    r.append(tag, code, btn);
    box.appendChild(r);
  }
}

function init() {
  // Bind everything synchronously FIRST so the controls work immediately — the
  // schema is fetched in the background (don't await it before wiring handlers,
  // or a fast click during that fetch is lost on a slow network).
  bindStatic();
  bindSimple();
  fillStatic(); fillSimple(); renderAllLists(); updatePreview();
  renderHosted();

  $('mode-simple').addEventListener('click', () => setView(true));
  $('mode-advanced').addEventListener('click', () => setView(false));

  document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => addRow(b.dataset.add)));
  $('load-demo').addEventListener('click', loadDemo);
  $('load-demo-pdf')?.addEventListener('click', loadDemoPdf);
  $('reset-blank').addEventListener('click', () => { state = blankState(); fillStatic(); fillSimple(); renderAllLists(); updatePreview(); });
  $('load-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    try { loadState(JSON.parse(await file.text())); } catch (err) { alert('Invalid JSON: ' + err.message); }
    e.target.value = '';
  });
  $('load-paste-btn').addEventListener('click', () => {
    const txt = $('load-paste').value.trim(); if (!txt) return;
    try { loadState(JSON.parse(txt)); $('load-paste').value = ''; } catch (err) { alert('Invalid JSON: ' + err.message); }
  });
  $('sort-timing').addEventListener('click', () => { state.timing.sort((a, b) => toSeconds(a.time) - toSeconds(b.time)); renderTiming(); updatePreview(); });
  $('capture-toggle').addEventListener('click', toggleCapture);
  $('capture-stamp').addEventListener('click', stampTiming);
  $('act-open').addEventListener('click', openInPlayer);
  $('act-copy').addEventListener('click', copyJson);
  $('act-download').addEventListener('click', downloadJson);

  // Signing (Phase 8).
  $('sign-wallet').addEventListener('click', signWithWallet);
  $('sign-ethkey-btn').addEventListener('click', signWithEthKey);
  $('sign-ed-gen').addEventListener('click', signWithEd25519);
  $('sign-remove').addEventListener('click', removeSignature);

  // Load the schema in the background, then re-validate once it arrives.
  fetch('../p2present.schema.json')
    .then((r) => r.json())
    .then((s) => { schema = s; updatePreview(); })
    .catch(() => { schema = null; });
}

init();
