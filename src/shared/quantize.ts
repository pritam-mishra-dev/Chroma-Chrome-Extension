// Weighted k-means in OKLab over a tiny (≈64×36) RGBA buffer.
//
// Shared by three callers: the palette worker (live frames), the service
// worker (thumbnail fallback) and the main-thread fallback used when YouTube's
// CSP refuses to let us spawn a worker. It only finds clusters; picking the
// accent, contrast correction etc. live in content/palette.ts so they can be
// re-run instantly when the user flips YouTube's dark/light theme.

import { hslLS, linearRgbToOklab, oklabToRgb, srgbByteToLinear, type Lab, type RGB } from './color';

export interface Cluster {
  lab: Lab;
  rgb: RGB;
  /** Share (0–1) of the kept, center-weighted pixel mass. */
  population: number;
}

export interface QuantizeResult {
  /** Sorted by population, largest first. Empty when nothing usable was found. */
  clusters: Cluster[];
  /** True when almost no pixel passed the saturation filter (B&W footage, slides…). */
  grayscale: boolean;
  /** Center-weighted mean relative luminance (0–1) of the whole frame — used for black/DRM detection. */
  avgLuma: number;
}

const MIN_L = 0.08;
const MAX_L = 0.95;
const MIN_S = 0.1;
/** Below this share of colorful pixels we treat the frame as grayscale. */
const GRAYSCALE_COVERAGE = 0.04;
const ITERATIONS = 8;
/** Clusters closer than this (OKLab units) are the same color split in two; merge them. */
const MERGE_DIST = 0.035;

export function quantize(data: Uint8ClampedArray, width: number, height: number, k = 6): QuantizeResult {
  const n = width * height;
  // Pixels are copied into flat typed arrays so the k-means inner loop
  // touches contiguous memory and allocates nothing.
  const colorful = new Float32Array(n * 3);
  const colorfulW = new Float32Array(n);
  const neutral = new Float32Array(n * 3);
  const neutralW = new Float32Array(n);
  let nc = 0;
  let nn = 0;
  let lumaSum = 0;
  let weightSum = 0;
  let colorfulWeight = 0;

  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;

  for (let y = 0; y < height; y++) {
    const dy = cy === 0 ? 0 : (y - cy) / cy;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const dx = cx === 0 ? 0 : (x - cx) / cx;
      // Center weighting: the subject is usually central, while edges carry
      // letterbox bars, channel logos and lower-thirds we don't want to theme from.
      const w = Math.max(0.25, 1 - 0.5 * (dx * dx + dy * dy));

      const lr = srgbByteToLinear(r);
      const lg = srgbByteToLinear(g);
      const lb = srgbByteToLinear(b);
      lumaSum += w * (0.2126 * lr + 0.7152 * lg + 0.0722 * lb);
      weightSum += w;

      const [l, s] = hslLS(r, g, b);
      if (l < MIN_L || l > MAX_L) continue;
      const lab = linearRgbToOklab(lr, lg, lb);
      if (s >= MIN_S) {
        colorful[nc * 3] = lab[0];
        colorful[nc * 3 + 1] = lab[1];
        colorful[nc * 3 + 2] = lab[2];
        colorfulW[nc++] = w;
        colorfulWeight += w;
      } else {
        neutral[nn * 3] = lab[0];
        neutral[nn * 3 + 1] = lab[1];
        neutral[nn * 3 + 2] = lab[2];
        neutralW[nn++] = w;
      }
    }
  }

  const avgLuma = weightSum > 0 ? lumaSum / weightSum : 0;
  const grayscale = weightSum === 0 || colorfulWeight / weightSum < GRAYSCALE_COVERAGE;

  // For grayscale frames, cluster everything that isn't pure black/white so
  // palette.ts can still build a (deliberately neutral) palette from it.
  let pts: Float32Array;
  let wts: Float32Array;
  let count: number;
  if (!grayscale) {
    pts = colorful;
    wts = colorfulW;
    count = nc;
  } else {
    pts = new Float32Array(n * 3);
    wts = new Float32Array(n);
    pts.set(colorful.subarray(0, nc * 3));
    wts.set(colorfulW.subarray(0, nc));
    pts.set(neutral.subarray(0, nn * 3), nc * 3);
    wts.set(neutralW.subarray(0, nn), nc);
    count = nc + nn;
  }

  if (count === 0) return { clusters: [], grayscale, avgLuma };
  return { clusters: kmeans(pts, wts, count, Math.min(k, count)), grayscale, avgLuma };
}

function kmeans(pts: Float32Array, wts: Float32Array, count: number, k: number): Cluster[] {
  const centers = initCenters(pts, wts, count, k);
  const assign = new Uint8Array(count);
  const sums = new Float64Array(k * 4);

  for (let iter = 0; iter < ITERATIONS; iter++) {
    let moved = false;
    for (let i = 0; i < count; i++) {
      const L = pts[i * 3]!;
      const A = pts[i * 3 + 1]!;
      const B = pts[i * 3 + 2]!;
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const dl = L - centers[c * 3]!;
        const da = A - centers[c * 3 + 1]!;
        const db = B - centers[c * 3 + 2]!;
        const d = dl * dl + da * da + db * db;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign[i] !== best) moved = true;
      assign[i] = best;
    }

    sums.fill(0);
    for (let i = 0; i < count; i++) {
      const c = assign[i]!;
      const w = wts[i]!;
      sums[c * 4] += pts[i * 3]! * w;
      sums[c * 4 + 1] += pts[i * 3 + 1]! * w;
      sums[c * 4 + 2] += pts[i * 3 + 2]! * w;
      sums[c * 4 + 3] += w;
    }
    for (let c = 0; c < k; c++) {
      const w = sums[c * 4 + 3]!;
      if (w > 0) {
        centers[c * 3] = sums[c * 4]! / w;
        centers[c * 3 + 1] = sums[c * 4 + 1]! / w;
        centers[c * 3 + 2] = sums[c * 4 + 2]! / w;
      }
    }
    if (!moved && iter > 0) break;
  }

  let total = 0;
  for (let c = 0; c < k; c++) total += sums[c * 4 + 3]!;

  const raw: { lab: Lab; w: number }[] = [];
  for (let c = 0; c < k; c++) {
    const w = sums[c * 4 + 3]!;
    if (w > 0) raw.push({ lab: [centers[c * 3]!, centers[c * 3 + 1]!, centers[c * 3 + 2]!], w });
  }
  raw.sort((a, b) => b.w - a.w);

  // Merge near-duplicates so one large red object split across two clusters
  // keeps its full population when palette.ts scores it.
  const merged: { lab: Lab; w: number }[] = [];
  for (const c of raw) {
    const twin = merged.find(
      (m) => Math.hypot(m.lab[0] - c.lab[0], m.lab[1] - c.lab[1], m.lab[2] - c.lab[2]) < MERGE_DIST,
    );
    if (twin) {
      const w = twin.w + c.w;
      twin.lab = [
        (twin.lab[0] * twin.w + c.lab[0] * c.w) / w,
        (twin.lab[1] * twin.w + c.lab[1] * c.w) / w,
        (twin.lab[2] * twin.w + c.lab[2] * c.w) / w,
      ];
      twin.w = w;
    } else {
      merged.push({ lab: c.lab, w: c.w });
    }
  }

  return merged
    .sort((a, b) => b.w - a.w)
    .map((m) => ({ lab: m.lab, rgb: oklabToRgb(m.lab), population: total > 0 ? m.w / total : 0 }));
}

/**
 * Deterministic farthest-point initialisation, seeded from the weighted mean.
 * Random k-means++ would give different clusters for two near-identical
 * frames, and that jitter would show up as palette flicker.
 */
function initCenters(pts: Float32Array, wts: Float32Array, count: number, k: number): Float64Array {
  const centers = new Float64Array(k * 3);
  let sl = 0;
  let sa = 0;
  let sb = 0;
  let sw = 0;
  for (let i = 0; i < count; i++) {
    const w = wts[i]!;
    sl += pts[i * 3]! * w;
    sa += pts[i * 3 + 1]! * w;
    sb += pts[i * 3 + 2]! * w;
    sw += w;
  }
  centers[0] = sl / sw;
  centers[1] = sa / sw;
  centers[2] = sb / sw;

  const minD = new Float64Array(count).fill(Infinity);
  for (let c = 1; c < k; c++) {
    const pl = centers[(c - 1) * 3]!;
    const pa = centers[(c - 1) * 3 + 1]!;
    const pb = centers[(c - 1) * 3 + 2]!;
    let best = 0;
    let bestScore = -1;
    for (let i = 0; i < count; i++) {
      const dl = pts[i * 3]! - pl;
      const da = pts[i * 3 + 1]! - pa;
      const db = pts[i * 3 + 2]! - pb;
      const d = dl * dl + da * da + db * db;
      if (d < minD[i]!) minD[i] = d;
      const score = minD[i]! * wts[i]!;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    centers[c * 3] = pts[best * 3]!;
    centers[c * 3 + 1] = pts[best * 3 + 1]!;
    centers[c * 3 + 2] = pts[best * 3 + 2]!;
  }
  return centers;
}
