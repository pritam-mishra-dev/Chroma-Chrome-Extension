// Finds "the video the user is watching" on a single-page app that swaps,
// reuses and relocates its <video> element constantly.
//
// Three overlapping signals, because each one misses cases the others catch:
//   1. YouTube's own SPA events (yt-navigate-finish, yt-page-data-updated)
//   2. MutationObservers on the player (ad state, <video> replacement, layout)
//   3. A cheap 1.5 s poll while the tab is visible — the safety net for DOM
//      changes YouTube makes without firing any event we know about.

import { SEL, matchesAny, queryFirst } from './selectors';

export type VideoKind = 'watch' | 'shorts' | 'miniplayer';

export interface ActiveVideo {
  video: HTMLVideoElement;
  player: HTMLElement;
  kind: VideoKind;
  videoId: string | null;
}

export interface WatcherCallbacks {
  onVideo(v: ActiveVideo | null): void;
  onPlayback(type: 'play' | 'pause' | 'seeking' | 'seeked' | 'loaded'): void;
  onAd(showing: boolean): void;
  onLayout(l: { fullscreen: boolean; ambient: boolean }): void;
}

const VIDEO_EVENTS = ['play', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'loadeddata', 'emptied'] as const;
const POLL_MS = 1500;
const VIDEO_ID = /^[\w-]{11}$/;

export class VideoWatcher {
  private current: ActiveVideo | null = null;
  private ad = false;
  private layoutKey = '';
  private lastWatchId: string | null = null;
  private playerObserver: MutationObserver | null = null;
  private flexyObserver: MutationObserver | null = null;
  private observedFlexy: Element | null = null;
  private pollTimer: number | undefined;
  private refreshQueued = false;

  constructor(private cb: WatcherCallbacks) {}

  start() {
    document.addEventListener('yt-navigate-finish', this.queueRefresh);
    document.addEventListener('yt-page-data-updated', this.queueRefresh);
    document.addEventListener('fullscreenchange', this.checkLayout);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('popstate', this.queueRefresh);
    this.refresh();
    this.schedulePoll();
  }

  stop() {
    document.removeEventListener('yt-navigate-finish', this.queueRefresh);
    document.removeEventListener('yt-page-data-updated', this.queueRefresh);
    document.removeEventListener('fullscreenchange', this.checkLayout);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('popstate', this.queueRefresh);
    clearTimeout(this.pollTimer);
    this.unbind();
    this.flexyObserver?.disconnect();
    this.flexyObserver = null;
    this.observedFlexy = null;
  }

  get active(): ActiveVideo | null {
    return this.current;
  }

  get adShowing(): boolean {
    return this.ad;
  }

  /** Coalesce bursts (navigation fires several events back to back) into one refresh. */
  private queueRefresh = () => {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      this.refresh();
    });
  };

  private onVisibility = () => {
    if (document.visibilityState === 'visible') {
      this.refresh();
      this.schedulePoll();
    } else {
      clearTimeout(this.pollTimer);
    }
  };

  private schedulePoll() {
    clearTimeout(this.pollTimer);
    if (document.visibilityState !== 'visible') return;
    this.pollTimer = window.setTimeout(() => {
      this.refresh();
      this.schedulePoll();
    }, POLL_MS);
  }

  private refresh() {
    const next = this.locate();
    const cur = this.current;
    const changed =
      next?.video !== cur?.video || next?.kind !== cur?.kind || next?.videoId !== cur?.videoId || next?.player !== cur?.player;
    if (changed) {
      this.unbind();
      this.current = next;
      if (next) this.bind(next);
      this.cb.onVideo(next);
    }
    this.checkAd();
    this.observeFlexy();
    this.checkLayout();
  }

  private locate(): ActiveVideo | null {
    const path = location.pathname;

    if (path.startsWith('/shorts/')) {
      const player = queryFirst<HTMLElement>(SEL.shortsPlayer);
      const video = player?.querySelector<HTMLVideoElement>(SEL.mainVideo);
      const id = path.split('/')[2] ?? '';
      if (player && video) return { video, player, kind: 'shorts', videoId: VIDEO_ID.test(id) ? id : null };
      return null;
    }

    const player = queryFirst<HTMLElement>(SEL.watchPlayer);
    const video = player?.querySelector<HTMLVideoElement>(SEL.mainVideo);
    if (!player || !video) return null;

    if (path === '/watch') {
      const id = new URLSearchParams(location.search).get('v');
      this.lastWatchId = id && VIDEO_ID.test(id) ? id : null;
      return { video, player, kind: 'watch', videoId: this.lastWatchId };
    }

    // Any other page: only a visible miniplayer counts. The #movie_player
    // left behind after leaving /watch is still in the DOM, just hidden.
    if (this.isMiniplayer(player)) {
      return { video, player, kind: 'miniplayer', videoId: this.titleVideoId(player) ?? this.lastWatchId };
    }
    return null;
  }

  private isMiniplayer(player: HTMLElement): boolean {
    const host = player.closest(SEL.miniplayerHost);
    if (!host && !matchesAny(SEL.miniplayerActive)) return false;
    const r = player.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  private titleVideoId(player: HTMLElement): string | null {
    const href = player.querySelector<HTMLAnchorElement>(SEL.titleLink)?.href;
    if (!href) return null;
    try {
      const id = new URL(href).searchParams.get('v');
      return id && VIDEO_ID.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  private bind(v: ActiveVideo) {
    for (const t of VIDEO_EVENTS) v.video.addEventListener(t, this.onVideoEvent);
    this.playerObserver = new MutationObserver(this.onPlayerMutation);
    // Class changes carry ad state; childList on the video container catches
    // YouTube swapping the <video> element itself.
    this.playerObserver.observe(v.player, { attributes: true, attributeFilter: ['class'] });
    const container = v.player.querySelector(SEL.videoContainer);
    if (container) this.playerObserver.observe(container, { childList: true });
  }

  private unbind() {
    const v = this.current;
    if (v) for (const t of VIDEO_EVENTS) v.video.removeEventListener(t, this.onVideoEvent);
    this.playerObserver?.disconnect();
    this.playerObserver = null;
  }

  private onPlayerMutation = (records: MutationRecord[]) => {
    if (records.some((r) => r.type === 'childList')) this.queueRefresh();
    else this.checkAd();
  };

  private onVideoEvent = (e: Event) => {
    switch (e.type) {
      case 'play':
      case 'playing':
        this.cb.onPlayback('play');
        break;
      case 'pause':
      case 'ended':
        this.cb.onPlayback('pause');
        break;
      case 'seeking':
        this.cb.onPlayback('seeking');
        break;
      case 'seeked':
        this.cb.onPlayback('seeked');
        break;
      case 'loadeddata':
      case 'emptied':
        // Same <video>, new source: YouTube reuses the element between videos.
        this.cb.onPlayback('loaded');
        this.queueRefresh();
        break;
    }
  };

  private checkAd() {
    const showing = !!this.current?.player.classList.contains(SEL.adShowingClass);
    if (showing !== this.ad) {
      this.ad = showing;
      this.cb.onAd(showing);
    }
  }

  private observeFlexy() {
    const flexy = document.querySelector(SEL.watchFlexy);
    if (flexy === this.observedFlexy) return;
    this.flexyObserver?.disconnect();
    this.observedFlexy = flexy;
    if (!flexy) return;
    this.flexyObserver ??= new MutationObserver(this.checkLayout);
    this.flexyObserver.observe(flexy, { attributes: true, attributeFilter: [...SEL.flexyLayoutAttrs] });
  }

  private checkLayout = () => {
    const fullscreen = !!document.fullscreenElement || !!this.observedFlexy?.hasAttribute('fullscreen');
    const ambient = matchesAny(SEL.ambientActive);
    const key = `${fullscreen}|${ambient}`;
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.cb.onLayout({ fullscreen, ambient });
    }
  };
}
