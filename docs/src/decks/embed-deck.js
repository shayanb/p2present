// embed-deck.js — adapter for EXTERNAL, embeddable slide decks shown in an
// <iframe>: Google Slides (publish-to-web embed), SpeakerDeck, Canva, generic
// slide URLs, etc. This is intentionally minimal — the embedded player is a
// third-party, cross-origin surface we can't script, so the deck is display-only
// and the slide counter is driven from the manifest (deck.slideCount / sync
// cues), NOT from the iframe.
//
// Best-effort sync: most embeds support deep-linking to a slide via the URL.
// Authors can opt in with deck.embed = { nav: "hash" | "query", param: "slide",
// offset: 1 }, and goTo() will update the iframe URL accordingly. With no config
// the deck simply displays and the video timeline + scrubber still work; tight
// slide↔video sync wants an "html" or "pdf" deck instead (see AUTHORING.md).

import { BaseDeckAdapter } from './base.js';

// Google Slides share/edit/present URLs aren't embeddable as-is (they open the
// editor and need auth). Rewrite any docs.google.com/presentation link to its
// /embed form so pasting the normal URL Just Works. Handles both /d/<id>/… and
// published /d/e/<id>/… forms; leaves every other URL untouched.
export function normalizeEmbedUrl(src) {
  const s = String(src || '');
  const m = s.match(/docs\.google\.com\/presentation\/d\/(e\/[\w-]+|[\w-]+)/);
  if (!m) return src;
  return `https://docs.google.com/presentation/d/${m[1]}/embed?start=false&loop=false&rm=minimal`;
}

export class EmbedDeckAdapter extends BaseDeckAdapter {
  async load() {
    this.src = normalizeEmbedUrl(await this._resolveDeckSrc());   // magnet: → Blob URL (rare for embeds)
    this._embed = this.manifest?.deck?.embed || null;
    this._base = this.src;

    const iframe = document.createElement('iframe');
    iframe.className = 'p2-deck-frame p2-embed-frame';
    iframe.setAttribute('title', this.manifest?.title || 'Slides');
    iframe.allow = 'fullscreen; autoplay; encrypted-media; picture-in-picture';
    iframe.referrerPolicy = 'no-referrer-when-downgrade';
    iframe.src = this._urlForSlide(1);
    this.iframe = iframe;
    this.mount.appendChild(iframe);

    // Cross-origin embeds don't always fire `load` reliably; resolve on load OR a
    // short timeout so the player never stalls waiting for a foreign frame.
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      iframe.addEventListener('load', finish, { once: true });
      setTimeout(finish, 4000);
    });
    this.emit('ready');
  }

  get slideCount() {
    if (Number.isFinite(this.manifest?.deck?.slideCount)) return this.manifest.deck.slideCount;
    const cues = this.manifest?.sync || [];
    return Math.max(1, cues.reduce((m, c) => Math.max(m, c.slide), 1));
  }

  /** @param {number} slide 1-based */
  async goTo(slide) {
    const n = Math.min(this.slideCount, Math.max(1, Math.floor(slide)));
    if (n === this._current) return;
    this._current = n;
    // Only navigate when the author configured deep-linking; otherwise leave the
    // embedded player alone (reloading a generic embed on every cue is worse than
    // letting it run). Hash nav avoids a reload; query nav reloads the frame.
    if (this._embed && this.iframe) {
      const next = this._urlForSlide(n);
      if (next !== this.iframe.src) this.iframe.src = next;
    }
  }

  _urlForSlide(n) {
    const cfg = this._embed;
    if (!cfg) return this._base;
    const value = n + (Number.isFinite(cfg.offset) ? cfg.offset - 1 : 0);
    const param = cfg.param || 'slide';
    const base = this._base.split('#')[0];
    if (cfg.nav === 'hash') return `${base}#${param}=${value}`;
    if (cfg.nav === 'query') {
      try { const u = new URL(base); u.searchParams.set(param, String(value)); return u.href; }
      catch { return `${base}${base.includes('?') ? '&' : '?'}${param}=${value}`; }
    }
    return this._base;
  }

  destroy() {
    super.destroy();
    this.iframe?.remove();
  }
}
