# Phase 12 — Brand logo + favicons + watermark + scroll-orbit

Brand assets live in `docs/brand/` (logo.png, logo-hero-base.png, favicon.ico,
icon-16/32/48/64/180/192/256/512.png, watermark.png, watermark-160.png).

Hero ring geometry (fitted from logo-hero-base.png, 1254×1254 space, ring
brightness hit-ratio 1.000):
- center (643.55, 615.34), semi-axes 338.40 (along φ) / 567.26 (along φ+90°), φ = 62.20°

## Tasks
- [x] 1. Favicons + meta: favicon.ico + icon PNGs + apple-touch-icon(180) + web
      app manifest (192+512, name "p2present", dark theme). OG/twitter image →
      brand/logo.png. Across home, /app, /docs, /host (+ /builder for parity).
- [x] 2. Brand mark in UI: logo (icon-32/48) as nav/footer brand mark on home,
      app header, docs, host, builder. Drop the old emoji/placeholder favicons.
- [x] 3. Hero logo + scroll-orbit planets: logo-hero-base.png base + 2 glowing
      peer dots (cyan + magenta) on an inline SVG that match the ring ellipse and
      ROTATE around it on scroll (idle drift ok). Reduced-motion → static dots.
- [x] 4. Watermark in player: watermark.png as a small tasteful corner mark in
      the /app player, non-overlapping with controls, optional home link.

## Verify
- [x] `npm test` (units) + `npm run smoke` (headless 390/780/1280, 0 console errs, assets 200)
- [x] static-only, prefers-reduced-motion respected
- [x] commit + push each step; write .phase12.done; telegram summary
