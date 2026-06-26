// pdf-deck.js — adapter for PDF decks, rendered page-by-page with pdf.js.
//
// pdf.js is loaded from a CDN (jsDelivr) as an ES module so the fork story
// stays build-free. Each PDF page is a slide (1-based, matching manifest sync).
// Page canvases are rendered on demand and cached; slide swaps use the shared
// transition registry so cut/fade/slide/none all work here.
//
// Visibility is owned authoritatively by the adapter, NOT by the transition.
// Every navigation ends in _commit(), which forces exactly one canvas visible
// (display + opacity reset, stray Web-Animations cancelled) and hides the rest.
// This is what keeps slides from going black: a transition's persisted opacity/
// transform fill (or an overlapping/superseded transition) can no longer leave a
// canvas shown-but-transparent or hidden-but-current — _commit always reconciles
// to the real target slide. A monotonic nav token means only the newest goTo()
// finalizes, so rapid slide changes can't fight each other.
//
// CONTENT, not just DOM state: a cached canvas can also lose its *pixels* — the
// browser purges the backing store of large off-screen canvases under memory
// pressure, so a page rendered earlier shows blank/black when you scrub BACK to
// it. _commit only reconciles visibility, never content. So the page that is
// becoming active is always re-rendered fresh (_renderPage force) before it is
// shown, guaranteeing real pixels regardless of travel direction. Renders are
// cancellable by a per-canvas token; a render cancelled by a newer nav is fine
// because that newer nav force-renders its own page, so the final active page
// always ends rendered.

import { BaseDeckAdapter } from './base.js';
import { getTransition } from '../transitions/index.js';

const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs';

export class PdfDeckAdapter extends BaseDeckAdapter {
  async load() {
    this.src = await this._resolveDeckSrc(/\.pdf$/i);  // magnet: → Blob URL
    const pdfjsLib = await import(/* @vite-ignore */ PDFJS_URL);
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;

    this.stage = document.createElement('div');
    this.stage.className = 'p2-pdf-stage';
    this.mount.appendChild(this.stage);

    this.doc = await pdfjsLib.getDocument(this.src).promise;
    this._total = this.doc.numPages;
    this._canvases = new Map();   // n -> <canvas> (element reused across renders)
    this._pages = new Map();      // n -> pdf.js page object (retained, never purges)
    this._thumbs = new Map();
    this._navToken = 0;
    await this._renderPage(1, { force: true });
    this._current = 1;
    this._commit(1);            // reveal slide 1 in a known-good state
    this.emit('ready');
  }

  get slideCount() { return this._total || 1; }

  // The <canvas> element for page n, created + registered + mounted synchronously
  // so two concurrent renders for the same page can't spawn duplicate canvases.
  _canvasFor(n) {
    let canvas = this._canvases.get(n);
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'p2-pdf-page';
      canvas.style.display = 'none';
      this.stage.appendChild(canvas);
      this._canvases.set(n, canvas);
    }
    return canvas;
  }

  async _getPage(n) {
    let page = this._pages.get(n);
    if (!page) { page = await this.doc.getPage(n); this._pages.set(n, page); }
    return page;
  }

  /**
   * Ensure page `n` is rendered into its (cached) canvas with real pixels.
   * `force` re-rasterises even a canvas we previously rendered — needed because
   * the browser may have purged its backing store. The in-flight render task is
   * tracked per canvas and cancelled if a fresher render for the same page starts.
   * Returns the canvas (rendered) — or, if the render was superseded/cancelled,
   * resolves once it settles (the caller re-checks the nav token).
   */
  async _renderPage(n, { force = false } = {}) {
    const canvas = this._canvasFor(n);
    if (canvas._rendered && !force) return canvas;
    try { canvas._renderTask?.cancel(); } catch {}
    const page = await this._getPage(n);
    // Render at 2x for crispness; CSS scales it to fit. Setting width also clears
    // the canvas, so we only paint pixels via the render task below.
    const viewport = page.getViewport({ scale: 2 });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas._rendered = false;
    const task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
    canvas._renderTask = task;
    try {
      await task.promise;
      if (canvas._renderTask === task) { canvas._rendered = true; canvas._renderTask = null; }
    } catch {
      // RenderingCancelledException (a newer render won) — leave _rendered false
      // so this page re-renders next time it becomes active.
      if (canvas._renderTask === task) canvas._renderTask = null;
    }
    return canvas;
  }

  /** @param {number} slide 1-based */
  async goTo(slide, opts = {}) {
    const n = Math.min(this.slideCount, Math.max(1, Math.floor(slide)));
    // Re-run even when n === _current if the current canvas isn't actually shown
    // (e.g. a prior transition left it hidden) so we always self-heal to visible.
    if (n === this._current && this._isShown(n)) return;
    const token = ++this._navToken;
    const direction = opts.direction ?? (n >= this._current ? 1 : -1);
    const outgoing = this._canvases.get(this._current);
    // Force a fresh render of the page becoming active so a purged/blank cached
    // canvas is restored before it's shown (the core back-and-forth black-slide fix).
    const incoming = await this._renderPage(n, { force: true });
    if (token !== this._navToken) return;     // superseded while awaiting render
    // Prefetch the neighbour in the travel direction (cheap cache warm-up).
    const ahead = n + direction;
    if (ahead >= 1 && ahead <= this.slideCount) this._renderPage(ahead).catch(() => {});

    this._current = n;
    // Clear any persisted animation state on the incoming canvas before it
    // animates in, so it never starts from a stale opacity/transform fill.
    this._resetCanvas(incoming);
    const transition = getTransition(opts.transition || 'cut');
    try {
      await transition.run({
        incoming,
        outgoing: outgoing && outgoing !== incoming ? outgoing : null,
        container: this.stage,
        direction,
      });
    } catch { /* a cancelled/failed animation must not strand the slide */ }
    if (token !== this._navToken) return;     // a newer nav owns the final state
    this._commit(n);
  }

  // True when canvas `n` is the visible one (display set + not transparent).
  _isShown(n) {
    const c = this._canvases.get(n);
    if (!c) return false;
    return c.style.display !== 'none' && c.style.opacity !== '0';
  }

  // Cancel stray animations + clear inline opacity/transform on one canvas.
  _resetCanvas(c) {
    if (!c) return;
    try { c.getAnimations().forEach((a) => a.cancel()); } catch {}
    c.style.opacity = '';
    c.style.transform = '';
  }

  // Authoritative end state: exactly canvas `n` visible and pristine, all other
  // rendered canvases hidden and reset. Idempotent; safe to call repeatedly.
  _commit(n) {
    for (const [k, c] of this._canvases) {
      this._resetCanvas(c);
      c.style.display = (k === n) ? '' : 'none';
    }
  }

  /**
   * Rasterise a low-res preview of page `slide` (1-based) as a JPEG data URL,
   * cached per page. Authored thumbnails (manifest `deck.thumbnails`) still win
   * via the base class; this is the auto-generated fallback for PDF decks.
   */
  async thumbnail(slide) {
    const authored = await super.thumbnail(slide);
    if (authored) return authored;
    if (!this.doc) return null;
    const n = Math.min(this.slideCount, Math.max(1, Math.floor(slide)));
    if (this._thumbs.has(n)) return this._thumbs.get(n);
    try {
      const page = await this.doc.getPage(n);
      const viewport = page.getViewport({ scale: 0.35 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const out = { src: canvas.toDataURL('image/jpeg', 0.7) };
      this._thumbs.set(n, out);
      return out;
    } catch {
      return null;   // a failed render just means "no thumbnail" — never throws
    }
  }

  destroy() {
    super.destroy();
    try { this.doc?.destroy(); } catch {}
    this.stage?.remove();
  }
}
