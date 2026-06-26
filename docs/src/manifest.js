// manifest.js — load, validate, and normalise a presentation manifest.
//
// Schema (see README for the canonical version):
// {
//   "title": "string",
//   "video": { "provider": "youtube|mp4", "src": "<id-or-url>" },
//   "deck":  { "type": "html|pdf", "src": "slides/index.html" },
//   "sync":  [ { "time": 0.0, "slide": 1, "transition": "cut" }, ... ]
// }
//
// `time` may be a float (seconds) or an "HH:MM:SS.mmm" string; we normalise it
// to float seconds here. Relative `src` paths are resolved against the manifest
// URL so content can live on any remote host (the resolver use case).

import { parseTime } from './time.js';

/**
 * Fetch + parse + normalise a manifest from a URL.
 * @param {string} url absolute or relative URL to a manifest.json
 * @returns {Promise<object>} normalised manifest with absolute asset URLs
 */
export async function loadManifest(url) {
  const manifestUrl = new URL(url, window.location.href).href;
  let res;
  try {
    res = await fetch(manifestUrl, { mode: 'cors' });
  } catch (err) {
    throw new Error(`Could not fetch manifest (${manifestUrl}): ${err.message}. ` +
      `If it lives on another host, that host must send CORS headers.`);
  }
  if (!res.ok) throw new Error(`Manifest fetch failed: HTTP ${res.status} for ${manifestUrl}`);
  let raw;
  try {
    raw = await res.json();
  } catch (err) {
    throw new Error(`Manifest is not valid JSON (${manifestUrl}): ${err.message}`);
  }
  return normaliseManifest(raw, manifestUrl);
}

/**
 * Validate + normalise a raw manifest object.
 * @param {object} raw
 * @param {string} baseUrl URL the manifest was loaded from (for resolving src)
 * @returns {object}
 */
export function normaliseManifest(raw, baseUrl = window.location.href) {
  if (!raw || typeof raw !== 'object') throw new Error('Manifest must be an object.');
  if (!raw.video || typeof raw.video !== 'object') throw new Error('Manifest.video is required.');
  if (!raw.deck || typeof raw.deck !== 'object') throw new Error('Manifest.deck is required.');
  if (!raw.video.provider) throw new Error('Manifest.video.provider is required.');
  if (!raw.video.src) throw new Error('Manifest.video.src is required.');
  if (!raw.deck.type) throw new Error('Manifest.deck.type is required.');
  if (!raw.deck.src) throw new Error('Manifest.deck.src is required.');

  // Resolve deck src against the manifest base. YouTube ids and bare values are
  // left alone (no scheme / not a path); only path-like / url-like srcs resolve.
  const deckSrc = resolveSrc(raw.deck.src, baseUrl);
  const videoSrc = raw.video.provider === 'mp4'
    ? resolveSrc(raw.video.src, baseUrl)
    : raw.video.src; // youtube id, magnet, cid, etc. stay verbatim

  const sync = (Array.isArray(raw.sync) ? raw.sync : [])
    .map((cue, i) => normaliseCue(cue, i))
    .sort((a, b) => a.time - b.time);

  return {
    title: typeof raw.title === 'string' ? raw.title : 'Untitled presentation',
    video: { provider: String(raw.video.provider), src: videoSrc },
    deck: { type: String(raw.deck.type), src: deckSrc, ...stripKnown(raw.deck) },
    sync,
    baseUrl,
    _raw: raw,
  };
}

function normaliseCue(cue, i) {
  if (!cue || typeof cue !== 'object') throw new Error(`sync[${i}] must be an object.`);
  const slide = Number(cue.slide);
  if (!Number.isFinite(slide) || slide < 1) {
    throw new Error(`sync[${i}].slide must be a 1-based integer (got ${cue.slide}).`);
  }
  return {
    time: parseTime(cue.time),
    slide: Math.floor(slide),
    transition: cue.transition || 'cut',
    label: typeof cue.label === 'string' ? cue.label : undefined,
  };
}

// Resolve a src that looks like a path/URL; leave bare tokens (ids) untouched.
function resolveSrc(src, baseUrl) {
  if (typeof src !== 'string') return src;
  if (/^[a-z]+:\/\//i.test(src) || src.startsWith('/') || src.startsWith('./') ||
      src.includes('/') || /\.[a-z0-9]+$/i.test(src)) {
    return new URL(src, baseUrl).href;
  }
  return src;
}

// Carry through any extra deck keys (e.g. adapter hints) without type/src.
function stripKnown(deck) {
  const { type, src, ...rest } = deck;
  return rest;
}
