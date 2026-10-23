// Palette extraction, off the page's main thread.
//
// This runs inside the extension's service worker rather than a dedicated
// Web Worker spawned by the content script. YouTube's CSP has no `blob:` or
// `data:` in script-src (so inline workers are refused, with a console
// error), and a chrome-extension:// worker URL is cross-origin from
// youtube.com. The service worker is the one off-main-thread context an
// MV3 extension with only the "storage" permission can always reach.
//
// The content script still does the cheap part (createImageBitmap → 64×36
// readback, ~0.1 ms) and posts the pixels here; k-means, the part that
// scales with CPU speed, never touches YouTube's main thread.

import { decodePixels } from '../shared/bitmap';
import { quantize, type QuantizeResult } from '../shared/quantize';

export interface AnalyzeRequest {
  type: 'chroma:analyze';
  width: number;
  height: number;
  /** Base64 RGBA, see encodePixels. */
  pixels: string;
}

const MAX_PIXELS = 128 * 128;

export function isAnalyzeRequest(msg: unknown): msg is AnalyzeRequest {
  const m = msg as AnalyzeRequest;
  return (
    m?.type === 'chroma:analyze' &&
    Number.isInteger(m.width) &&
    Number.isInteger(m.height) &&
    m.width > 0 &&
    m.height > 0 &&
    m.width * m.height <= MAX_PIXELS &&
    typeof m.pixels === 'string'
  );
}

export function handleAnalyze(req: AnalyzeRequest): QuantizeResult | null {
  const data = decodePixels(req.pixels);
  if (data.length !== req.width * req.height * 4) return null;
  return quantize(data, req.width, req.height);
}
