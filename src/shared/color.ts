// Color math shared by the content script, the palette worker and the
// service worker. Kept dependency-free and allocation-light because the
// quantizer calls into it for every sampled pixel.

/** sRGB channels, 0–255. A tuple (not an object) so it structured-clones cheaply. */
export type RGB = [number, number, number];
/** OKLab: L 0–1, a/b roughly ±0.4. */
export type Lab = [number, number, number];
/** OKLCH: L 0–1, C 0–~0.37, h in degrees. */
export type LCH = [number, number, number];

// A 256-entry table turns the per-pixel pow() into a lookup; the quantizer
// converts ~2300 pixels per sample, so this is the hottest path we have.
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function srgbByteToLinear(v: number): number {
  return SRGB_TO_LINEAR[v | 0]!;
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Convert linear-light sRGB (0–1) to OKLab. Split out so the quantizer can reuse the LUT. */
export function linearRgbToOklab(r: number, g: number, b: number): Lab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function rgbToOklab([r, g, b]: RGB): Lab {
  return linearRgbToOklab(srgbByteToLinear(r), srgbByteToLinear(g), srgbByteToLinear(b));
}

/** OKLab → linear sRGB, unclamped (values outside 0–1 mean out of gamut). */
export function oklabToLinearRgb([L, a, b]: Lab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function linearToByte(c: number): number {
  return Math.round(Math.min(1, Math.max(0, linearToSrgb(c))) * 255);
}

export function oklabToRgb(lab: Lab): RGB {
  const [r, g, b] = oklabToLinearRgb(lab);
  return [linearToByte(r), linearToByte(g), linearToByte(b)];
}

export function oklabToOklch([L, a, b]: Lab): LCH {
  const C = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [L, C, h];
}

export function oklchToOklab([L, C, h]: LCH): Lab {
  const r = (h * Math.PI) / 180;
  return [L, C * Math.cos(r), C * Math.sin(r)];
}

export function rgbToOklch(rgb: RGB): LCH {
  return oklabToOklch(rgbToOklab(rgb));
}

const GAMUT_EPS = 0.0005;
function inGamut([r, g, b]: [number, number, number]): boolean {
  return (
    r >= -GAMUT_EPS && r <= 1 + GAMUT_EPS &&
    g >= -GAMUT_EPS && g <= 1 + GAMUT_EPS &&
    b >= -GAMUT_EPS && b <= 1 + GAMUT_EPS
  );
}

/**
 * OKLCH → sRGB, reducing chroma (never lightness or hue) until the color
 * fits. Clipping channels instead would shift hue — a saturated blue would
 * turn purple — which reads as "wrong color" far more than slightly less
 * saturation does.
 */
export function oklchToRgb([L, C, h]: LCH): RGB {
  L = Math.min(1, Math.max(0, L));
  if (inGamut(oklabToLinearRgb(oklchToOklab([L, C, h])))) {
    return oklabToRgb(oklchToOklab([L, C, h]));
  }
  let lo = 0;
  let hi = C;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklabToLinearRgb(oklchToOklab([L, mid, h])))) lo = mid;
    else hi = mid;
  }
  return oklabToRgb(oklchToOklab([L, lo, h]));
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance([r, g, b]: RGB): number {
  return 0.2126 * srgbByteToLinear(r) + 0.7152 * srgbByteToLinear(g) + 0.0722 * srgbByteToLinear(b);
}

export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** ΔE OK, scaled ×100 so thresholds read like the familiar CIE ΔE numbers. */
export function deltaE(a: RGB, b: RGB): number {
  const [L1, a1, b1] = rgbToOklab(a);
  const [L2, a2, b2] = rgbToOklab(b);
  return 100 * Math.hypot(L1 - L2, a1 - a2, b1 - b2);
}

/** HSL lightness/saturation (0–1), used only for the cheap pixel pre-filter. */
export function hslLS(r: number, g: number, b: number): [number, number] {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [l, s];
}

export function toHex([r, g, b]: RGB): string {
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

export function fromHex(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbEquals(a: RGB, b: RGB): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
