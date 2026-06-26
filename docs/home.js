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
  lenis = new window.Lenis({ lerp: 0.1, smoothWheel: true, syncTouch: false, anchors: true });
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
const capEls    = [...document.querySelectorAll('.morph-cap')];
const dotEls     = [...document.querySelectorAll('#morph-dots i')];

let currentStep = -1;
let ticking = false;

function computeStep() {
  if (!showcase) return 0;
  const total = showcase.offsetHeight - window.innerHeight; // pinned scroll travel
  if (total <= 0) return 0;
  const scrolled = clamp(-showcase.getBoundingClientRect().top, 0, total);
  const p = scrolled / total;                 // 0 → 1 across the whole track
  return clamp(Math.floor(p * STEPS.length), 0, STEPS.length - 1);
}

function applyStep(step) {
  if (step === currentStep) return;
  currentStep = step;
  if (morph) morph.dataset.step = String(step);
  if (titleEl) titleEl.textContent = STEPS[step].title;
  capEls.forEach((c) => c.classList.toggle('active', Number(c.dataset.step) === step));
  dotEls.forEach((d, i) => d.classList.toggle('on', i === step));
  // the final phase: ignite the source constellation streaming into the player
  if (sticky) sticky.classList.toggle('sourcing', step >= 4);
}

function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => { applyStep(computeStep()); ticking = false; });
}

/* let the captions also drive the morph (and scroll to that step) when clicked */
function wireCaptionJumps() {
  if (!showcase) return;
  capEls.forEach((cap) => {
    cap.style.cursor = 'pointer';
    cap.addEventListener('click', () => {
      const step = Number(cap.dataset.step);
      const total = showcase.offsetHeight - window.innerHeight;
      // aim at the middle of that step's band so it lands cleanly on the mode
      const target = showcase.offsetTop + total * ((step + 0.5) / STEPS.length);
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
  initReveals();
  initDeckCycle();
  wireCaptionJumps();
  initPicker();
  // prime the morph + keep it in sync on scroll/resize
  applyStep(computeStep());
  if (!lenis) window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
