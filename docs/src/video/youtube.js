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
            // Apply any seek issued before the iframe API became ready (the
            // scrubber can race onReady on a cold load).
            if (this._pendingSeek != null) {
              const s = this._pendingSeek; this._pendingSeek = null;
              this.seek(s);
            }
            resolve();
          },
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.PLAYING) { this._playing = true; this._everPlayed = true; this.emit('play'); }
            else if (e.data === YT.PlayerState.PAUSED) { this._playing = false; this.emit('pause'); }
            else if (e.data === YT.PlayerState.ENDED) { this._playing = false; this.emit('ended'); }
          },
        },
      });
    });
    this.emit('ready');
  }
  play() { this.player?.playVideo(); }
  pause() { this.player?.pauseVideo(); }
  // Authoritative seek. Queue it if the player isn't ready yet, then on a cold
  // (never-started: UNSTARTED/CUED) player kick playback so the video actually
  // moves to the seeked position instead of sitting on the poster at 0. A player
  // that's already playing keeps playing; a deliberately paused one stays paused.
  seek(seconds) {
    if (!this._ready || !this.player?.seekTo) { this._pendingSeek = seconds; return; }
    const YT = this._YT || window.YT;
    let state;
    try { state = this.player.getPlayerState?.(); } catch { state = undefined; }
    this.player.seekTo(seconds, true);
    const PS = YT?.PlayerState;
    const cold = !this._everPlayed
      || (PS && (state === PS.UNSTARTED || state === PS.CUED));
    if (cold) { try { this.player.playVideo(); } catch {} }
  }
  getTime() { return this.player?.getCurrentTime?.() || 0; }
  getDuration() { return this.player?.getDuration?.() || 0; }
  setRate(rate) { this.player?.setPlaybackRate?.(rate); }
  isPlaying() { return !!this._playing; }
  destroy() { super.destroy(); try { this.player?.destroy(); } catch {} }
}
