// youtube.js — YouTube provider via the IFrame Player API.
// src is a YouTube video id (e.g. "uYygWN1MZDE") or a full watch/youtu.be URL.

import { BaseVideoProvider } from './base.js';

let apiReady = null;
function loadYouTubeAPI() {
  if (apiReady) return apiReady;
  apiReady = new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev && prev(); resolve(window.YT); };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
  return apiReady;
}

function extractId(src) {
  if (!/[/?=]/.test(src)) return src; // already a bare id
  try {
    const u = new URL(src);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1);
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const m = u.pathname.match(/\/(embed|shorts)\/([^/?]+)/);
    if (m) return m[2];
  } catch { /* fall through */ }
  return src;
}

export class YouTubeProvider extends BaseVideoProvider {
  async load() {
    const YT = await loadYouTubeAPI();
    this._YT = YT;
    const id = extractId(this.src);
    const host = document.createElement('div');
    this.mount.appendChild(host);
    await new Promise((resolve) => {
      this.player = new YT.Player(host, {
        videoId: id,
        playerVars: { rel: 0, modestbranding: 1, playsinline: 1, controls: 1 },
        events: {
          onReady: () => {
            this._ready = true;
            // YouTube's embed can come up with ITS captions on (a sticky
            // per-viewer preference) — double-rendering over the manifest's own
            // subtitle tracks. When we ship subtitles, unload YT's captions
            // module ('captions' = html5 player, 'cc' = legacy); the viewer can
            // still re-enable them from the YT gear if they insist.
            if (this.manifest?.subtitles?.length) {
              try { this.player.unloadModule('captions'); this.player.unloadModule('cc'); } catch { /* older API */ }
            }
            // Apply any seek issued before the iframe API became ready (the
            // scrubber can race onReady on a cold load).
            if (this._pendingSeek != null) {
              const s = this._pendingSeek; this._pendingSeek = null;
              this.seek(s);
            }
            resolve();
          },
          onStateChange: (e) => {
            // Ignore the brief PLAYING/PAUSED churn from a frame-landing kick (see
            // seek()) so the play button + state don't flicker on a paused scrub.
            if (this._kicking) return;
            if (e.data === YT.PlayerState.PLAYING) { this._playing = true; this._everPlayed = true; this.emit('play'); }
            else if (e.data === YT.PlayerState.PAUSED) { this._playing = false; this.emit('pause'); }
            else if (e.data === YT.PlayerState.ENDED) { this._playing = false; this.emit('ended'); }
          },
        },
      });
    });
    this.emit('ready');
  }
  play() {
    this._wantPlaying = true;
    clearTimeout(this._kickTimer); this._kicking = false;   // a real play cancels any pending re-pause
    this.player?.playVideo();
  }
  pause() { this._wantPlaying = false; this.player?.pauseVideo(); }
  // Authoritative seek — the slider owns the video position at all times. Queue
  // the seek if the iframe API isn't ready yet (the scrubber can race onReady on a
  // cold load), then seekTo(t, true). On an UNSTARTED/CUED/paused player seekTo
  // alone won't render the target frame, so we "kick" it: play, then re-pause on
  // the next beat — the frame at t actually shows WITHOUT starting playback. A
  // player the user has playing (this._wantPlaying) just seeks and keeps going.
  seek(seconds) {
    if (!this._ready || !this.player?.seekTo) { this._pendingSeek = seconds; return; }
    this.player.seekTo(seconds, true);
    if (this._wantPlaying) return;        // already playing → seekTo continues from there
    // Paused / cold: land the frame, then settle back to paused.
    this._kicking = true;
    clearTimeout(this._kickTimer);
    try { this.player.playVideo(); } catch {}
    this._kickTimer = setTimeout(() => {
      if (!this._wantPlaying) { try { this.player.pauseVideo(); } catch {} }
      // Let the PAUSED event drain before we listen to state changes again.
      this._kickSettle = setTimeout(() => { this._kicking = false; }, 80);
    }, 160);
  }
  getTime() { return this.player?.getCurrentTime?.() || 0; }
  getDuration() { return this.player?.getDuration?.() || 0; }
  setRate(rate) { this.player?.setPlaybackRate?.(rate); }
  isPlaying() { return !!this._playing; }
  destroy() {
    super.destroy();
    clearTimeout(this._kickTimer); clearTimeout(this._kickSettle);
    try { this.player?.destroy(); } catch {}
  }
}
