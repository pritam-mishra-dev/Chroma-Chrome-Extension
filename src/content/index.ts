// Content-script entry: lifecycle, SPA navigation, and the policy decisions
// (which palette wins, when to freeze, when to fall back to the thumbnail).
// The modules it wires together are deliberately policy-free.

import type { AnalyzeOutcome } from '../shared/bitmap';
import { fromHex } from '../shared/color';
import type { QuantizeResult } from '../shared/quantize';
import { POPUP_PORT, isContextValid, safeSendMessage, type ThumbnailRequest } from '../shared/runtime';
import { effectiveSampleInterval, loadSettings, onSettingsChanged, type Settings } from '../shared/settings';
import type { Palette, PaletteSource, PopupState, Theme } from '../shared/types';
import { paletteDistance, paletteFromColor, selectPalette } from './palette';
import { Sampler } from './sampler';
import { ThemeApplier } from './theme-applier';
import { VideoWatcher, type ActiveVideo } from './video-watcher';

/** Below this mean luminance a frame is "black" (fade, intro card, or DRM-blanked). */
const BLACK_LUMA = 0.02;
/** Above this, a white flash or white title card — not representative either. */
const WHITE_LUMA = 0.95;
/** Black this long before the first readable frame ⇒ assume DRM and use the thumbnail. */
const UNREADABLE_AFTER_MS = 2000;
const SEEK_DEBOUNCE_MS = 300;

function readTheme(): Theme {
  return document.documentElement.hasAttribute('dark') ? 'dark' : 'light';
}

class Controller {
  private applier = new ThemeApplier();
  private sampler = new Sampler((o) => this.onSample(o));
  private watcher = new VideoWatcher({
    onVideo: (v) => this.onVideo(v),
    onPlayback: (t) => this.onPlayback(t),
    onAd: () => this.updateSampling(),
    onLayout: (l) => {
      this.applier.setLayout(l);
      this.broadcast();
    },
  });
  private theme: Theme = readTheme();
  private source: PaletteSource = 'none';
  /** Raw clusters behind the current palette, kept so a theme flip can re-derive it instantly. */
  private lastRaw: QuantizeResult | null = null;

  // Per-video state, reset whenever the active video changes.
  private hadReadableFrame = false;
  private blackSince: number | null = null;
  private thumbnailFor: string | null = null;
  private tainted = false;

  private forcedColors = matchMedia('(forced-colors: active)');
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private themeObserver = new MutationObserver(() => this.onThemeMaybeChanged());
  private unsubscribeSettings: () => void = () => {};
  private ports = new Set<chrome.runtime.Port>();
  private destroyed = false;

  constructor(private settings: Settings) {}

  start() {
    this.applier.install();
    this.applyOptions();
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] });
    this.forcedColors.addEventListener('change', this.onMediaChange);
    this.reducedMotion.addEventListener('change', this.onMediaChange);
    this.unsubscribeSettings = onSettingsChanged((s) => this.onSettings(s));
    chrome.runtime.onConnect.addListener(this.onConnect);
    this.watcher.start();
  }

  /** Enabled by the user and not overridden by the OS (High Contrast). */
  private get active(): boolean {
    return this.settings.enabled && !this.forcedColors.matches;
  }

  private get video(): ActiveVideo | null {
    return this.watcher.active;
  }

  // ------------------------------------------------------------------ options

  private applyOptions() {
    const s = this.settings;
    this.applier.setEnabled(this.active);
    this.applier.setOptions({
      targets: s.targets,
      performance: s.performance,
      transitionMs: s.transitionMs,
      glowIntensity: s.glowIntensity,
    });
    this.sampler.setInterval(effectiveSampleInterval(s, this.reducedMotion.matches));
    this.updateSampling();
  }

  private updateSampling() {
    const sample =
      this.active && this.settings.mode === 'live' && !!this.video && !this.watcher.adShowing && !this.tainted;
    this.sampler.setEnabled(sample);
    this.broadcast();
  }

  private onMediaChange = () => {
    this.applyOptions();
    // Leaving High Contrast mode: nothing is on screen yet, so pick a palette now.
    if (this.active && !this.applier.current) this.startMode();
  };

  private onSettings(next: Settings) {
    if (!this.guard()) return;
    const prev = this.settings;
    this.settings = next;
    this.applyOptions();

    const reenabled = next.enabled && !prev.enabled;
    if (!next.enabled) {
      this.broadcast();
      return;
    }
    if (reenabled || next.mode !== prev.mode || (next.mode === 'custom' && next.customColor !== prev.customColor)) {
      this.source = 'none';
      this.thumbnailFor = null;
      this.startMode();
    } else if (!this.video && !next.keepPaletteOffVideo && prev.keepPaletteOffVideo) {
      this.clearPalette();
    }
  }

  // -------------------------------------------------------------- video flow

  private onVideo(v: ActiveVideo | null) {
    if (!this.guard()) return;
    this.hadReadableFrame = false;
    this.blackSince = null;
    this.tainted = false;
    this.sampler.attach(v?.video ?? null);
    if (!v) {
      // Applies to Custom mode too, so the setting means the same thing in every mode.
      if (!this.settings.keepPaletteOffVideo) this.clearPalette();
      this.updateSampling();
      return;
    }
    this.startMode();
  }

  private startMode() {
    this.updateSampling();
    if (!this.active || !this.video) return;
    switch (this.settings.mode) {
      case 'custom': {
        const rgb = fromHex(this.settings.customColor);
        if (rgb) this.offer(paletteFromColor(rgb, this.theme), 'custom', true);
        break;
      }
      case 'static':
        void this.useThumbnail();
        break;
      case 'live':
        // The sampler was (re)enabled by updateSampling and fires immediately.
        break;
    }
  }

  private onPlayback(type: 'play' | 'pause' | 'seeking' | 'seeked' | 'loaded') {
    switch (type) {
      case 'play':
      case 'loaded':
        this.sampler.kick(0);
        break;
      case 'seeking':
        this.sampler.hold();
        break;
      case 'seeked':
        // release() restarts its delay on every call, so a burst of seeks
        // (scrubbing, arrow-key spam) produces one sample 300 ms after the last.
        this.sampler.release(SEEK_DEBOUNCE_MS);
        break;
      case 'pause':
        break;
    }
    this.broadcast();
  }

  private onSample(outcome: AnalyzeOutcome) {
    if (!this.guard() || !this.active || this.settings.mode !== 'live' || this.watcher.adShowing) return;

    if (!outcome.ok) {
      if (outcome.reason === 'tainted') {
        // Cross-origin/tainted frames never become readable; stop trying.
        this.tainted = true;
        this.updateSampling();
        void this.useThumbnail();
      }
      return;
    }

    const r = outcome.result;
    if (r.avgLuma > WHITE_LUMA) return; // freeze through white flashes
    // "Black" means dark *and* colorless: a night scene with a neon sign is
    // dark on average but still has a perfectly good accent to offer.
    if (r.clusters.length === 0 || (r.avgLuma < BLACK_LUMA && r.grayscale)) {
      if (!this.hadReadableFrame) {
        const now = performance.now();
        this.blackSince ??= now;
        if (now - this.blackSince > UNREADABLE_AFTER_MS) void this.useThumbnail();
      }
      return; // otherwise: freeze the previous palette
    }

    this.hadReadableFrame = true;
    this.blackSince = null;
    const p = selectPalette(r, this.theme);
    if (p) {
      this.lastRaw = r;
      this.offer(p, 'live');
    }
  }

  /** Static mode, DRM content, or a video that stays black from the start. */
  private async useThumbnail() {
    const id = this.video?.videoId;
    if (!id || this.thumbnailFor === id) return;
    this.thumbnailFor = id;
    const req: ThumbnailRequest = { type: 'chroma:thumbnail', videoId: id };
    const res = await safeSendMessage<{ result: QuantizeResult | null }>(req);
    // The user may have navigated on while the service worker was fetching.
    if (!res?.result || this.video?.videoId !== id || !this.active) return;
    if (this.settings.mode === 'live' && this.hadReadableFrame) return; // live frames won the race
    if (this.settings.mode === 'custom') return;
    const p = selectPalette(res.result, this.theme);
    if (p) {
      this.lastRaw = res.result;
      this.offer(p, 'thumbnail', true);
    }
  }

  /**
   * Hysteresis: a new palette only replaces the current one if it is
   * perceptibly different. Without this, every cut in a fast-edited video
   * would restart the cross-fade and the UI would shimmer.
   */
  private offer(p: Palette, source: PaletteSource, force = false) {
    const cur = this.applier.current;
    if (!force && cur && source === this.source && paletteDistance(cur, p) < this.settings.sensitivity) return;
    this.applier.apply(p, this.theme);
    this.source = source;
    this.broadcast();
  }

  private clearPalette() {
    this.applier.fadeOut();
    this.source = 'none';
    this.lastRaw = null;
    this.broadcast();
  }

  private onThemeMaybeChanged() {
    const theme = readTheme();
    if (theme === this.theme) return;
    this.theme = theme;
    // Contrast targets depend on the page background, so re-derive from the
    // raw clusters rather than reusing a palette tuned for the other theme.
    if (this.source === 'custom') {
      const rgb = fromHex(this.settings.customColor);
      if (rgb) this.offer(paletteFromColor(rgb, theme), 'custom', true);
    } else if (this.lastRaw && this.applier.current) {
      const p = selectPalette(this.lastRaw, theme);
      if (p) this.offer(p, this.source, true);
    }
  }

  // ------------------------------------------------------------------- popup

  private onConnect = (port: chrome.runtime.Port) => {
    if (port.name !== POPUP_PORT) return;
    this.ports.add(port);
    port.onDisconnect.addListener(() => this.ports.delete(port));
    this.postState(port);
  };

  private state(): PopupState {
    const v = this.video;
    return {
      type: 'chroma:state',
      palette: this.applier.current,
      source: this.applier.current ? this.source : 'none',
      video: v?.kind ?? null,
      paused: !v || v.video.paused,
      ad: this.watcher.adShowing,
      forcedColors: this.forcedColors.matches,
    };
  }

  private postState(port: chrome.runtime.Port) {
    try {
      port.postMessage(this.state());
    } catch {
      this.ports.delete(port);
    }
  }

  private broadcast() {
    for (const port of this.ports) this.postState(port);
  }

  // --------------------------------------------------------------- lifecycle

  /**
   * After the extension is updated or disabled, this script keeps running
   * but chrome.* throws. Tear down so we don't leave a half-themed page
   * that can no longer be controlled.
   */
  private guard(): boolean {
    if (this.destroyed) return false;
    if (isContextValid()) return true;
    this.destroy();
    return false;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.watcher.stop();
    this.sampler.destroy();
    this.applier.destroy();
    this.themeObserver.disconnect();
    this.forcedColors.removeEventListener('change', this.onMediaChange);
    this.reducedMotion.removeEventListener('change', this.onMediaChange);
    this.unsubscribeSettings();
    try {
      chrome.runtime.onConnect.removeListener(this.onConnect);
    } catch {
      // already invalidated
    }
    this.ports.clear();
  }
}

async function main() {
  // Embedded players (youtube.com/embed/… inside other sites) are out of scope.
  if (window.top !== window || location.pathname.startsWith('/embed/')) return;
  let settings: Settings;
  try {
    settings = await loadSettings();
  } catch {
    return; // context invalidated before we even started
  }
  new Controller(settings).start();
}

void main();
