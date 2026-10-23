// Renders the Chroma orb at each icon size directly (not by downscaling one
// big image) with 4×4 supersampling, so the 16 px version gets its own
// pixel-fitted rim instead of a blurry shrink. Zero dependencies: a tiny PNG
// encoder on top of node:zlib.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { oklchToRgb } from '../src/shared/color.ts';

const SIZES = [16, 32, 48, 128];
const OUT = new URL('../public/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function shade(nx, ny, px) {
  // nx, ny in [-1, 1]; returns [r, g, b, alpha 0–1]
  const d = Math.hypot(nx, ny);
  const R = 0.94;
  if (d > R) return [0, 0, 0, 0];
  const t = d / R;
  // Conic hue sweep — the "prism" — magenta at the top, running clockwise.
  const hue = ((Math.atan2(nx, -ny) * 180) / Math.PI + 360 + 330) % 360;
  // Everything is shaded in OKLCH: chroma stays under the sRGB cusp for every
  // hue (no gamut-clipping seams) and darkening lowers L instead of blending
  // toward grey, so yellows stay golden rather than turning olive.
  const core = smooth(0.0, 0.8, t); // 0 at the white-hot center, 1 at the edge
  const volume = smooth(-0.6, 1.0, (nx + ny) * 0.55 + t * 0.25); // lower-right falls into shadow
  let L = 0.99 - core * 0.22 - volume * 0.09;
  let C = 0.16 * Math.pow(core, 0.8);
  const rimW = Math.max(0.06, 1.5 / px); // ≥ ~1 device px so 16 px still has an edge
  const rim = smooth(R - rimW, R - rimW * 0.25, d);
  L -= rim * 0.2;
  C += rim * 0.02;
  let c = oklchToRgb([L, C, hue]);
  // Specular highlight, upper left.
  const spec = 1 - smooth(0.0, 0.3, Math.hypot((nx + 0.36) * 1.15, ny + 0.42));
  c = mix(c, [255, 255, 255], spec * 0.6);
  return [...c, 1];
}

function render(size) {
  const SS = 4;
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const nx = ((x + (sx + 0.5) / SS) / size) * 2 - 1;
      const ny = ((y + (sy + 0.5) / SS) / size) * 2 - 1;
      const [cr, cg, cb, ca] = shade(nx, ny, size / 2);
      r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
    }
    const i = (y * size + x) * 4;
    // Un-premultiply so edge pixels keep their color instead of going grey.
    px[i] = a ? Math.round(r / a) : 0;
    px[i + 1] = a ? Math.round(g / a) : 0;
    px[i + 2] = a ? Math.round(b / a) : 0;
    px[i + 3] = Math.round((a / (SS * SS)) * 255);
  }
  return png(size, size, px);
}

function png(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const s of SIZES) {
  writeFileSync(new URL(`icon${s}.png`, OUT), render(s));
  console.log(`icon${s}.png`);
}
// A large preview for the README / store listing.
writeFileSync(new URL('../docs/icon-512.png', import.meta.url), (mkdirSync(new URL('../docs/', import.meta.url), { recursive: true }), render(512)));
