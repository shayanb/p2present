// subtitles.js — caption loading + rendering.
//
// Loads the manifest's subtitles[] (WebVTT or SubRip/.srt — .srt is converted to
// WebVTT in-browser at load), and renders them through one of two paths, chosen
// by the caption *placement* setting (manifest layout.captionPlacement, or the
// user's choice in the Subtitles menu):
//
//   * 'window' (default) — a synced overlay div mounted on the whole player
//                          stage, pinned bottom-centre so captions read clearly
//                          over slides + video together, in every layout mode and
//                          in fullscreen. Driven by update(time) from the sync
//                          clock; works for ANY provider (YouTube or mp4).
//   * 'video'            — captions stay inside the video pane only. For a real
//                          <video> element (mp4) that means native <track> the
//                          browser renders + styles; for providers without one
//                          (YouTube iframe) it falls back to the synced overlay
//                          positioned within the video pane.
//
// A SubtitleController is created per presentation by the Player, which calls
// update(time) every frame from its state callback and exposes list()/setActive()
// + getPlacement()/setPlacement() to the Subtitles menu.

import { parseTime } from './time.js';

export class SubtitleController {
  /** @param {{tracks:Array, video:object, mount:HTMLElement, windowMount?:HTMLElement, placement?:string}} opts */
  constructor({ tracks, video, mount, windowMount, placement }) {
    this.tracks = Array.isArray(tracks) ? tracks : [];
    this.video = video;
    this.mount = mount;                 // the video pane mount
    this.windowMount = windowMount || mount;   // the whole-player stage
    this.placement = placement === 'video' ? 'video' : 'window';
    this.entries = [];        // {lang,label,default,cues,vttText,trackEl?}
    this.activeLang = null;
    this.activeEntry = null;
    this._blobUrls = [];
    this._renderMode = 'overlay';   // 'overlay' | 'native'
    this._listeners = [];
  }

  on(fn) { this._listeners.push(fn); return this; }
  _emit() { this._listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }

  hasTracks() { return this.entries.length > 0; }

  /** Fetch + parse every subtitle source, then wire up the renderers. */
  async load() {
    const loaded = await Promise.all(this.tracks.map(async (t) => {
      try {
        const text = await fetchText(t.src);
        const cues = t.format === 'srt' ? parseSRT(text) : parseVTT(text);
        const vttText = t.format === 'srt' ? serializeVTT(cues) : text;
        return { ...t, cues, vttText };
      } catch (err) {
        console.warn(`[subtitles] failed to load ${t.src}:`, err.message);
        return null;
      }
    }));
    this.entries = loaded.filter(Boolean);
    if (!this.entries.length) return this;

    this.videoEl = this.video?.getElement?.() || null;
    this._buildOverlay();                              // always available
    if (this.videoEl) this._buildNativeTracks(this.videoEl);  // only when a <video> exists
    this._applyPlacement();

    const def = this.entries.find((e) => e.default);
    this.setActive(def ? def.lang : null);
    return this;
  }

  _buildNativeTracks(videoEl) {
    for (const e of this.entries) {
      const blob = new Blob([e.vttText], { type: 'text/vtt' });
      const url = URL.createObjectURL(blob);
      this._blobUrls.push(url);
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = e.label;
      track.srclang = e.lang;
      track.src = url;
      videoEl.appendChild(track);
      e.trackEl = track;
    }
    // Tracks start disabled; setActive()/_applyPlacement() turn the chosen one on.
    requestAnimationFrame(() => {
      for (const e of this.entries) if (e.trackEl?.track) e.trackEl.track.mode = 'disabled';
    });
  }

  _buildOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'p2-cc-overlay';
    overlay.setAttribute('aria-live', 'polite');
    overlay.hidden = true;
    this.overlay = overlay;   // parented by _applyPlacement
  }

  /**
   * Decide the active renderer + where the overlay lives, from this.placement.
   * 'window' → overlay on the whole-player stage; 'video' → native <track> when a
   * <video> exists, else overlay inside the video pane. Idempotent.
   */
  _applyPlacement() {
    if (!this.overlay) return;
    const native = (this.placement === 'video' && !!this.videoEl);
    this._renderMode = native ? 'native' : 'overlay';

    if (native) {
      this.overlay.remove();                 // hide the synced overlay entirely
      this.overlay.hidden = true;
    } else {
      const parent = this.placement === 'window' ? this.windowMount : this.mount;
      this.overlay.classList.toggle('p2-cc-window', this.placement === 'window');
      if (this.overlay.parentElement !== parent) parent.appendChild(this.overlay);
    }
    // Disable native tracks whenever the overlay is the active renderer so the
    // browser doesn't double-render captions inside the <video>.
    if (!native) for (const e of this.entries) if (e.trackEl?.track) e.trackEl.track.mode = 'disabled';
    this._lastText = null;                    // force the next update() to repaint
    this.setActive(this.activeLang);          // re-apply the chosen language
  }

  /** Current placement ('window' | 'video'). */
  getPlacement() { return this.placement; }

  /** Change caption placement and re-wire the renderer live. */
  setPlacement(placement) {
    const p = placement === 'video' ? 'video' : 'window';
    if (p === this.placement) return;
    this.placement = p;
    this._applyPlacement();
    this._emit();
  }

  /** Cues for the menu: [{lang, label, default}]. */
  list() {
    return this.entries.map((e) => ({ lang: e.lang, label: e.label, default: e.default }));
  }

  getActive() { return this.activeLang; }

  /** Switch active language; pass null/'off' to turn captions off. */
  setActive(lang) {
    this.activeLang = lang || null;
    if (this._renderMode === 'native') {
      for (const e of this.entries) {
        if (e.trackEl?.track) e.trackEl.track.mode = (e.lang === this.activeLang) ? 'showing' : 'disabled';
      }
    } else {
      this.activeEntry = this.entries.find((e) => e.lang === this.activeLang) || null;
      this._lastText = null;
      if (this.overlay && !this.activeEntry) { this.overlay.hidden = true; this.overlay.textContent = ''; }
    }
    this._emit();
  }

  /** Drive the overlay from the sync clock (no-op for native tracks). */
  update(time) {
    if (this._renderMode === 'native' || !this.overlay || !this.activeEntry) return;
    const cue = cueAt(this.activeEntry.cues, time);
    const text = cue ? cue.text : '';
    if (text === this._lastText) return;
    this._lastText = text;
    if (text) {
      // One block per line with dir="auto": each line resolves its own base
      // direction from its first strong character (RTL for Farsi/Arabic/Hebrew),
      // so Latin words embedded in an RTL line keep their correct order instead
      // of being laid out against the page's LTR direction.
      this.overlay.innerHTML = text.split('\n')
        .map((line) => `<span class="p2-cc-line" dir="auto">${escapeHtml(line)}</span>`)
        .join('');
      this.overlay.hidden = false;
    } else {
      this.overlay.hidden = true;
      this.overlay.textContent = '';
    }
  }

  destroy() {
    this._blobUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch {} });
    this._blobUrls = [];
    this.entries.forEach((e) => e.trackEl?.remove());
    this.overlay?.remove();
    this._listeners = [];
  }
}

// --- parsing ---------------------------------------------------------------

async function fetchText(url) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Find the cue active at time t (binary-search-free; cue lists are small). */
function cueAt(cues, t) {
  let active = null;
  for (const c of cues) {
    if (c.start <= t && t < c.end) { active = c; break; }
    if (c.start > t) break;
  }
  return active;
}

/**
 * Parse a WebVTT string into [{start,end,text}] (seconds). Tolerant of headers,
 * NOTE blocks, cue identifiers, and trailing cue settings after the end time.
 */
export function parseVTT(input) {
  const text = String(input).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^﻿/, '');
  const blocks = text.split(/\n\n+/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.length || true);
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx === -1) continue;                       // header / NOTE / metadata
    const time = parseCueTiming(lines[idx]);
    if (!time) continue;
    const body = lines.slice(idx + 1).join('\n').trim();
    if (body) cues.push({ start: time.start, end: time.end, text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Parse a SubRip (.srt) string into [{start,end,text}] (seconds). */
export function parseSRT(input) {
  const text = String(input).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^﻿/, '');
  const blocks = text.split(/\n\n+/);
  const cues = [];
  for (const block of blocks) {
    let lines = block.split('\n');
    // Drop a leading numeric index line if present.
    if (lines.length && /^\d+$/.test(lines[0].trim())) lines = lines.slice(1);
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx === -1) continue;
    const time = parseCueTiming(lines[idx].replace(/,/g, '.'));
    if (!time) continue;
    const body = lines.slice(idx + 1).join('\n').trim();
    if (body) cues.push({ start: time.start, end: time.end, text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function parseCueTiming(line) {
  const m = line.split('-->');
  if (m.length < 2) return null;
  try {
    const start = parseTime(m[0].trim().split(/\s+/)[0]);
    const end = parseTime(m[1].trim().split(/\s+/)[0]);
    if (!isFinite(start) || !isFinite(end)) return null;
    return { start, end };
  } catch { return null; }
}

/** Serialise cues back into a minimal WebVTT document (for native <track>). */
export function serializeVTT(cues) {
  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(h)}:${p(m)}:${p(sec)}.${p(ms, 3)}`;
  };
  let out = 'WEBVTT\n\n';
  cues.forEach((c, i) => {
    out += `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}\n\n`;
  });
  return out;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
