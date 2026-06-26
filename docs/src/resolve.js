// resolve.js — shared decentralized-source helpers.
//
// One place that knows how to recognise and resolve the three transport kinds
// p2present speaks: plain http(s), ipfs:// CIDs, and magnet: links. Used by the
// manifest loader (to fetch a presentation + its assets from any of them), by
// the IPFS/WebTorrent video providers, and by the deck adapters (P2P decks).

export const DEFAULT_IPFS_GATEWAYS = [
  'https://{cid}.ipfs.dweb.link',
  'https://ipfs.io/ipfs/{cid}',
  'https://cloudflare-ipfs.com/ipfs/{cid}',
];
export const DEFAULT_WEBTORRENT_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.files.fm:7073/announce',
];

// --- recognisers -----------------------------------------------------------

export function isMagnet(s) {
  return typeof s === 'string' && /^magnet:\?/i.test(s.trim());
}

// ipfs:// URI, or a bare CIDv0 (Qm…) / CIDv1 (bafy…/bafk…), optionally with a path.
export function isIpfs(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  return /^ipfs:\/\//i.test(t) ||
    /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|ba[a-z2-7]{57,})(\/|$)/.test(t);
}

export function isHttp(s) {
  return typeof s === 'string' && /^https?:\/\//i.test(s.trim());
}

// Strip the ipfs:// (or ipfs/) prefix → "<cid>[/<path>]".
export function ipfsPath(uri) {
  return String(uri).trim()
    .replace(/^ipfs:\/\//i, '')
    .replace(/^ipfs\//i, '');
}

/**
 * Expand an ipfs:// URI / CID into an ordered list of HTTP gateway URLs to try.
 * Templates use `{cid}` (substituted with the CID); any sub-path is appended.
 * A template without `{cid}` is treated as a gateway root (…/ipfs/<cid> form).
 */
export function ipfsGatewayUrls(uri, gateways = DEFAULT_IPFS_GATEWAYS) {
  const path = ipfsPath(uri);
  const [cid, ...rest] = path.split('/');
  const sub = rest.filter(Boolean).join('/');
  return (gateways && gateways.length ? gateways : DEFAULT_IPFS_GATEWAYS).map((tpl) => {
    let u = tpl.includes('{cid}')
      ? tpl.replace('{cid}', cid)
      : tpl.replace(/\/+$/, '') + '/ipfs/' + cid;
    if (sub) u += '/' + sub;
    return u;
  });
}

/**
 * Turn any source string into the ordered list of concrete HTTP URLs to fetch.
 * http(s) → itself; ipfs → gateway list; magnet → [] (use webtorrentFetch).
 */
export function httpCandidates(source, gateways) {
  if (isIpfs(source)) return ipfsGatewayUrls(source, gateways);
  if (isMagnet(source)) return [];
  return [source];
}

// --- fetching --------------------------------------------------------------

/** Fetch the first URL in `urls` that responds OK; return the Response. */
export async function fetchFirstOk(urls, what = 'resource', initOverride) {
  const errors = [];
  for (const u of urls) {
    try {
      const res = await fetch(u, { mode: 'cors', ...initOverride });
      if (res.ok) return { res, url: u };
      errors.push(`${u}: HTTP ${res.status}`);
    } catch (err) {
      errors.push(`${u}: ${err.message}`);
    }
  }
  throw new Error(`Could not fetch ${what}. Tried: ${errors.join(' | ') || '(no candidates)'}`);
}

// --- WebTorrent (lazy browser bundle) --------------------------------------

// The standalone browser bundle that defines `window.WebTorrent` (the v1.x line
// still ships the prebuilt UMD `webtorrent.min.js`; v2+ is ESM-only). Tried in
// order so a single CDN hiccup doesn't kill p2p playback.
const WEBTORRENT_CDNS = [
  'https://cdn.jsdelivr.net/npm/webtorrent@1.9.7/webtorrent.min.js',
  'https://unpkg.com/webtorrent@1.9.7/webtorrent.min.js',
];
let _wtClient = null;
let _wtLoading = null;

function injectScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.dataset.p2 = 'webtorrent';
    s.addEventListener('load', () => {
      if (window.WebTorrent) resolve(window.WebTorrent);
      else reject(new Error('WebTorrent bundle loaded but global missing'));
    }, { once: true });
    s.addEventListener('error', () => { s.remove(); reject(new Error(`failed to load ${url}`)); }, { once: true });
    document.head.appendChild(s);
  });
}

async function loadWebTorrentGlobal() {
  if (window.WebTorrent) return window.WebTorrent;
  const errors = [];
  for (const url of WEBTORRENT_CDNS) {
    try { return await injectScript(url); }
    catch (err) { errors.push(err.message); }
  }
  throw new Error('Could not load the WebTorrent browser bundle. ' + errors.join(' | '));
}

/** Lazily load the WebTorrent browser bundle and return a shared client. */
export async function getWebTorrentClient() {
  if (_wtClient) return _wtClient;
  if (!_wtLoading) {
    _wtLoading = loadWebTorrentGlobal().then((WT) => {
      _wtClient = new WT();
      _wtClient.on('error', (e) => console.warn('[webtorrent] client error:', e?.message || e));
      return _wtClient;
    });
  }
  await _wtLoading;
  return _wtClient;
}

/**
 * Add a magnet, pick the file matching `matchRe` (or the largest), and hand the
 * torrent file to `onFile(file, torrent)`. Rejects on timeout / no peers.
 */
export function withTorrentFile(magnet, { trackers, matchRe, timeoutMs = 45000 } = {}) {
  return new Promise(async (resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; clearTimeout(timer); fn(arg); } };
    const timer = setTimeout(
      () => finish(reject, new Error('WebTorrent timed out (no peers / blocked). Falling back.')),
      timeoutMs,
    );
    try {
      const client = await getWebTorrentClient();
      const opts = trackers && trackers.length ? { announce: trackers } : {};
      client.add(magnet, opts, (torrent) => {
        const file = (matchRe && torrent.files.find((f) => matchRe.test(f.name)))
          || torrent.files.slice().sort((a, b) => b.length - a.length)[0];
        if (!file) return finish(reject, new Error('Torrent contains no usable file.'));
        finish(resolve, { file, torrent });
      });
    } catch (err) {
      finish(reject, err);
    }
  });
}

/** Fetch a file from a magnet as a Blob URL (for <iframe>/<img>/pdf). */
export async function webtorrentBlobUrl(magnet, opts) {
  const { file } = await withTorrentFile(magnet, opts);
  return await new Promise((resolve, reject) => {
    file.getBlobURL((err, url) => (err ? reject(err) : resolve(url)));
  });
}

/** Fetch a file from a magnet as text (for a JSON manifest). */
export async function webtorrentText(magnet, opts) {
  const { file } = await withTorrentFile(magnet, opts);
  const blob = await new Promise((resolve, reject) => {
    file.getBlob((err, b) => (err ? reject(err) : resolve(b)));
  });
  return await blob.text();
}

// --- base64 (UTF-8 safe) ----------------------------------------------------

export function encodeBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
export function decodeBase64(b64) {
  // Tolerate URL-safe variants and stray whitespace.
  const norm = String(b64).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  return decodeURIComponent(escape(atob(norm)));
}
