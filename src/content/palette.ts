// Turns raw clusters into a themed, accessible Palette.
//
// Lives on the main thread (it is a few dozen OKLCH conversions, well under
// 0.1 ms) because it depends on YouTube's current light/dark theme, and
// keeping the last raw clusters here lets a theme flip re-derive the palette
// instantly without waiting for the next sample.

import {
  contrastRatio,
  deltaE,
  oklabToOklch,
  oklchToRgb,
  rgbToOklch,
  type LCH,
  type RGB,
} from '../shared/color';
import type { QuantizeResult } from '../shared/quantize';
import type { Palette, Theme } from '../shared/types';

/** YouTube's page backgrounds (`--yt-spec-base-background`). */
export const PAGE_BG: Record<Theme, RGB> = { dark: [15, 15, 15], light: [255, 255, 255] };

/** Beyond ≈0.17 OKLCH chroma, UI accents start to look neon on a dark page. */
const MAX_CHROMA = 0.17;
/** Normalises OKLCH chroma to a 0–1 "saturation" for scoring; ≈ the chroma of vivid sRGB primaries. */
const CHROMA_FULL = 0.25;
/**
 * Sampled accents never drop below this chroma. A pastel sky scores as the
 * "most vibrant" cluster in soft scenes; without a floor the accent becomes
 * an off-white that reads as broken theming rather than a color.
 */
const MIN_SAMPLED_CHROMA = 0.06;
/**
 * Accent lightness bands per theme. Contrast correction only pushes one way,
 * so these keep a near-white (dark theme) or near-black (light theme) accent
 * from passing contrast while looking like plain text.
 */
const ACCENT_L: Record<Theme, [number, number]> = { dark: [0.6, 0.82], light: [0.42, 0.62] };
const NON_TEXT_CONTRAST = 3;
const TEXT_CONTRAST = 4.5;
const NEUTRAL_HUE = 255; // cool slate when there is no hue to borrow
const DARK_TEXT: RGB = [15, 15, 15];
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

export function selectPalette(q: QuantizeResult, theme: Theme): Palette | null {
  if (q.clusters.length === 0) return null;
  if (q.grayscale) return neutralPalette(q, theme);

  let vibrantIdx = 0;
  let bestScore = -1;
  let mutedIdx = -1;
  let bestMuted = -1;
  const lch = q.clusters.map((c) => oklabToOklch(c.lab));

  q.clusters.forEach((c, i) => {
    const [L, C] = lch[i]!;
    const sat = Math.min(1, C / CHROMA_FULL);
    const score = c.population * Math.pow(sat, 1.5) * (1 - Math.abs(L - 0.55));
    if (score > bestScore) {
      bestScore = score;
      vibrantIdx = i;
    }
  });
  q.clusters.forEach((c, i) => {
    if (i === vibrantIdx) return;
    const sat = Math.min(1, lch[i]![1] / CHROMA_FULL);
    const score = c.population * (1 - sat);
    if (score > bestMuted) {
      bestMuted = score;
      mutedIdx = i;
    }
  });

  const vibrant = lch[vibrantIdx]!;
  // No second cluster: derive the muted tone from the accent's hue.
  const muted: LCH = mutedIdx >= 0 ? lch[mutedIdx]! : [vibrant[0], vibrant[1] * 0.3, vibrant[2]];
  const dominant = lch[0]!;
  return buildPalette(vibrant, muted, dominant, theme, MAX_CHROMA, MIN_SAMPLED_CHROMA);
}

/** Custom mode: the user picked the color, so we respect its chroma and only fix contrast. */
export function paletteFromColor(rgb: RGB, theme: Theme): Palette {
  const base = rgbToOklch(rgb);
  return buildPalette(base, [base[0], base[1] * 0.3, base[2]], base, theme, 0.37, 0);
}

/**
 * Black-and-white footage, slides, terminal recordings… A loud accent
 * invented from nothing would look random, so we use a quiet slate that
 * borrows whatever faint hue the frame does have.
 */
function neutralPalette(q: QuantizeResult, theme: Theme): Palette {
  let a = 0;
  let b = 0;
  let L = 0;
  for (const c of q.clusters) {
    a += c.lab[1] * c.population;
    b += c.lab[2] * c.population;
    L += c.lab[0] * c.population;
  }
  const C = Math.hypot(a, b);
  const hue = C > 0.008 ? ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 : NEUTRAL_HUE;
  return buildPalette([0.62, 0.035, hue], [L, 0.015, hue], [L, C, hue], theme, 0.05, 0);
}

function buildPalette(
  base: LCH,
  mutedSrc: LCH,
  dominantSrc: LCH,
  theme: Theme,
  maxChroma: number,
  minChroma: number,
): Palette {
  const [L0, C0, h] = base;
  const C = Math.max(minChroma, Math.min(C0, maxChroma));
  const bg = PAGE_BG[theme];
  const dark = theme === 'dark';
  const dir = dark ? 1 : -1;
  const [lo, hi] = ACCENT_L[theme];

  const vibrant = fitContrast([Math.min(hi, Math.max(lo, L0)), C, h], bg, NON_TEXT_CONTRAST, dir);
  const Lv = rgbToOklch(vibrant)[0];

  // The variant that sits on the page background doubles as link text, so it
  // gets the stricter text-contrast target; the other one only ever appears
  // in the progress-bar gradient over the video's dark control scrim.
  const vibrantLight = dark
    ? fitContrast([Math.min(0.9, Math.max(Lv + 0.1, 0.8)), C * 0.85, h], bg, TEXT_CONTRAST, 1)
    : oklchToRgb([Math.min(0.92, Math.max(Lv + 0.18, 0.8)), C * 0.75, h]);
  const vibrantDark = dark
    ? oklchToRgb([Math.max(0.3, Math.min(Lv - 0.18, 0.5)), C, h])
    : fitContrast([Math.min(Lv - 0.12, 0.48), C, h], bg, TEXT_CONTRAST, -1);

  const muted = oklchToRgb([mutedSrc[0], Math.min(mutedSrc[1], 0.06), mutedSrc[2]]);
  const dominant = oklchToRgb([dominantSrc[0], Math.min(dominantSrc[1], maxChroma), dominantSrc[2]]);

  return { vibrant, vibrantDark, vibrantLight, muted, dominant, onAccent: readableOn(vibrant) };
}

/**
 * Walk OKLCH lightness in `dir` until the color reaches `min` contrast
 * against `bg`. Hue and chroma are preserved (chroma only shrinks if the
 * gamut forces it), so the accent stays recognisably "the video's color".
 */
function fitContrast(lch: LCH, bg: RGB, min: number, dir: 1 | -1): RGB {
  let [L] = lch;
  const [, C, h] = lch;
  let rgb = oklchToRgb([L, C, h]);
  for (let i = 0; i < 100 && contrastRatio(rgb, bg) < min; i++) {
    L += dir * 0.01;
    if (L <= 0 || L >= 1) break;
    rgb = oklchToRgb([L, C, h]);
  }
  return rgb;
}

/**
 * White or near-black, whichever reads better. One of pure white / pure
 * black always clears 4.5:1 against any color, so the final fallback is a
 * guarantee rather than a hope.
 */
function readableOn(accent: RGB): RGB {
  const light = contrastRatio(WHITE, accent);
  const darkC = contrastRatio(DARK_TEXT, accent);
  const pick = light >= darkC ? WHITE : DARK_TEXT;
  if (contrastRatio(pick, accent) >= TEXT_CONTRAST) return pick;
  return contrastRatio(WHITE, accent) >= contrastRatio(BLACK, accent) ? WHITE : BLACK;
}

/**
 * Perceptual distance between two palettes. The accent dominates what the
 * user sees, so it carries most of the weight.
 */
export function paletteDistance(a: Palette, b: Palette): number {
  return 0.75 * deltaE(a.vibrant, b.vibrant) + 0.25 * deltaE(a.dominant, b.dominant);
}
