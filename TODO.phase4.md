# Phase 4 — polish + bugfix

Resumable checklist. Commit + push each step.

## 1. PDF deck black-slide bug (priority)
- [ ] Reproduce in headless Chrome (screenshot several pdf slides, measure brightness)
- [ ] Find root cause (transition / canvas / grid / overlay)
- [ ] Fix so every pdf slide renders + STAYS visible incl. transitions
- [ ] Regression check: screenshot N pdf slides, assert not blank/near-black

## 2. Layout icons — meaningful glyphs + labels
- [ ] split / slides-focus / video-focus / overlap / fullscreen glyphs depict mode
- [ ] aria-labels + visible tooltips (+ short text label on wide screens)
- [ ] keep "LAYOUT" group

## 3. Subtitles label + full-window overlay
- [ ] Rename "CC" → "Subtitles" (label/tooltip)
- [ ] Caption placement setting: video pane vs full player window
- [ ] Full-window overlay bottom-center, all layout modes incl fullscreen
- [ ] sensible default + document

## 4. Builder: deck source selection
- [ ] deck.type: html / pdf / embed
- [ ] deck.sources[] rows with protocol (https/ipfs/webtorrent) like video
- [ ] minimal embed deck adapter (iframe) + SPEC/schema/docs

## 5. Share UX (YouTube-style)
- [ ] Remove standalone "This spot" button
- [ ] Share button → popover menu: "Copy presentation link" / "Copy link to this moment"
- [ ] copies to clipboard with confirmation

## Docs
- [ ] README/SPEC/AUTHORING/schema: embed deck, subtitle full-window, share menu, layout glyphs

## Verify
- [ ] unit + headless smoke 390/780/1280, 0 real console errors, assets 200

## Done
- [ ] .phase4.done + telegram
