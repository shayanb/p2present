// manifest.js — load, validate, and normalise a p2present.json v1 manifest.
//
// p2present.json v1.0 (canonical — see SPEC.md / docs/p2present.schema.json):
// {
//   "p2present": "1.0",
//   "title": "...",
//   "meta": { "author":"", "event":"", "date":"", "description":"" },
//   "video": { "sources": [ {"provider":"youtube|mp4|webtorrent|ipfs","src":"..."} ], "poster":"" },
//   "deck":  { "type":"html|pdf", "sources":[ {"src":"..."} ], "slideCount": N },
//   "timing": [ {"time":0.0,"slide":1,"transition":"cut"} ]   // or "timing":"timing.json"
//   "subtitles": [ {"lang":"en","label":"English","src":"...vtt","format":"vtt|srt","default":true} ],
//   "resolvers": { "ipfsGateways":["..."], "webtorrentTrackers":["..."] },
//   "layout": { "split":0.6, "mode":"split", "transition":"fade" }
// }
//
// `time` may be a float (seconds) or an "HH:MM:SS.mmm" string; we normalise it
// to float seconds. A source (the manifest itself, the deck, the video, assets)
// may be a plain https URL, an ipfs:// CID, or a magnet: link — see resolve.js.
// Relative `src` paths resolve against the manifest URL so content can live on
// any remote host (the resolver use case).

import { parseTime } from './time.js';
import {
  DEFAULT_IPFS_GATEWAYS, DEFAULT_WEBTORRENT_TRACKERS,
  isHttp, isIpfs, isMagnet, isArweave, ipfsGatewayUrls, arweaveGatewayUrls,
  fetchFirstOk, webtorrentText,
} from './resolve.js';

const LAYOUT_MODES = ['split', 'slides-focus', 'video-focus', 'overlap'];

/**
 * Load a whole presentation from a *source* — which may be:
 *   - an inline manifest object (already parsed),
 *   - an https URL to a p2present.json,
 *   - an ipfs:// CID (resolved through gateways),
 *   - a magnet: link (the .json is fetched from the swarm).
 * Sibling assets resolve against wherever the manifest was found.
 * @returns {Promise<object>} normalised manifest with resolved asset URLs
 */
export async function loadPresentation(source) {
  if (source && typeof source === 'object') {
    return normaliseManifest(source, window.location.href);
  }
  const s = String(source ?? '').trim();
  if (!s) throw new Error('No presentation source given.');

  let raw, baseUrl;
  if (isMagnet(s)) {
    raw = JSON.parse(await webtorrentText(s, {
      trackers: DEFAULT_WEBTORRENT_TRACKERS, matchRe: /\.json$/i,
    }));
    // A magnet-hosted manifest can't resolve relative siblings — its assets must
    // be absolute / ipfs: / magnet:. Base stays the page so absolutes pass through.
    baseUrl = window.location.href;
  } else if (isIpfs(s)) {
    const { res, url } = await fetchFirstOk(
      ipfsGatewayUrls(s, DEFAULT_IPFS_GATEWAYS), 'manifest (ipfs)');
    raw = await res.json();
    baseUrl = url; // sibling assets resolve through the same gateway
  } else if (isArweave(s)) {
    const { res, url } = await fetchFirstOk(arweaveGatewayUrls(s), 'manifest (arweave)');
    raw = await res.json();
    baseUrl = url; // sibling assets resolve through the same gateway
  } else {
    baseUrl = new URL(s, window.location.href).href;
    raw = await fetchJson(baseUrl, 'manifest');
  }

  // `timing` may be an inline array OR a string path/URI to an external JSON file.
  if (typeof raw.timing === 'string') {
    let timing = await fetchJsonFrom(raw.timing, baseUrl, 'timing file');
    if (timing && !Array.isArray(timing) && Array.isArray(timing.timing)) timing = timing.timing;
    if (!Array.isArray(timing)) {
      throw new Error('External timing file must be a JSON array (or {"timing":[…]}).');
    }
    raw.timing = timing;
  }

  return normaliseManifest(raw, baseUrl);
}

async function fetchJson(fetchUrl, what) {
  let res;
  try {
    res = await fetch(fetchUrl, { mode: 'cors' });
  } catch (err) {
    throw new Error(`Could not fetch ${what} (${fetchUrl}): ${err.message}. ` +
      `If it lives on another host, that host must send CORS headers.`);
  }
  if (!res.ok) throw new Error(`${what} fetch failed: HTTP ${res.status} for ${fetchUrl}`);
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`${what} is not valid JSON (${fetchUrl}): ${err.message}`);
  }
}

// Fetch JSON from a child reference that may itself be http(s)/ipfs/magnet.
async function fetchJsonFrom(src, baseUrl, what) {
  if (isMagnet(src)) {
    return JSON.parse(await webtorrentText(src, {
      trackers: DEFAULT_WEBTORRENT_TRACKERS, matchRe: /\.json$/i,
    }));
  }
  if (isIpfs(src)) {
    const { res } = await fetchFirstOk(ipfsGatewayUrls(src), what);
    return res.json();
  }
  if (isArweave(src)) {
    const { res } = await fetchFirstOk(arweaveGatewayUrls(src), what);
    return res.json();
  }
  return fetchJson(new URL(src, baseUrl).href, what);
}

/**
 * Validate + normalise a raw v1 manifest object into the internal shape.
 * @param {object} raw
 * @param {string} baseUrl URL the manifest was loaded from (for resolving src)
 * @returns {object}
 */
export function normaliseManifest(raw, baseUrl = window.location.href) {
  if (!raw || typeof raw !== 'object') throw new Error('Manifest must be an object.');
  if (!raw.video || typeof raw.video !== 'object') throw new Error('Manifest.video is required.');
  if (!raw.deck || typeof raw.deck !== 'object') throw new Error('Manifest.deck is required.');

  // --- resolvers (gateways/trackers drive ipfs:// + magnet: src resolution) ---
  const resolvers = {
    ipfsGateways: arrayOfStrings(raw.resolvers?.ipfsGateways) || DEFAULT_IPFS_GATEWAYS,
    webtorrentTrackers: arrayOfStrings(raw.resolvers?.webtorrentTrackers) || DEFAULT_WEBTORRENT_TRACKERS,
  };
  const gateways = resolvers.ipfsGateways;

  // --- video: ordered fallback list of sources ---
  const videoSources = normaliseVideoSources(raw.video, baseUrl, gateways);
  if (!videoSources.length) {
    throw new Error('Manifest.video.sources needs at least one {provider, src}.');
  }
  const poster = raw.video.poster ? resolveSrc(raw.video.poster, baseUrl, gateways) : undefined;

  // --- deck: ordered fallback list of source URLs ---
  if (!raw.deck.type) throw new Error('Manifest.deck.type is required.');
  const deckSources = normaliseDeckSources(raw.deck, baseUrl, gateways);
  if (!deckSources.length) {
    throw new Error('Manifest.deck.sources needs at least one {src}.');
  }
  const slideCount = Number.isFinite(Number(raw.deck.slideCount))
    ? Math.floor(Number(raw.deck.slideCount)) : undefined;
  // Optional authored slide thumbnails: ["url", …] (indexed by slide) or
  // [{slide, src}]. Resolve each src against the manifest's base URL.
  const thumbnails = normaliseThumbnails(raw.deck.thumbnails, baseUrl, gateways);

  // --- timing cues (inline; external files already resolved in loadPresentation) ---
  const rawCues = Array.isArray(raw.timing) ? raw.timing : [];
  const sync = rawCues.map((cue, i) => normaliseCue(cue, i)).sort((a, b) => a.time - b.time);

  // --- subtitles ---
  const subtitles = (Array.isArray(raw.subtitles) ? raw.subtitles : [])
    .map((s, i) => normaliseSubtitle(s, i, baseUrl, gateways))
    .filter(Boolean);

  return {
    title: typeof raw.title === 'string' ? raw.title : 'Untitled presentation',
    meta: {
      author: str(raw.meta?.author),
      event: str(raw.meta?.event),
      date: str(raw.meta?.date),
      description: str(raw.meta?.description),
    },
    video: { sources: videoSources, poster },
    deck: { type: String(raw.deck.type), sources: deckSources, slideCount, thumbnails, ...stripKnownDeck(raw.deck) },
    sync,
    subtitles,
    resolvers,
    layout: normaliseLayout(raw.layout),
    // Optional author signature (Phase 8) — passed through verbatim. The player
    // verifies it against `_raw` (the canonical bytes are the AUTHORED manifest,
    // pre-normalisation) and shows a badge; see src/sign.js + src/player.js.
    sig: (raw.sig && typeof raw.sig === 'object') ? raw.sig : undefined,
    baseUrl,
    _raw: raw,
  };
}

function normaliseVideoSources(video, baseUrl, gateways) {
  const list = Array.isArray(video.sources) ? video.sources : [];
  return list
    .filter((s) => s && s.provider && s.src != null)
    .map((s) => {
      const provider = String(s.provider);
      // mp4 (file-based) resolves http/ipfs/relative; youtube ids, magnets and
      // ipfs CIDs for the p2p providers stay verbatim (the provider resolves them).
      const src = provider === 'mp4'
        ? resolveSrc(String(s.src), baseUrl, gateways)
        : String(s.src);
      return { provider, src };
    });
}

function normaliseDeckSources(deck, baseUrl, gateways) {
  const list = Array.isArray(deck.sources) ? deck.sources : [];
  const out = [];
  for (const s of list) {
    if (!s || s.src == null) continue;
    const src = String(s.src);
    if (isIpfs(src)) {
      // Expand into one fallback entry per gateway so the deck loader tries each.
      for (const u of ipfsGatewayUrls(src, gateways)) out.push({ src: u });
    } else if (isArweave(src)) {
      for (const u of arweaveGatewayUrls(src)) out.push({ src: u });
    } else if (isMagnet(src)) {
      out.push({ src }); // the deck adapter fetches a Blob URL from the swarm
    } else {
      out.push({ src: resolveSrc(src, baseUrl, gateways) });
    }
  }
  return out;
}

function normaliseCue(cue, i) {
  if (!cue || typeof cue !== 'object') throw new Error(`timing[${i}] must be an object.`);
  const slide = Number(cue.slide);
  if (!Number.isFinite(slide) || slide < 1) {
    throw new Error(`timing[${i}].slide must be a 1-based integer (got ${cue.slide}).`);
  }
  return {
    time: parseTime(cue.time),
    slide: Math.floor(slide),
    transition: cue.transition || 'cut',
    label: typeof cue.label === 'string' ? cue.label : undefined,
  };
}

function normaliseSubtitle(s, i, baseUrl, gateways) {
  if (!s || typeof s !== 'object' || !s.src) return null;
  const src = resolveSrc(String(s.src), baseUrl, gateways);
  let format = s.format ? String(s.format).toLowerCase() : '';
  if (format !== 'vtt' && format !== 'srt') {
    format = /\.srt(\?|#|$)/i.test(src) ? 'srt' : 'vtt';
  }
  return {
    lang: s.lang ? String(s.lang) : `track-${i + 1}`,
    label: s.label ? String(s.label) : (s.lang ? String(s.lang) : `Track ${i + 1}`),
    src,
    format,
    default: !!s.default,
  };
}

const CAPTION_PLACEMENTS = ['window', 'video'];

function normaliseLayout(layout = {}) {
  let split = Number(layout.split);
  if (!Number.isFinite(split)) split = 0.6;
  split = Math.min(0.85, Math.max(0.15, split));
  const mode = LAYOUT_MODES.includes(layout.mode) ? layout.mode : 'split';
  const transition = typeof layout.transition === 'string' ? layout.transition : 'fade';
  // Caption placement: 'window' overlays captions along the bottom of the WHOLE
  // player (slides + video, all layout modes incl. fullscreen) — the default;
  // 'video' keeps them inside the video pane only. See SPEC.md / SubtitleController.
  const captionPlacement = CAPTION_PLACEMENTS.includes(layout.captionPlacement)
    ? layout.captionPlacement : 'window';
  return { split, mode, transition, captionPlacement };
}

// Resolve a src to a fetchable URL. ipfs:// → primary gateway URL; magnet: left
// for the provider/deck-adapter to fetch from the swarm; bare tokens (a YouTube
// id) untouched; everything else resolved against the manifest's base URL.
function resolveSrc(src, baseUrl, gateways) {
  if (typeof src !== 'string') return src;
  if (isMagnet(src)) return src;
  if (isIpfs(src)) return ipfsGatewayUrls(src, gateways)[0];
  if (isArweave(src)) return arweaveGatewayUrls(src)[0];
  if (isHttp(src) || src.startsWith('/') || src.startsWith('./') ||
      src.includes('/') || /\.[a-z0-9]+$/i.test(src)) {
    return new URL(src, baseUrl).href;
  }
  return src;
}

// Optional authored thumbnails → list with resolved srcs. Accepts a plain array
// of URL strings (indexed by slide) or an array of {slide, src}. Returns
// undefined when none/invalid so the deck adapter falls back to its own render.
function normaliseThumbnails(thumbs, baseUrl, gateways) {
  if (!Array.isArray(thumbs) || !thumbs.length) return undefined;
  if (typeof thumbs[0] === 'string') {
    return thumbs.map((u) => (typeof u === 'string' ? resolveSrc(u, baseUrl, gateways) : u));
  }
  const out = thumbs
    .filter((t) => t && t.src != null && Number.isFinite(Number(t.slide)))
    .map((t) => ({ slide: Math.floor(Number(t.slide)), src: resolveSrc(String(t.src), baseUrl, gateways) }));
  return out.length ? out : undefined;
}

// Carry through any extra deck keys (adapter hints) without the known ones.
function stripKnownDeck(deck) {
  const { type, src, sources, slideCount, thumbnails, ...rest } = deck;
  return rest;
}

function arrayOfStrings(v) {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x) => typeof x === 'string' && x.trim());
  return out.length ? out : null;
}

function str(v) { return typeof v === 'string' ? v : ''; }
