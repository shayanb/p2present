// player.js — orchestrates a manifest into a running presentation:
// builds the deck adapter + video provider (trying each source in order until
// one loads), wires the SyncEngine between them, and renders the control bar +
// input handling (keyboard, wheel, scrub, speed, link/unlink), the layout-mode
// switcher (split / slides-focus / video-focus / overlap PiP) with a draggable
// divider + fullscreen, and the subtitle (CC) menu. Everything domain-specific
// lives in the adapters/providers; this file is the glue + chrome.

import { deckAdapters } from './decks/index.js';
import { videoProviders } from './video/index.js';
import { SyncEngine } from './sync.js';
import { SubtitleController } from './subtitles.js';
import { formatTime } from './time.js';

const SPEEDS = [0.75, 1, 1.1, 1.25, 1.5, 1.75, 2];
const MODES = [
  { id: 'split',        icon: '▥', label: 'Split (side by side)' },
  { id: 'slides-focus', icon: '▢', label: 'Slides focus' },
  { id: 'video-focus',  icon: '▣', label: 'Video focus' },
  { id: 'overlap',      icon: '◳', label: 'Overlap (video as floating PiP)' },
];
const LS = {
  split: 'p2present:split',
  mode: 'p2present:mode',
  pip: 'p2present:pip',
};
const FOCUS_GROW = 0.78;   // weight of the dominant pane in the focus modes

export class Player {
  /** @param {object} manifest normalised manifest @param {HTMLElement} root */
  constructor(manifest, root) {
    this.manifest = manifest;
    this.root = root;
    // Layout defaults come from the manifest; localStorage overrides them.
    this.split = readNum(LS.split, manifest.layout?.split ?? 0.6, 0.15, 0.85);
    this.mode = readStr(LS.mode, manifest.layout?.mode || 'split',
      MODES.map((m) => m.id));
  }

  async mount() {
    this.root.innerHTML = '';
    this.root.classList.add('p2-player');

    // Layout: two panes (deck + video) + a draggable divider, over a control bar.
    const stage = el('div', 'p2-stage');
    stage.dataset.mode = this.mode;
    const deckPane = el('div', 'p2-pane p2-deck-pane');
    const videoPane = el('div', 'p2-pane p2-video-pane');
    const divider = el('div', 'p2-divider');
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-label', 'Resize slides / video');
    divider.tabIndex = 0;
    const deckMount = el('div', 'p2-mount');
    const videoMount = el('div', 'p2-mount');
    deckPane.append(label('Slides'), deckMount);
    videoPane.append(pipHandle('Video'), videoMount, el('div', 'p2-pip-resize'));
    stage.append(deckPane, divider, videoPane);
    const controls = el('div', 'p2-controls');
    this.root.append(stage, controls);
    this.stage = stage;
    this.deckPane = deckPane;
    this.videoPane = videoPane;
    this.divider = divider;

    // Instantiate deck + video by trying each source until one loads.
    this.video = await this._loadFirstWorking(
      videoMount, this.manifest.video.sources, 'video',
      (s) => new (videoProviders.get(s.provider))({
        src: s.src, mount: videoMount, manifest: this.manifest,
        resolvers: this.manifest.resolvers, poster: this.manifest.video.poster,
      }),
      (s) => `${s.provider} (${s.src})`,
    );
    this.deck = await this._loadFirstWorking(
      deckMount, this.manifest.deck.sources, 'deck',
      (s) => new (deckAdapters.get(this.manifest.deck.type))({
        src: s.src, mount: deckMount, manifest: this.manifest,
      }),
      (s) => s.src,
    );

    // Subtitles (captions). Native <track> for mp4; synced overlay for YouTube.
    this.subs = new SubtitleController({
      tracks: this.manifest.subtitles, video: this.video, mount: videoMount,
    });
    await this.subs.load();

    this.sync = new SyncEngine({
      video: this.video,
      deck: this.deck,
      cues: this.manifest.sync,
      onState: (s) => this._renderState(s),
    });

    this._buildControls(controls);
    this._bindInput();
    this._initDivider();
    this._initPip();
    this.applyLayout();
    this.sync.start();
    return this;
  }

  /**
   * Try each source in order; return the first that loads. Stubs (webtorrent /
   * ipfs) throw and we gracefully fall through to the next source.
   */
  async _loadFirstWorking(mount, sources, kind, make, describe) {
    const errors = [];
    for (const s of sources) {
      let inst;
      try {
        inst = make(s);
      } catch (err) {       // unknown provider / type
        errors.push(`${describe(s)}: ${err.message}`);
        continue;
      }
      try {
        await inst.load();
        if (errors.length) console.info(`[player] ${kind} fell back to ${describe(s)} after: ${errors.join(' | ')}`);
        return inst;
      } catch (err) {
        errors.push(`${describe(s)}: ${err.message}`);
        try { inst.destroy(); } catch {}
        mount.innerHTML = '';
      }
    }
    throw new Error(`No ${kind} source could be loaded. Tried: ${errors.join(' | ') || '(none)'}`);
  }

  // --- controls ------------------------------------------------------------

  _buildControls(bar) {
    this.btnPlay = button('▶', 'Play / pause (space)', () => this._togglePlay());
    this.btnPrev = button('‹', 'Previous slide (←)', () => this.sync.prevSlide());
    this.btnNext = button('›', 'Next slide (→)', () => this.sync.nextSlide());

    // Scrubber (click / drag to seek).
    this.scrub = el('input', 'p2-scrub');
    this.scrub.type = 'range';
    this.scrub.min = 0; this.scrub.max = 1000; this.scrub.value = 0;
    this.scrub.setAttribute('aria-label', 'Seek video');
    this.scrub.addEventListener('input', () => {
      const dur = this.video.getDuration() || 0;
      this.video.seek((this.scrub.value / 1000) * dur);
    });

    this.timeLabel = el('span', 'p2-time'); this.timeLabel.textContent = '0:00 / 0:00';
    this.slideLabel = el('span', 'p2-slidecount'); this.slideLabel.textContent = '1 / 1';

    // Speed selector.
    this.speed = el('select', 'p2-speed');
    this.speed.setAttribute('aria-label', 'Playback speed');
    for (const r of SPEEDS) {
      const o = document.createElement('option');
      o.value = String(r); o.textContent = `${r}×`;
      if (r === 1) o.selected = true;
      this.speed.appendChild(o);
    }
    this.speed.addEventListener('change', () => this.video.setRate(parseFloat(this.speed.value)));

    // Link / unlink sync toggle.
    this.btnLink = button('🔗', 'Sync linked — click to unlink', () => {
      this.sync.setLinked(!this.sync.linked);
    });
    this.btnLink.classList.add('p2-link', 'is-linked');

    // Layout-mode switcher (segmented).
    const modeGroup = el('div', 'p2-modes');
    modeGroup.setAttribute('role', 'group');
    modeGroup.setAttribute('aria-label', 'Layout mode');
    this.modeButtons = {};
    for (const m of MODES) {
      const b = button(m.icon, m.label, () => this.setMode(m.id));
      b.classList.add('p2-mode-btn');
      b.setAttribute('aria-label', m.label);   // icon-only: name it for AT + tooltip
      this.modeButtons[m.id] = b;
      modeGroup.appendChild(b);
    }

    // CC (subtitles) menu — only when tracks exist.
    const ccWrap = this._buildCcMenu();

    // Fullscreen.
    this.btnFs = button('⛶', 'Fullscreen (f)', () => this._toggleFullscreen());
    document.addEventListener('fullscreenchange', this._onFsChange = () => {
      const on = document.fullscreenElement === this.root;
      this.btnFs.classList.toggle('is-on', on);
      this.btnFs.title = on ? 'Exit fullscreen (f)' : 'Fullscreen (f)';
    });

    // Group the layout-mode switcher + fullscreen so they read as one "view"
    // cluster, with a visible "Layout" caption (especially helpful on mobile,
    // where the icon-only buttons are otherwise unrecognisable).
    const layoutGroup = el('div', 'p2-layout-group');
    layoutGroup.setAttribute('role', 'group');
    layoutGroup.setAttribute('aria-label', 'Layout and view');
    const layoutLabel = el('span', 'p2-group-label');
    layoutLabel.textContent = 'Layout';
    layoutLabel.setAttribute('aria-hidden', 'true');
    layoutGroup.append(layoutLabel, modeGroup, this.btnFs);

    bar.append(
      this.btnPlay, this.btnPrev, this.btnNext,
      this.scrub, this.timeLabel,
      spacer(), this.slideLabel, this.speed,
    );
    if (ccWrap) bar.append(ccWrap);
    bar.append(layoutGroup, this.btnLink);

    this._syncModeButtons();
  }

  _buildCcMenu() {
    const list = this.subs.list();
    if (!list.length) return null;
    const wrap = el('div', 'p2-cc');
    const btn = button('CC', 'Captions', () => {
      menu.classList.toggle('is-open');
      btn.setAttribute('aria-expanded', menu.classList.contains('is-open') ? 'true' : 'false');
    });
    btn.classList.add('p2-cc-btn');
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    const menu = el('div', 'p2-cc-menu');
    const mkItem = (lang, text) => {
      const item = button(text, text, () => {
        this.subs.setActive(lang);
        menu.classList.remove('is-open');
        btn.setAttribute('aria-expanded', 'false');
      });
      item.classList.add('p2-cc-item');
      item.dataset.lang = lang ?? '';
      return item;
    };
    menu.append(mkItem(null, 'Off'));
    for (const t of list) menu.append(mkItem(t.lang, t.label));
    wrap.append(btn, menu);

    const refresh = () => {
      const active = this.subs.getActive();
      btn.classList.toggle('is-on', !!active);
      menu.querySelectorAll('.p2-cc-item').forEach((it) => {
        it.classList.toggle('is-active', (it.dataset.lang || null) === (active || null));
      });
    };
    this.subs.on(refresh);
    refresh();

    // Close on outside click.
    this._onDocClick = (e) => { if (!wrap.contains(e.target)) { menu.classList.remove('is-open'); btn.setAttribute('aria-expanded', 'false'); } };
    document.addEventListener('click', this._onDocClick);
    return wrap;
  }

  _renderState(s) {
    if (!this._scrubbing) {
      const frac = s.duration ? (s.time / s.duration) * 1000 : 0;
      this.scrub.value = String(frac);
    }
    this.timeLabel.textContent = `${formatTime(s.time)} / ${formatTime(s.duration)}`;
    this.slideLabel.textContent = `${s.slide} / ${s.slideCount}`;
    this.btnPlay.textContent = s.playing ? '⏸' : '▶';
    this.btnPlay.title = s.playing ? 'Pause (space)' : 'Play (space)';
    this.btnLink.classList.toggle('is-linked', s.linked);
    this.btnLink.title = s.linked ? 'Sync linked — click to unlink' : 'Sync unlinked — click to link';
    this.btnLink.setAttribute('aria-pressed', String(s.linked));
    this.subs.update(s.time);   // drives the YouTube caption overlay
  }

  _togglePlay() {
    if (this.video.isPlaying()) this.video.pause(); else this.video.play();
  }

  // --- layout: modes, divider, PiP, fullscreen -----------------------------

  setMode(mode) {
    if (!MODES.some((m) => m.id === mode)) return;
    this.mode = mode;
    writeLS(LS.mode, mode);
    this.applyLayout();
    this._syncModeButtons();
  }

  _syncModeButtons() {
    if (!this.modeButtons) return;
    for (const m of MODES) {
      this.modeButtons[m.id]?.classList.toggle('is-on', m.id === this.mode);
      this.modeButtons[m.id]?.setAttribute('aria-pressed', String(m.id === this.mode));
    }
  }

  /** Apply the current mode + split ratio to the stage (CSS animates the change). */
  applyLayout() {
    if (!this.stage) return;
    this.stage.dataset.mode = this.mode;
    const deck = this.deckPane, video = this.videoPane;
    // Reset any inline PiP geometry unless we're in overlap.
    if (this.mode !== 'overlap') {
      video.style.left = video.style.top = video.style.width = video.style.height = '';
    }
    switch (this.mode) {
      case 'split':
        deck.style.flexGrow = String(this.split);
        video.style.flexGrow = String(1 - this.split);
        break;
      case 'slides-focus':
        deck.style.flexGrow = String(FOCUS_GROW);
        video.style.flexGrow = String(1 - FOCUS_GROW);
        break;
      case 'video-focus':
        deck.style.flexGrow = String(1 - FOCUS_GROW);
        video.style.flexGrow = String(FOCUS_GROW);
        break;
      case 'overlap':
        this._applyPipGeometry();
        break;
    }
  }

  setSplit(ratio) {
    this.split = Math.min(0.85, Math.max(0.15, ratio));
    if (this.mode === 'split') {
      this.deckPane.style.flexGrow = String(this.split);
      this.videoPane.style.flexGrow = String(1 - this.split);
    }
    writeLS(LS.split, this.split.toFixed(4));
  }

  // True when the stage stacks its panes vertically (portrait / narrow), so the
  // divider runs horizontally and the user drags it UP/DOWN to resize.
  _isVerticalSplit() {
    return getComputedStyle(this.stage).flexDirection === 'column';
  }

  _initDivider() {
    let dragging = false, vertical = false;
    const onMove = (e) => {
      if (!dragging) return;
      const rect = this.stage.getBoundingClientRect();
      const ratio = vertical
        ? (e.clientY - rect.top) / rect.height     // portrait: top pane (slides)
        : (e.clientX - rect.left) / rect.width;    // landscape/desktop: left pane
      this.setSplit(ratio);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      this.stage.classList.remove('is-dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    this.divider.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'split') return;
      e.preventDefault();
      vertical = this._isVerticalSplit();
      dragging = true;
      this.stage.classList.add('is-dragging');
      // Capture so the drag keeps tracking even if the pointer leaves the thin
      // handle (essential for touch on a 26px bar).
      try { this.divider.setPointerCapture(e.pointerId); } catch {}
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    // Keyboard resize for accessibility — Left/Up shrink the first pane,
    // Right/Down grow it, regardless of split orientation.
    this.divider.addEventListener('keydown', (e) => {
      if (this.mode !== 'split') return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault(); this.setSplit(this.split - 0.02);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault(); this.setSplit(this.split + 0.02);
      }
    });
    this._dividerCleanup = onUp;
  }

  // Overlap mode: the video pane becomes a draggable + resizable PiP overlay.
  _initPip() {
    this.pip = readJson(LS.pip) || null;
    const handle = this.videoPane.querySelector('.p2-pip-handle');
    const resizer = this.videoPane.querySelector('.p2-pip-resize');

    // Drag (by the handle bar).
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    const onDragMove = (e) => {
      if (!dragging) return;
      const rect = this.stage.getBoundingClientRect();
      const g = this._pipGeom();
      let left = ox + (e.clientX - sx);
      let top = oy + (e.clientY - sy);
      left = Math.max(0, Math.min(left, rect.width - g.width));
      top = Math.max(0, Math.min(top, rect.height - g.height));
      this._setPip({ ...g, left, top });
    };
    const onDragUp = () => {
      dragging = false;
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragUp);
    };
    handle.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'overlap') return;
      e.preventDefault();
      const g = this._pipGeom();
      dragging = true; sx = e.clientX; sy = e.clientY; ox = g.left; oy = g.top;
      window.addEventListener('pointermove', onDragMove);
      window.addEventListener('pointerup', onDragUp);
    });

    // Resize (by the corner grip).
    let resizing = false, rsx = 0, rsy = 0, rw = 0, rh = 0;
    const onResizeMove = (e) => {
      if (!resizing) return;
      const rect = this.stage.getBoundingClientRect();
      const g = this._pipGeom();
      let width = Math.max(180, rw + (e.clientX - rsx));
      let height = Math.max(110, rh + (e.clientY - rsy));
      width = Math.min(width, rect.width - g.left);
      height = Math.min(height, rect.height - g.top);
      this._setPip({ ...g, width, height });
    };
    const onResizeUp = () => {
      resizing = false;
      window.removeEventListener('pointermove', onResizeMove);
      window.removeEventListener('pointerup', onResizeUp);
    };
    resizer.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'overlap') return;
      e.preventDefault(); e.stopPropagation();
      const g = this._pipGeom();
      resizing = true; rsx = e.clientX; rsy = e.clientY; rw = g.width; rh = g.height;
      window.addEventListener('pointermove', onResizeMove);
      window.addEventListener('pointerup', onResizeUp);
    });
  }

  _pipGeom() {
    const rect = this.stage.getBoundingClientRect();
    const defW = Math.min(380, rect.width * 0.4);
    const defH = defW * 0.56;
    const g = this.pip || {};
    let width = clampNum(g.width, defW, 180, rect.width);
    let height = clampNum(g.height, defH, 110, rect.height);
    let left = clampNum(g.left, Math.max(0, rect.width - width - 18), 0, Math.max(0, rect.width - width));
    let top = clampNum(g.top, Math.max(0, rect.height - height - 18), 0, Math.max(0, rect.height - height));
    return { left, top, width, height };
  }

  _setPip(g) {
    this.pip = g;
    writeLS(LS.pip, JSON.stringify(g));
    if (this.mode === 'overlap') this._applyPipGeometry();
  }

  _applyPipGeometry() {
    const g = this._pipGeom();
    const v = this.videoPane;
    v.style.left = `${g.left}px`;
    v.style.top = `${g.top}px`;
    v.style.width = `${g.width}px`;
    v.style.height = `${g.height}px`;
  }

  _toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      this.root.requestFullscreen?.().catch((err) => console.warn('Fullscreen failed:', err.message));
    }
  }

  // --- input ---------------------------------------------------------------

  _bindInput() {
    // Track scrub drag so the polling loop doesn't fight the user's thumb.
    this.scrub.addEventListener('pointerdown', () => { this._scrubbing = true; });
    window.addEventListener('pointerup', () => { this._scrubbing = false; });

    // Keyboard (only when focus isn't in a text field).
    this._onKey = (e) => {
      if (/^(input|textarea|select)$/i.test(e.target.tagName) && e.target !== document.body) {
        if (e.target.classList.contains('p2-scrub')) { /* allow */ } else return;
      }
      const k = e.key;
      if (k === ' ' || k === 'Spacebar') { e.preventDefault(); this._togglePlay(); }
      else if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || k === 'k' || k === 'l') { e.preventDefault(); this.sync.nextSlide(); }
      else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || k === 'j' || k === 'h') { e.preventDefault(); this.sync.prevSlide(); }
      else if (k === 'Home') { e.preventDefault(); this.sync.gotoSlide(1); }
      else if (k === 'End') { e.preventDefault(); this.sync.gotoSlide(this.deck.slideCount); }
      else if (k === 'f' || k === 'F') { e.preventDefault(); this._toggleFullscreen(); }
      else if (k === 'm' || k === 'M') { e.preventDefault(); this._cycleMode(); }
    };
    window.addEventListener('keydown', this._onKey);

    // Mouse-wheel over the deck pane moves through slides (throttled).
    this._wheelAcc = 0; this._wheelLock = false;
    this._onWheel = (e) => {
      if (this._wheelLock) return;
      this._wheelAcc += e.deltaY;
      if (Math.abs(this._wheelAcc) < 60) return;
      const dir = this._wheelAcc > 0 ? 1 : -1;
      this._wheelAcc = 0;
      this._wheelLock = true;
      setTimeout(() => { this._wheelLock = false; }, 450);
      if (dir > 0) this.sync.nextSlide(); else this.sync.prevSlide();
    };
    this.deckPane.addEventListener('wheel', this._onWheel, { passive: true });

    // Keep the PiP inside the stage when the window resizes.
    this._onResize = () => { if (this.mode === 'overlap') this._applyPipGeometry(); };
    window.addEventListener('resize', this._onResize);
  }

  _cycleMode() {
    const i = MODES.findIndex((m) => m.id === this.mode);
    this.setMode(MODES[(i + 1) % MODES.length].id);
  }

  destroy() {
    this.sync?.stop();
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('fullscreenchange', this._onFsChange);
    document.removeEventListener('click', this._onDocClick);
    this._dividerCleanup?.();
    this.subs?.destroy();
    this.video?.destroy();
    this.deck?.destroy();
  }
}

// --- tiny DOM helpers ------------------------------------------------------
function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
function label(text) { const n = el('span', 'p2-pane-label'); n.textContent = text; return n; }
function pipHandle(text) {
  const n = el('div', 'p2-pane-label p2-pip-handle');
  n.textContent = text;
  return n;
}
function spacer() { return el('span', 'p2-spacer'); }
function button(text, title, onClick) {
  const b = el('button', 'p2-btn');
  b.type = 'button'; b.textContent = text; b.title = title; b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}

// --- localStorage helpers (guarded; private mode can throw) -----------------
function writeLS(key, val) { try { localStorage.setItem(key, String(val)); } catch {} }
function readNum(key, fallback, min, max) {
  let v;
  try { v = parseFloat(localStorage.getItem(key)); } catch {}
  if (!Number.isFinite(v)) v = fallback;
  return Math.min(max, Math.max(min, v));
}
function readStr(key, fallback, allowed) {
  let v;
  try { v = localStorage.getItem(key); } catch {}
  return allowed.includes(v) ? v : fallback;
}
function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function clampNum(v, fallback, min, max) {
  v = Number(v);
  if (!Number.isFinite(v)) v = fallback;
  return Math.min(max, Math.max(min, v));
}
