import { describe, expect, it } from 'vitest';
import { contrastRatio, deltaE, fromHex, oklchToRgb, rgbToOklab, oklabToRgb, rgbToOklch, toHex, type RGB } from '../src/shared/color';

describe('color', () => {
  it('round-trips sRGB through OKLab', () => {
    for (let i = 0; i < 500; i++) {
      const c: RGB = [(i * 37) % 256, (i * 91) % 256, (i * 53) % 256];
      expect(oklabToRgb(rgbToOklab(c))).toEqual(c);
    }
  });

  it('matches known OKLab reference values', () => {
    const [L, a, b] = rgbToOklab([255, 0, 0]);
    expect(L).toBeCloseTo(0.628, 3);
    expect(a).toBeCloseTo(0.2249, 3);
    expect(b).toBeCloseTo(0.1258, 3);
  });

  it('computes WCAG contrast', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([118, 118, 118], [255, 255, 255])).toBeCloseTo(4.54, 2);
  });

  it('gamut-maps by reducing chroma, keeping hue', () => {
    const rgb = oklchToRgb([0.7, 0.4, 264]);
    const [, , h] = rgbToOklch(rgb);
    expect(Math.abs(h - 264)).toBeLessThan(4);
  });

  it('parses and formats hex', () => {
    expect(fromHex('#7C5CFF')).toEqual([124, 92, 255]);
    expect(fromHex('abc')).toEqual([170, 187, 204]);
    expect(fromHex('nope')).toBeNull();
    expect(toHex([0, 15, 255])).toBe('#000fff');
  });

  it('ΔE is zero for identical colors and large for opposites', () => {
    expect(deltaE([10, 20, 30], [10, 20, 30])).toBe(0);
    expect(deltaE([0, 0, 0], [255, 255, 255])).toBeGreaterThan(99);
  });
});
