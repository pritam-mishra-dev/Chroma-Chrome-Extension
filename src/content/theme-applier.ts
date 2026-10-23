// Owns everything Chroma writes into the page: three <style> elements and a
// handful of classes on <html>. Nothing else in the content script touches
// the DOM's appearance, which keeps teardown a single, reliable call.

import { toHex } from '../shared/color';
import type { PerformanceMode, Targets } from '../shared/settings';
import type { Palette, Theme } from '../shared/types';
import { expandSelectors } from './selectors';
import stylesCss from './styles.css?inline';
import { buildTokenCss, discoverTokens } from './tokens';

/** Fade back to YouTube's stock colors on pages without a video. */
export const FADE_MS = 600;

const TARGET_CLASSES: Record<keyof Targets, string> = {
  accents: 'chroma-t-accents',
  progress: 'chroma-t-progress',
  glow: 'chroma-t-glow',
  scrollbar: 'chroma-t-scrollbar',
  tint: 'chroma-t-tint',
  selection: 'chroma-t-selection',
};

export interface ApplierOptions {
  targets: Targets;
  performance: PerformanceMode;
  transitionMs: number;
  glowIntensity: number;
}

export class ThemeApplier {
  private root = document.documentElement;
  private baseStyle: HTMLStyleElement | null = null;
  private tokenStyle: HTMLStyleElement | null = null;
  /** Every variable we've written, so they can be restored if YouTube rewrites <html style>. */
  private vars = new Map<string, string>();
  private styleObserver: MutationObserver | null = null;
  private idleTimer: number | undefined;
  private fadeInRaf = 0;
  private transitionMs = 1200;
  private palette: Palette | null = null;

  install() {
    if (this.baseStyle) return;
    const parent = document.head ?? this.root;
    this.baseStyle = this.makeStyle('chroma-base', expandSelectors(stylesCss), parent);
    this.tokenStyle = this.makeStyle('chroma-tokens', '', parent);
    // Variables go in <html>'s inline style. Writing them into a rule of our
    // own stylesheet looks tidier but each CSSOM mutation makes Chrome
    // invalidate the whole sheet — measured at 4–9 ms per palette change,
    // versus well under 0.1 ms for an inline style. The observer covers the
    // case where YouTube replaces the style attribute wholesale.
    this.styleObserver = new MutationObserver(() => this.restoreVars());
    this.styleObserver.observe(this.root, { attributes: true, attributeFilter: ['style'] });
    this.scheduleTokenScan();
  }

  private makeStyle(id: string, css: string, parent: Node): HTMLStyleElement {
    document.getElementById(id)?.remove(); // leftover from a previous (invalidated) instance
    const el = document.createElement('style');
    el.id = id;
    el.textContent = css;
    parent.appendChild(el);
    return el;
  }

  /**
   * Token discovery walks every stylesheet (a few ms), so it runs in idle
   * time — twice, because YouTube lazy-loads some component CSS after first paint.
   */
  private scheduleTokenScan() {
    const scan = () => {
      if (!this.tokenStyle) return;
      const t0 = performance.now();
      this.tokenStyle.textContent = buildTokenCss(discoverTokens());
      if (__CHROMA_DEV__) console.debug(`[chroma] token scan ${(performance.now() - t0).toFixed(1)} ms`);
    };
    const idle = (fn: () => void, timeout: number) =>
      'requestIdleCallback' in window ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, 50);
    idle(scan, 1000);
    setTimeout(() => idle(scan, 2000), 5000);
  }

  setEnabled(on: boolean) {
    this.root.classList.toggle('chroma-on', on);
  }

  setOptions(o: ApplierOptions) {
    for (const [key, cls] of Object.entries(TARGET_CLASSES) as [keyof Targets, string][]) {
      this.root.classList.toggle(cls, o.targets[key]);
    }
    for (const p of ['quality', 'balanced', 'battery'] as const) {
      this.root.classList.toggle(`chroma-perf-${p}`, o.performance === p);
    }
    this.transitionMs = o.transitionMs;
    this.setVar('--chroma-dur', `${o.transitionMs}ms`);
    this.setVar('--chroma-glow-strength', String(o.glowIntensity / 100));
  }

  setLayout(l: { fullscreen: boolean; ambient: boolean }) {
    // Glow behind a fullscreen player would only bleed into the black bars.
    this.root.classList.toggle('chroma-fs', l.fullscreen);
    this.root.classList.toggle('chroma-ambient', l.ambient);
  }

  get current(): Palette | null {
    return this.palette;
  }

  apply(p: Palette, theme: Theme) {
    clearTimeout(this.idleTimer);
    cancelAnimationFrame(this.fadeInRaf);
    const wasIdle = !this.root.classList.contains('chroma-active') || this.palette === null;
    this.palette = p;

    if (!wasIdle) {
      this.writePalette(p, theme);
      return;
    }
    // Coming from stock colors: snap our variables into place while they're
    // still invisible (--chroma-mix is 0), then fade the mix in — otherwise
    // the page would visibly animate from a stale palette.
    //
    // The snap needs one style pass with a 0 ms duration. Forcing it with
    // getComputedStyle would recalc all of YouTube synchronously (measured
    // 10–20 ms); instead we let the browser's next frame do it. rAF callbacks
    // run *before* that frame's style pass, hence two of them.
    this.setVar('--chroma-dur', '0ms');
    this.writePalette(p, theme);
    this.root.classList.add('chroma-active');
    this.fadeInRaf = requestAnimationFrame(() => {
      this.fadeInRaf = requestAnimationFrame(() => {
        this.setVar('--chroma-dur', `${this.transitionMs}ms`);
        this.setVar('--chroma-mix', '1');
      });
    });
  }

  private writePalette(p: Palette, theme: Theme) {
    this.setVar('--chroma-accent', toHex(p.vibrant));
    this.setVar('--chroma-accent-dark', toHex(p.vibrantDark));
    this.setVar('--chroma-accent-light', toHex(p.vibrantLight));
    this.setVar('--chroma-muted', toHex(p.muted));
    this.setVar('--chroma-glow', toHex(p.vibrant));
    this.setVar('--chroma-on-accent', toHex(p.onAccent));
    this.setVar('--chroma-bg-tint', toHex(p.muted));
    // Link text sits on the page background, so it uses whichever variant
    // palette.ts guaranteed at 4.5:1 for this theme.
    this.setVar('--chroma-link', toHex(theme === 'dark' ? p.vibrantLight : p.vibrantDark));
  }

  /** Cross-fade back to YouTube's stock colors, then drop our rules entirely. */
  fadeOut() {
    if (!this.root.classList.contains('chroma-active')) {
      this.palette = null;
      return;
    }
    this.palette = null;
    cancelAnimationFrame(this.fadeInRaf);
    this.setVar('--chroma-dur', `${this.transitionMs}ms`);
    this.setVar('--chroma-mix', '0');
    clearTimeout(this.idleTimer);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.idleTimer = window.setTimeout(() => this.root.classList.remove('chroma-active'), reduced ? 0 : FADE_MS + 50);
  }

  private setVar(name: string, value: string) {
    this.vars.set(name, value);
    this.root.style.setProperty(name, value);
  }

  private restoreVars() {
    for (const [name, value] of this.vars) {
      if (this.root.style.getPropertyValue(name) !== value) this.root.style.setProperty(name, value);
    }
  }

  destroy() {
    clearTimeout(this.idleTimer);
    cancelAnimationFrame(this.fadeInRaf);
    const classes = [...this.root.classList].filter((c) => c.startsWith('chroma-'));
    this.root.classList.remove(...classes);
    this.styleObserver?.disconnect();
    this.styleObserver = null;
    for (const name of this.vars.keys()) this.root.style.removeProperty(name);
    this.vars.clear();
    this.baseStyle?.remove();
    this.tokenStyle?.remove();
    this.baseStyle = this.tokenStyle = null;
    this.palette = null;
  }
}
