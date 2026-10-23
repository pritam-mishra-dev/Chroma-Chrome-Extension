import { describe, expect, it } from 'vitest';
import { contrastRatio, rgbToOklch, type RGB } from '../src/shared/color';
import { quantize } from '../src/shared/quantize';
import { PAGE_BG, paletteFromColor, selectPalette } from '../src/content/palette';
import type { Theme } from '../src/shared/types';

const W = 64;
const H = 36;

function frame(fill: (x: number, y: number) => RGB): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [r, g, b] = fill(x, y);
      const i = (y * W + x) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  return d;
}

describe('quantize', () => {
  it('reports black frames via avgLuma and yields no clusters', () => {
    const q = quantize(frame(() => [0, 0, 0]), W, H);
    expect(q.avgLuma).toBe(0);
    expect(q.clusters).toHaveLength(0);
  });

  it('flags grayscale footage', () => {
    const q = quantize(frame((x) => [x * 3, x * 3, x * 3]), W, H);
    expect(q.grayscale).toBe(true);
    expect(q.clusters.length).toBeGreaterThan(0);
  });

  it('finds the saturated subject over a large dull background', () => {
    // Grey-blue sky with an orange subject in the center third.
    const q = quantize(
      frame((x, y) => (x > 21 && x < 43 && y > 10 && y < 26 ? [235, 120, 30] : [90, 100, 115])),
      W, H,
    );
    const p = selectPalette(q, 'dark')!;
    const [, , h] = rgbToOklch(p.vibrant);
    expect(h).toBeGreaterThan(30);
    expect(h).toBeLessThan(80); // orange
  });

  it('is deterministic for identical input', () => {
    const f = frame((x, y) => [(x * 4) % 256, (y * 7) % 256, (x * y) % 256]);
    expect(quantize(f, W, H)).toEqual(quantize(f, W, H));
  });

  it('ignores letterbox bars', () => {
    const q = quantize(frame((_x, y) => (y < 5 || y > 30 ? [0, 0, 0] : [40, 160, 70])), W, H);
    expect(q.clusters[0]!.population).toBeGreaterThan(0.95);
  });
});

describe('palette contrast guarantees', () => {
  const themes: Theme[] = ['dark', 'light'];
  // Sweep hues × lightness × chroma, including the awkward ones (yellow on white, navy on black).
  const inputs: RGB[] = [];
  for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) inputs.push([r, g, b]);

  for (const theme of themes) {
    it(`accent ≥ 3:1, link variant ≥ 4.5:1, onAccent ≥ 4.5:1 (${theme})`, () => {
      const bg = PAGE_BG[theme];
      for (const c of inputs) {
        const p = paletteFromColor(c, theme);
        expect(contrastRatio(p.vibrant, bg), `accent ${c}`).toBeGreaterThanOrEqual(3);
        const link = theme === 'dark' ? p.vibrantLight : p.vibrantDark;
        expect(contrastRatio(link, bg), `link ${c}`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(p.onAccent, p.vibrant), `onAccent ${c}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('clamps chroma for sampled palettes so nothing goes neon', () => {
    const q = quantize(frame(() => [0, 255, 0]), W, H);
    const p = selectPalette(q, 'dark')!;
    expect(rgbToOklch(p.vibrant)[1]).toBeLessThanOrEqual(0.171);
  });
});

describe('palette character', () => {
  it('keeps a pastel scene recognisably colored instead of near-white', () => {
    const q = quantize(frame(() => [250, 222, 220]), W, H); // pale pink sky
    for (const theme of ['dark', 'light'] as const) {
      const [L, C] = rgbToOklch(selectPalette(q, theme)!.vibrant);
      expect(C).toBeGreaterThanOrEqual(0.05);
      expect(L).toBeLessThanOrEqual(theme === 'dark' ? 0.83 : 0.63);
    }
  });
});
