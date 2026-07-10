// home.js — the landing page's motion + interaction layer.
//
//   1. Lenis smooth-scroll (vendored, optional, silenced under reduced motion)
//   2. scroll-driven layout morph for the showcase mock (rAF, GPU transitions)
//   3. IntersectionObserver reveals
//   4. the demo picker (a tiny gallery; MoaV today, more later)
//
// Everything degrades gracefully: no Lenis → native scroll; no <dialog> → the
// CTA just follows its href; prefers-reduced-motion → static, no morph, no smooth.

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/* ============================================================= *
 *  1. SMOOTH SCROLL (Lenis)                                      *
 * ============================================================= */
let lenis = null;
function initSmoothScroll() {
  if (reduceMotion || !window.Lenis) return;
  // Coarse pointers (touch) keep native momentum; smoothing the wheel is the win.
  // Keep the lerp fairly direct so scroll-linked visuals don't feel late.
  lenis = new window.Lenis({ lerp: 0.18, wheelMultiplier: 1.08, smoothWheel: true, syncTouch: false, anchors: true });
  function raf(time) { lenis.raf(time); requestAnimationFrame(raf); }
  requestAnimationFrame(raf);
  lenis.on('scroll', onScroll);
}

/* ============================================================= *
 *  2. SCROLL-DRIVEN LAYOUT MORPH                                 *
 * ============================================================= */
// Five scroll phases. The first four morph the layout; the fifth is the climax —
// source nodes ignite and stream into the player (driven by the .sourcing class).
const STEPS = [
  { title: 'Split view' },          // 0
  { title: 'Slides focus' },        // 1
  { title: 'Video focus' },         // 2
  { title: 'Picture-in-picture' },  // 3
  { title: 'Plays from any source' },// 4 — the source constellation
];

const morph    = document.querySelector('.morph');
const showcase  = document.getElementById('showcase');
const sticky    = document.querySelector('.showcase-sticky');
const titleEl   = document.getElementById('morph-title');
const kickerEl  = document.querySelector('.showcase-head .kicker');
const capEls    = [...document.querySelectorAll('.morph-cap')];
const dotEls     = [...document.querySelectorAll('#morph-dots i')];

// Where the source climax begins/ends along the pinned track. The title/step
// flips to "Plays from any source" at FLOW_START — the same instant the source
// cards start coming in — so the heading always narrates what's on screen.
const FLOW_START = 0.7;
const FLOW_END = 0.97;

let currentStep = -1;
let ticking = false;
let flowIntensity = 0;   // 0→1: how hard the sources stream into the player (scroll)

// 0 → 1 progress across the whole pinned showcase track.
function computeProgress() {
  if (!showcase) return 0;
  const total = showcase.offsetHeight - window.innerHeight; // pinned scroll travel
  if (total <= 0) return 0;
  return clamp(-showcase.getBoundingClientRect().top, 0, total) / total;
}

function computeStep() {
  const p = computeProgress();
  // The four layout bands share [0, FLOW_START); the source climax owns the rest.
  if (p >= FLOW_START) return STEPS.length - 1;
  return clamp(Math.floor((p / FLOW_START) * (STEPS.length - 1)), 0, STEPS.length - 2);
}

function applyStep(step) {
  if (step === currentStep) return;
  currentStep = step;
  if (morph) morph.dataset.step = String(step);
  if (titleEl) titleEl.textContent = STEPS[step].title;
  if (kickerEl) kickerEl.textContent = step >= 4 ? 'One link · forever' : 'One player';
  capEls.forEach((c) => c.classList.toggle('active', Number(c.dataset.step) === step));
  dotEls.forEach((d, i) => d.classList.toggle('on', i === step));
  // the final phase: ignite the source constellation streaming into the player
  if (sticky) sticky.classList.toggle('sourcing', step >= 4);
}

function applySourceFlow(progress) {
  if (!sticky) return;
  // Hold off until the layout has finished settling into PiP, THEN stream the
  // sources in — the "finish the format, then plug in every source" beat. The
  // window runs to near the end so the chips land fully lit (labels visible).
  flowIntensity = clamp((progress - FLOW_START) / (FLOW_END - FLOW_START), 0, 1);
  sticky.style.setProperty('--flow', flowIntensity.toFixed(3));
  sticky.classList.toggle('sourcing', flowIntensity > 0.005);
}

// Hero brand mark: fade + lift it away as the user scrolls into the hero, and
// retire the floating scroll cue once they've started moving.
const heroLogo = document.querySelector('.hero-logo');
const scrollCue = document.querySelector('.scroll-cue');
function fadeHeroChrome() {
  const y = window.scrollY || window.pageYOffset || 0;
  if (heroLogo && !reduceMotion) {
    const f = clamp(1 - y / (window.innerHeight * 0.6), 0, 1); // 1 at top → 0 by ~60vh
    heroLogo.style.opacity = f.toFixed(3);
    heroLogo.style.transform = `translateY(${((1 - f) * -28).toFixed(1)}px) scale(${(0.9 + 0.1 * f).toFixed(3)})`;
  }
  // Keep the scroll cue on-screen as a persistent hint until the reader is almost
  // at the end of the page (within ~1 viewport of the bottom), then retire it.
  if (scrollCue) {
    const doc = document.documentElement;
    const nearBottom = (y + window.innerHeight) >= (doc.scrollHeight - window.innerHeight * 1.1);
    scrollCue.classList.toggle('is-gone', nearBottom);
  }
}

function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    const progress = computeProgress();
    applyStep(computeStep());
    applySourceFlow(progress);
    fadeHeroChrome();
    ticking = false;
  });
}

/* let the captions also drive the morph (and scroll to that step) when clicked */
function wireCaptionJumps() {
  if (!showcase) return;
  capEls.forEach((cap) => {
    cap.style.cursor = 'pointer';
    cap.addEventListener('click', () => {
      const step = Number(cap.dataset.step);
      const total = showcase.offsetHeight - window.innerHeight;
      // aim at the middle of that step's band (the four layout bands share
      // [0, FLOW_START)) so it lands cleanly on the mode
      const target = showcase.offsetTop + total * (((step + 0.5) / (STEPS.length - 1)) * FLOW_START);
      if (lenis) lenis.scrollTo(target, { duration: 1.1 });
      else window.scrollTo({ top: target, behavior: reduceMotion ? 'auto' : 'smooth' });
    });
  });
}

/* ============================================================= *
 *  deck auto-cycle (the stylized slides cross-fade)             *
 * ============================================================= */
function initDeckCycle() {
  const slides = [...document.querySelectorAll('.deck-slide')];
  if (reduceMotion || slides.length < 2) return;
  let i = 0;
  setInterval(() => {
    slides[i].classList.remove('on');
    i = (i + 1) % slides.length;
    slides[i].classList.add('on');
  }, 2800);
}

/* ============================================================= *
 *  2b. HERO SCROLL-ORBIT — the two peer "planet" dots           *
 * ============================================================= */
// Two glowing dots (cyan + magenta) ride the brand ring in the hero. The ring
// ellipse was fitted from logo-hero-base.png in its native 1254×1254 space
// (perimeter brightness hit-ratio 1.000), so positions drop straight into the
// overlaid SVG's viewBox. Scroll drives the orbit angle (eased so velocity reads
// smoothly); a faint idle drift keeps it alive at rest. Reduced motion → static.
function initHeroOrbit() {
  const orbit = document.querySelector('.hero-orbit');
  const dotA = orbit?.querySelector('.planet-cyan');
  const dotB = orbit?.querySelector('.planet-magenta');
  if (!orbit || !dotA || !dotB) return;

  const CX = 643.55, CY = 615.34, AX = 338.40, AY = 567.26;
  const PHI = (62.20 * Math.PI) / 180, CP = Math.cos(PHI), SP = Math.sin(PHI);
  const place = (dot, t) => {
    const c = Math.cos(t), s = Math.sin(t);
    dot.setAttribute('cx', (CX + AX * c * CP - AY * s * SP).toFixed(1));
    dot.setAttribute('cy', (CY + AX * c * SP + AY * s * CP).toFixed(1));
  };

  // static dots on opposite ends of the ring under reduced motion (no rAF loop)
  if (reduceMotion) { place(dotA, 0); place(dotB, Math.PI); return; }

  const K = (2 * Math.PI) / 1300;     // one full orbit per ~1300px of scroll
  let angle = 0, last = performance.now(), running = false;
  function frame(now) {
    if (!running) return;
    const dt = Math.min(64, now - last); last = now;
    const target = window.scrollY * K;             // scroll position → target angle
    angle += (target - angle) * Math.min(1, dt / 140); // ease toward it (smooth)
    const idle = now * 0.00006;                     // faint always-on drift
    place(dotA, angle + idle);
    place(dotB, angle + idle + Math.PI);
    requestAnimationFrame(frame);
  }
  const start = () => { if (running) return; running = true; last = performance.now(); requestAnimationFrame(frame); };
  const stop = () => { running = false; };
  start();

  // idle the loop when the hero is off-screen or the tab is hidden
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  const hero = document.querySelector('.hero');
  if (hero && 'IntersectionObserver' in window) {
    new IntersectionObserver((es) => (es[0].isIntersecting && !document.hidden ? start() : stop()),
      { threshold: 0 }).observe(hero);
  }
}

/* ============================================================= *
 *  3. REVEALS                                                   *
 * ============================================================= */
function initReveals() {
  const els = [...document.querySelectorAll('.reveal')];
  if (reduceMotion || !('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.12 });
  els.forEach((el) => io.observe(el));
}

/* ============================================================= *
 *  4. DEMO PICKER                                               *
 * ============================================================= */
// The demo gallery. Add a talk by pushing one entry; `default: true` is what a
// bare CTA loads if the dialog is unavailable.
const DEMOS = [
  {
    id: 'moav-pdf',
    title: 'The Mother of All VPNs',
    desc: '23 slides synced to the recorded talk.',
    badges: ['YouTube', 'PDF deck', 'Subtitles'],
    icon: '🛡️',
    href: 'app/?p=moav-pdf',
    default: true,
  },
  // Placeholder so the gallery reads as "growing", clearly non-clickable.
  { id: 'soon', title: 'Your talk here', desc: 'More demos are on the way.', icon: '✨', soon: true },
];

const DEFAULT_DEMO = (DEMOS.find((d) => d.default) || DEMOS[0]).href || 'app/?p=moav-pdf';
const dialog = document.getElementById('demo-picker');
const pickerSupported = !!(dialog && typeof dialog.showModal === 'function');

function renderDemoList() {
  const list = document.getElementById('demo-list');
  if (!list) return;
  list.innerHTML = '';
  for (const d of DEMOS) {
    const card = document.createElement(d.soon ? 'div' : 'a');
    card.className = 'demo-card';
    if (d.soon) {
      card.setAttribute('disabled', '');
      card.innerHTML =
        `<span class="thumb">${d.icon}</span>` +
        `<span class="meta"><h4>${d.title}</h4><p>${d.desc}</p></span>` +
        `<span class="soon">Soon</span>`;
    } else {
      card.href = d.href;
      const badges = (d.badges || []).map((b) => `<span>${b}</span>`).join('');
      card.innerHTML =
        `<span class="thumb">${d.icon}</span>` +
        `<span class="meta"><h4>${d.title}</h4><p>${d.desc}</p>` +
        `<span class="badges">${badges}</span></span>` +
        `<span class="go">→</span>`;
    }
    list.appendChild(card);
  }
}

function openPicker() {
  if (!pickerSupported) { window.location.href = DEFAULT_DEMO; return; }
  if (lenis) lenis.stop();
  dialog.showModal();
}
function closePicker() {
  if (pickerSupported && dialog.open) dialog.close();
  if (lenis) lenis.start();
}

function initPicker() {
  renderDemoList();
  // CTA buttons: open the picker (keeping their href as a no-JS fallback).
  document.querySelectorAll('[data-demo-cta]').forEach((cta) => {
    cta.addEventListener('click', (e) => {
      if (!pickerSupported) return;        // let the href navigate
      e.preventDefault();
      openPicker();
    });
  });
  if (!pickerSupported) return;
  dialog.querySelector('[data-close]')?.addEventListener('click', closePicker);
  // click on the backdrop (outside the panel) closes it
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closePicker(); });
  dialog.addEventListener('close', () => { if (lenis) lenis.start(); });
}

/* ============================================================= *
 *  BOOT                                                         *
 * ============================================================= */
function boot() {
  initSmoothScroll();
  initHeroOrbit();
  initReveals();
  initDeckCycle();
  wireCaptionJumps();
  initPicker();
  // prime the morph + keep it in sync on scroll/resize
  applyStep(computeStep());
  applySourceFlow(computeProgress());
  fadeHeroChrome();
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
