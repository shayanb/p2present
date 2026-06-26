# Phase 3 — build checklist (resumable)

Living checklist for the phase-3 overnight job. Status legend: ⬜ todo · 🔄 in-progress · ✅ done.

## 0. Setup
- ✅ Read repo, understand phase-2 architecture (player/sync/decks/video/resolve)
- ✅ Clone `ibeezhan/writings-drafts`, locate `MoaV-Berlin-2026.pdf` (23 pages → matches 23-slide HTML deck)
- ✅ Create + commit this checklist

## 3. PDF demo flow (done early — other parts target it)
- ⬜ Add `content/moav-pdf/` manifest (deck.type "pdf", same youtube video + timing)
- ⬜ Bundle the PDF asset
- ⬜ Selectable via `?p=moav-pdf` + a demo picker on the resolver
- ⬜ Verify PDF renders + syncs (pdf.js adapter) in headless smoke

## 4. Thumbnail scrubber + deep-links
- ⬜ Deck adapters expose `thumbnail(slide)` (PDF: real rendered canvas; HTML: authored/label card)
- ⬜ Scrubber hover/seek shows a slide preview thumbnail for that time (html + pdf)
- ⬜ Deep-link hash `#t=<seconds>&slide=<n>` opens at that time/slide
- ⬜ Hash updates (debounced) as the user navigates
- ⬜ Share button offers a "link to current spot" variant
- ⬜ Smoke: scrubber thumbnail appears, deep-link opens correct time/slide

## 1. Manifest builder / editor UI (new page `docs/builder/`)
- ⬜ Form: title/meta, video.sources[] rows, deck (type + sources[]), timing rows, subtitles[], resolvers, layout
- ⬜ Live JSON preview + schema validation against `docs/p2present.schema.json`
- ⬜ Download / Copy JSON / Open in player (?src=base64)
- ⬜ Load-existing: paste/upload a manifest to edit
- ⬜ Timing-capture helper (stamp current video time → current slide)
- ⬜ Smoke: builder validates + exports

## 2. IPFS upload + WebTorrent seed helper (new page `docs/host/`) + HOSTING.md
- ⬜ IPFS client-side upload via user-configured token (web3.storage/Storacha + Pinata), token in localStorage only
- ⬜ WebTorrent in-browser create+seed from a file → magnet URI
- ⬜ Both feed into the builder
- ⬜ HOSTING.md: plain URLs, IPFS (with/without own pin), WebTorrent (browser vs CLI), mapping to manifest entries
- ⬜ Smoke: helper page loads (mock pin call when no token)

## 5. Docs review (LAST)
- ⬜ README, SPEC.md, HOSTING/SETUP, AUTHORING guide, JSON schema, docs index
- ⬜ No stale refs (no v0), all links work, examples valid

## Verify / finish
- ⬜ `npm test` (unit) + `npm run smoke` (headless 390/780/1280) green, 0 real console errors
- ⬜ Commit in logical chunks, push to main after each step
- ⬜ Write `.phase3.done` + send telegram
