// sync.js — the bidirectional sync engine: one shared timeline binding the
// video provider and the deck adapter together.
//
//   video → slides : a polling loop reads video.getTime() and, when the active
//                    cue's slide differs from the deck's, advances the deck
//                    (with that cue's transition).
//   slides → video : when the deck reports an internal navigation, we seek the
//                    video to that slide's first cue time — UNLESS the deck is
//                    merely reflecting the video's own position (which is how we
//                    avoid an infinite video⇄slide feedback loop).
//
// A link/unlink toggle decouples the two without tearing anything down.

export class SyncEngine {
  /** @param {{video, deck, cues:Array, onState?:Function}} opts */
  constructor({ video, deck, cues, onState }) {
    this.video = video;
    this.deck = deck;
    this.cues = [...cues].sort((a, b) => a.time - b.time);
    this.onState = onState || (() => {});
    this.linked = true;
    this._raf = null;
    this._lastPushedSlide = null;

    // Deck-originated navigation (keyboard inside iframe, thumbnail click…).
    this.deck.on('slidechange', (slide) => this._onDeckNavigated(slide));
  }

  start() {
    // Align the deck to the video's starting position, then begin the loop.
    const startSlide = this.slideAtTime(this.video.getTime());
    this.deck.goTo(startSlide, { transition: 'cut' });
    this._lastPushedSlide = startSlide;
    this._tick = this._tick.bind(this);
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  setLinked(on) {
    this.linked = !!on;
    this._emit();
  }

  // --- timeline math -------------------------------------------------------

  /** The 1-based slide active at time t (last cue with time <= t). */
  slideAtTime(t) {
    let slide = this.cues.length ? this.cues[0].slide : 1;
    for (const cue of this.cues) {
      if (cue.time <= t + 1e-3) slide = cue.slide; else break;
    }
    return slide;
  }

  /** The cue (for its transition) active at time t. */
  cueAtTime(t) {
    let active = this.cues[0] || null;
    for (const cue of this.cues) {
      if (cue.time <= t + 1e-3) active = cue; else break;
    }
    return active;
  }

  /** First cue time for a given 1-based slide (0 if the slide has no cue). */
  timeForSlide(slide) {
    const cue = this.cues.find((c) => c.slide === slide);
    return cue ? cue.time : 0;
  }

  // --- video → slides ------------------------------------------------------

  _tick() {
    const t = this.video.getTime();
    if (this.linked) {
      const slide = this.slideAtTime(t);
      if (slide !== this._lastPushedSlide && slide !== this.deck.currentSlide) {
        const cue = this.cueAtTime(t);
        const direction = slide >= this.deck.currentSlide ? 1 : -1;
        this._lastPushedSlide = slide;
        this.deck.goTo(slide, { transition: cue?.transition || 'cut', direction });
      } else {
        this._lastPushedSlide = slide;
      }
    }
    this._emit();
    this._raf = requestAnimationFrame(this._tick);
  }

  // --- slides → video ------------------------------------------------------

  _onDeckNavigated(slide) {
    if (!this.linked) { this._emit(); return; }
    // If the video's current time already maps to this slide, the deck is just
    // echoing the video — do NOT seek (that would be the feedback loop).
    const videoSlide = this.slideAtTime(this.video.getTime());
    if (videoSlide === slide) { this._emit(); return; }
    this.video.seek(this.timeForSlide(slide));
    this._lastPushedSlide = slide;
    this._emit();
  }

  /**
   * Explicit, player-chrome-driven navigation (keyboard, wheel, click).
   * Always moves the deck; seeks the video too when linked.
   */
  gotoSlide(slide, { transition } = {}) {
    const n = Math.max(1, Math.min(slide, this.deck.slideCount || slide));
    const direction = n >= this.deck.currentSlide ? 1 : -1;
    const cue = this.cues.find((c) => c.slide === n);
    this.deck.goTo(n, { transition: transition || cue?.transition || 'cut', direction });
    this._lastPushedSlide = n;
    if (this.linked) this.video.seek(this.timeForSlide(n));
    this._emit();
  }

  nextSlide() { this.gotoSlide(this.deck.currentSlide + 1); }
  prevSlide() { this.gotoSlide(this.deck.currentSlide - 1); }

  // --- state broadcast -----------------------------------------------------

  _emit() {
    this.onState({
      time: this.video.getTime(),
      duration: this.video.getDuration(),
      playing: this.video.isPlaying(),
      slide: this.deck.currentSlide,
      slideCount: this.deck.slideCount,
      linked: this.linked,
    });
  }
}
