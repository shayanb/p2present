// pdf-deck.js — adapter for PDF decks, rendered page-by-page with pdf.js.
//
// pdf.js is loaded from a CDN (jsDelivr) as an ES module so the fork story
// stays build-free. Each PDF page is a slide (1-based, matching manifest sync).
// Page canvases are rendered on demand and cached; slide swaps use the shared
// transition registry so cut/fade/slide/none all work here.

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
    this._canvases = new Map();
    this._thumbs = new Map();
    const first = await this._ensurePage(1);
    first.style.display = '';     // reveal slide 1 (goTo(1) would early-return)
    this._current = 1;
    this.emit('ready');
  }

  get slideCount() { return this._total || 1; }

  async _ensurePage(n) {
    if (this._canvases.has(n)) return this._canvases.get(n);
    const page = await this.doc.getPage(n);
    // Render at 2x for crispness; CSS scales it to fit.
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.className = 'p2-pdf-page';
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.display = 'none';
    this.stage.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    this._canvases.set(n, canvas);
    return canvas;
  }

  /** @param {number} slide 1-based */
  async goTo(slide, opts = {}) {
    const n = Math.min(this.slideCount, Math.max(1, Math.floor(slide)));
    if (n === this._current && this._canvases.has(n)) return;
    const direction = opts.direction ?? (n >= this._current ? 1 : -1);
    const outgoing = this._canvases.get(this._current);
    const incoming = await this._ensurePage(n);
    // Prefetch the neighbour in the travel direction.
    const ahead = n + direction;
    if (ahead >= 1 && ahead <= this.slideCount) this._ensurePage(ahead).catch(() => {});

    this._current = n;
    const transition = getTransition(opts.transition || 'cut');
    await transition.run({ incoming, outgoing, container: this.stage, direction });
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
