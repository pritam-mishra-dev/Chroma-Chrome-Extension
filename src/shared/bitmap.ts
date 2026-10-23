// Reads a tiny ImageBitmap back into pixels. Throws a DOMException named
// "SecurityError" for tainted frames, which callers treat as "this video
// can't be read — use the thumbnail instead".

import { quantize, type QuantizeResult } from './quantize';

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

export function readPixels(bitmap: ImageBitmap): Pixels {
  const { width, height } = bitmap;
  // Reuse one canvas: allocating a fresh backing store per sample is the
  // kind of slow churn that shows up as memory growth over a long session.
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!ctx) throw new Error('2d context unavailable');
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0);
  return { data: ctx.getImageData(0, 0, width, height).data, width, height };
}

export function analyzeBitmap(bitmap: ImageBitmap): QuantizeResult {
  const { data, width, height } = readPixels(bitmap);
  return quantize(data, width, height);
}

export type AnalyzeOutcome =
  | { ok: true; result: QuantizeResult }
  | { ok: false; reason: 'tainted' | 'failed' };

export function errorReason(err: unknown): 'tainted' | 'failed' {
  return err instanceof DOMException && err.name === 'SecurityError' ? 'tainted' : 'failed';
}

// chrome.runtime messaging is JSON-serialised, so a typed array would arrive
// as an object with 9216 numeric keys. Base64 keeps the 64×36 RGBA payload
// at ~12 KB and encodes in well under 0.1 ms.
export function encodePixels(data: Uint8ClampedArray): string {
  let s = '';
  const CHUNK = 0x2000;
  for (let i = 0; i < data.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, data.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(s);
}

export function decodePixels(b64: string): Uint8ClampedArray {
  const s = atob(b64);
  const out = new Uint8ClampedArray(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
