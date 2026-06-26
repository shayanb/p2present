// decks/base.js — BaseDeckAdapter, in its own module so adapter subclasses can
// `extends` it without a circular dependency on the registry in index.js.
// See index.js for the full DeckAdapter interface contract.

import { isMagnet, webtorrentBlobUrl, DEFAULT_WEBTORRENT_TRACKERS } from '../resolve.js';

export class BaseDeckAdapter {
  constructor({ src, mount, manifest }) {
    this.src = src;
    this.mount = mount;
    this.manifest = manifest;
    this._handlers = Object.create(null);
    this._current = 1;
  }

  // Resolve a P2P deck source to a fetchable URL. ipfs:// sources are already
  // expanded to gateway URLs by the manifest loader; magnet: links are fetched
  // from the swarm here and exposed as a Blob URL the <iframe>/pdf can load.
  // Call at the top of load(): `this.src = await this._resolveDeckSrc();`
  async _resolveDeckSrc(matchRe) {
    if (!isMagnet(this.src)) return this.src;
    const trackers = this.manifest?.resolvers?.webtorrentTrackers?.length
      ? this.manifest.resolvers.webtorrentTrackers : DEFAULT_WEBTORRENT_TRACKERS;
    this._blobUrl = await webtorrentBlobUrl(this.src, { trackers, matchRe });
    return this._blobUrl;
  }

  on(event, fn) { (this._handlers[event] ||= []).push(fn); return this; }
  emit(event, payload) {
    (this._handlers[event] || []).forEach((fn) => {
      try { fn(payload); } catch (e) { console.error(e); }
    });
  }
  get currentSlide() { return this._current; }
  get slideCount() { return 0; }
  async load() {}
  async goTo() {}

  /**
   * A small preview for `slide` (1-based), used by the scrubber thumbnail.
   * Returns `{ src }` (an image URL or data URL) or `null` when none is
   * available. The base implementation serves *authored* thumbnails declared in
   * the manifest (`deck.thumbnails`) — already resolved to URLs by the loader —
   * which works for any deck type; adapters may override to render their own
   * (e.g. the PDF adapter rasterises the page). See decks/index.js.
   */
  async thumbnail(slide) {
    const t = this.manifest?.deck?.thumbnails;
    if (Array.isArray(t) && t.length) {
      const n = Math.max(1, Math.floor(slide));
      const src = typeof t[0] === 'string'
        ? t[n - 1]
        : (t.find((x) => Number(x.slide) === n)?.src);
      if (src) return { src };
    }
    return null;
  }
  destroy() {
    this._handlers = Object.create(null);
    if (this._blobUrl) { try { URL.revokeObjectURL(this._blobUrl); } catch {} }
  }
}
