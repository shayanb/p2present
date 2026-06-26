# Phase 5 — bug fixes

Repo: ibeezhan/p2present · Pages from `/docs`, static-only, light deps.
Resumable: `git log --oneline -20` + read this file, continue. Commit + push each step.

## BUG 1 — timeline seek doesn't move the video (esp. YouTube)
Clicking/dragging the main scrubber must seek the VIDEO and jump the slide together.
Current `input` handler only called `video.seek()`; YouTube `seekTo` raced player
readiness and never kicked a cold (cued/unstarted) player, so the iframe stayed on
the poster at 0 while the slide moved.

- [x] `youtube.js`: track readiness; queue a seek issued before `onReady`; on a
      cold (UNSTARTED/CUED) player, `playVideo()` after `seekTo` so it actually moves.
- [x] `sync.js`: add `seekToTime(t)` — seeks the video to the exact time AND moves
      the deck to `slideAtTime(t)` (cut), without re-seeking to the slide's cue time.
      Respects link/unlink (deck only follows when linked).
- [x] `player.js`: scrubber `input` → `sync.seekToTime(time)` (was bare `video.seek`).
- [x] Smoke: mp4 fixture — drag scrubber in PAUSED and PLAYING states, assert
      `video.currentTime` changed + slide jumped + play/pause state preserved.
- [x] Smoke: YouTube demo — best-effort assert `getCurrentTime()` advances after a seek.

## BUG 2 — PDF slides go dark on back-and-forth (esp. reverse)
Cached page canvases can lose their backing store (browser purges off-screen GPU
canvas memory) → a previously-rendered page shows blank/black when navigated back to.
`_commit` only reconciles DOM visibility, not pixel content, so phase-4 didn't cover it.

- [x] `pdf-deck.js`: register each page canvas synchronously (kills the duplicate-
      canvas race), cache the pdf `page` object, render via a cancellable task.
- [x] Force a fresh re-render of the page that is BECOMING active on every distinct
      navigation (forward OR backward) so a purged/cleared canvas is always restored
      before it is shown. Stale renders cancel by nav token; the current page always
      ends rendered.
- [x] Smoke: drive the pdf demo across ALL slides forward then backward (via deck
      nav), screenshot, assert none blank/near-black (luminance check).

## VERIFY
- [x] `npm test` green (unit)
- [x] `npm run smoke` green at 390/780/1280; 0 same-origin console errors; assets 200
- [x] commit + push each logical step

## DONE
- [ ] write `.phase5.done`
- [ ] one telegram with summary + live URL
