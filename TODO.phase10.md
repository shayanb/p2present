# Phase 10 — Homepage Redesign (cinematic, scroll-driven)

Redesign the landing page (`/`) into a visually stunning, animated, mesmerizing
experience. The `/app` player stays as-is. Dark & cinematic, cyan→violet→magenta
neon glow, lunarpunk energy, generous negative space.

## Tasks
- [x] Vendor Lenis (smooth-scroll) locally → `docs/vendor/lenis.min.js` (static, offline)
- [x] Inspect player palette + the 4 layout modes (split / slides-focus / video-focus / overlap PiP)
- [x] Rewrite `docs/home.css` — cinematic dark theme, neon gradient glow, reduced-motion fallback
- [x] Rewrite `docs/index.html` — hero, scroll-morph showcase, any-source, kept-alive, open-source, footer
- [x] `docs/home.js` — Lenis smooth scroll + scroll-driven layout morph (rAF, 60fps) + demo picker
- [x] Demo gallery data structure (array; MoaV first) + lightweight demo picker dialog
- [x] CTA: "▶ Load a demo" — opens picker (graceful `href` fallback to `app/?p=moav-pdf`)
- [x] Dedicated Docs hub page → `docs/docs/index.html` (SPEC / AUTHORING / schema / tools)
- [x] Nav "Docs" link → the new docs hub
- [x] Respect `prefers-reduced-motion` (static fallback) + `<noscript>`; mobile degrades gracefully (shorter track)
- [x] Update OG/meta
- [x] Update `scripts/smoke.mjs` home-section assertions + new docs-hub section
- [x] Verify: `npm test` (45+23 units) + `npm run smoke` (113/113, 0 console errors, assets 200, 390/780/1280)
- [x] Commit logically + push to main
- [x] Write `.phase10.done`
- [x] Telegram summary + URL

**PHASE 10 COMPLETE.** ✅

## Result
- Verified: units 68/68 (45 app + 23 service); smoke **113/113**; no same-origin console errors;
  morph confirmed advancing split→slides→video→PiP on scroll; screenshots at 390/780/1280.

## Constraints
- Static-only, light deps (Lenis vendored, ~18KB). No backend.
- Buttery 60fps morph; lazy assets; perf-budgeted; no jank.
- The stylized morph mock is NOT the real heavy player — pure CSS/SVG mock.

## Notes
- Layout modes mirror the player's MODES: split / slides-focus / video-focus / overlap(PiP).
- Palette base from app.css: --bg #0d0f12, --accent #4fd1c5 (cyan). Extend with violet/magenta neon.
- Pages site root = repo `docs/`. Docs hub at `docs/docs/index.html` → served at `/docs/`.
