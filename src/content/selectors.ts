// Every YouTube selector and class name lives here. When YouTube ships a
// redesign, this should be the only file that needs to change.
//
// Lists are tried in order (JS) or wrapped in :is() (CSS). :is() takes a
// *forgiving* selector list, so one stale or unparseable entry just stops
// matching instead of invalidating the whole rule — a missed selector skips
// that target, it never breaks the others.

export const SEL = {
  app: 'ytd-app',
  watchFlexy: 'ytd-watch-flexy',
  watchPlayer: '#movie_player',
  shortsPlayer: '#shorts-player',
  mainVideo: 'video.html5-main-video',
  videoContainer: '.html5-video-container',
  miniplayerHost: 'ytd-miniplayer',
  miniplayerActive: ['ytd-app[miniplayer-is-active]', 'ytd-miniplayer[active]', 'ytd-miniplayer[enabled]'],
  titleLink: '.ytp-title-link',
  /** Class on the player element while an ad plays. */
  adShowingClass: 'ad-showing',
  /** Attributes on ytd-watch-flexy that change glow geometry. */
  flexyLayoutAttrs: ['theater', 'fullscreen', 'cinematics-active', 'full-bleed-player'],
  ambientActive: ['ytd-watch-flexy[cinematics-active]', '#cinematics canvas'],
} as const;

/** Selector groups substituted into styles.css wherever `chroma-sel-<name>` appears. */
export const CSS_SEL: Record<string, readonly string[]> = {
  progressPlayed: ['.ytp-play-progress', '[class*="ytPlayerProgressBarPlayed"]', '.ytProgressBarLineProgressBarPlayed'],
  swatch: ['.ytp-swatch-background-color', '.ytp-scrubber-button', '.ytPlayerProgressBarPlayheadDot', '.ytProgressBarPlayheadProgressBarPlayheadDot'],
  volumeHandle: ['.ytp-volume-slider-handle'],
  glowDefault: [
    'ytd-watch-flexy:not([theater]):not([fullscreen]) #ytd-player',
    'ytd-reel-video-renderer[is-active] #player-container',
    '#short-video-container',
  ],
  glowTheater: ['ytd-watch-flexy[theater]:not([fullscreen]) #full-bleed-container'],
  subscribe: [
    '#subscribe-button .ytSpecButtonShapeNextFilled.ytSpecButtonShapeNextMono',
    '#subscribe-button .yt-spec-button-shape-next--filled.yt-spec-button-shape-next--mono',
    'ytd-subscribe-button-renderer .ytSpecButtonShapeNextFilled.ytSpecButtonShapeNextMono',
  ],
  chipActive: [
    '.ytChipShapeChip.ytChipShapeActive',
    'yt-chip-cloud-chip-renderer[selected] #chip-container',
    'yt-chip-cloud-chip-renderer.iron-selected #chip-container',
  ],
  toggleActive: [
    'like-button-view-model button[aria-pressed="true"] .ytSpecButtonShapeNextIcon',
    'dislike-button-view-model button[aria-pressed="true"] .ytSpecButtonShapeNextIcon',
    'toggle-button-view-model button[aria-pressed="true"] .ytSpecButtonShapeNextIcon',
    'ytd-toggle-button-renderer.style-default-active yt-icon',
  ],
  // Description/comment links get an inline color from YouTube's
  // attributed-string data, so token overrides can't reach them.
  links: [
    'a.ytAttributedStringLinkCallToActionColor',
    '#description a.yt-simple-endpoint',
    'ytd-comment-view-model #content-text a',
    'ytd-text-inline-expander a.yt-simple-endpoint',
  ],
  tintSurfaces: ['ytd-app', '#masthead-container #background', 'tp-yt-app-drawer #contentContainer', 'ytd-mini-guide-renderer'],
  scrollPanels: ['ytd-playlist-panel-renderer #items', 'ytd-engagement-panel-section-list-renderer #content', '#guide-inner-content'],
};

export function queryFirst<T extends Element = Element>(selectors: string | readonly string[], root: ParentNode = document): T | null {
  for (const s of typeof selectors === 'string' ? [selectors] : selectors) {
    try {
      const el = root.querySelector<T>(s);
      if (el) return el;
    } catch {
      // Invalid selector in a future browser/YouTube combination — skip it.
    }
  }
  return null;
}

export function matchesAny(selectors: readonly string[]): boolean {
  return queryFirst(selectors) !== null;
}

/** Replace `chroma-sel-<name>` placeholders in a stylesheet with comma-joined selector groups. */
export function expandSelectors(css: string): string {
  return css.replace(/chroma-sel-([a-zA-Z]+)/g, (whole, name: string) => {
    const group = CSS_SEL[name];
    return group ? group.join(', ') : whole;
  });
}
