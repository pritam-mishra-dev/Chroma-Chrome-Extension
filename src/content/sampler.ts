// Frame capture and throttling.
//
// Scheduling model: wait `interval` ms with a timer, then ask for exactly one
// requestVideoFrameCallback. Leaving rVFC registered permanently would wake
// us 60 times a second just to throw most frames away; a timer → single rVFC
// costs one callback per sample and still lands on a freshly presented frame.

import { encodePixels, errorReason, type AnalyzeOutcome, type Pixels } from '../shared/bitmap';
import { quantize, type QuantizeResult } from '../shared/quantize';
import { safeSendMessage } from '../shared/runtime';
import { GpuReadback } from './gpu-readback';
import type { AnalyzeRequest } from './palette.worker';

const SAMPLE_W = 64;
const SAMPLE_H = 36;
/** Crop this fraction off every edge: letterbox bars, burned-in logos, captions. */
const EDGE_CROP = 0.05;
/** Consecutive service-worker misses before we stop paying for the round trip. */
const REMOTE_GIVE_UP = 3;
/** Consecutive non-security WebGL failures before falling back to the 2D readback. */
const GPU_GIVE_UP = 3;

type VideoWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * Accumulates the synchronous main-thread slices of one sample. A sample is
 * spread over several tasks (capture call, GPU submit, fetch, apply), and the
 * budget that matters is the longest uninterrupted block, not just the sum.
 */
class Meter {
  total = 0;
  worst = 0;
  worstLabel = '';
  time<T>(fn: () => T, label = ''): T {
    const t = performance.now();
    try {
      return fn();
    } finally {
      const d = performance.now() - t;
      this.total += d;
      if (d > this.worst) {
        this.worst = d;
        this.worstLabel = label;
      }
    }
  }
}

/**
 * Hands pixels to the palette worker (in the service worker, see
 * palette.worker.ts for why), falling back to quantizing here if it is
 * unreachable. At 64×36 the fallback still costs well under a millisecond.
 */
class Analyzer {
  private remote = true;
  private misses = 0;

  get usingWorker(): boolean {
    return this.remote;
  }

  async analyze(px: Pixels, meter: Meter): Promise<AnalyzeOutcome> {
    if (this.remote) {
      const pending = meter.time(() => {
        const req: AnalyzeRequest = { type: 'chroma:analyze', width: px.width, height: px.height, pixels: encodePixels(px.data) };
        return safeSendMessage<{ result: QuantizeResult | null }>(req);
      }, 'encode+post');
      const res = await pending;
      if (res?.result) {
        this.misses = 0;
        return { ok: true, result: res.result };
      }
      if (++this.misses >= REMOTE_GIVE_UP) this.remote = false;
    }
    return { ok: true, result: meter.time(() => quantize(px.data, px.width, px.height), 'quantize') };
  }
}

export class Sampler {
  private video: VideoWithRVFC | null = null;
  private interval = 500;
  private enabled = false;
  private held = false;
  private inFlight = false;
  private timer: number | undefined;
  private rvfc: number | undefined;
  private analyzer = new Analyzer();
  private reader = new GpuReadback();
  private gpuFailures = 0;
  private warm = false;
  private warming = false;
  private onVisibility = () => this.kick(0);

  constructor(private onSample: (outcome: AnalyzeOutcome, video: HTMLVideoElement) => void) {
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /**
   * Creating a WebGL context takes ~10 ms. Do it while the browser is idle so
   * that cost never lands inside a frame the user is watching.
   */
  private warmUp() {
    this.warming = true;
    const run = () => {
      this.reader.warmUp(SAMPLE_W, SAMPLE_H);
      this.warming = false;
      this.warm = true;
      this.kick(0); // the first sample was deferred until now
    };
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1000 });
    else setTimeout(run, 0);
  }

  attach(video: HTMLVideoElement | null) {
    if (video === this.video) return;
    this.cancel();
    this.video = video;
    this.held = false;
    this.kick(0);
  }

  setInterval(ms: number) {
    if (ms === this.interval) return;
    this.interval = ms;
    this.kick(ms);
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (on && !this.warm) {
      if (!this.warming) this.warmUp();
    } else if (on) this.kick(0);
    else this.cancel();
  }

  /** Stop sampling until `release` — used while the user scrubs. */
  hold() {
    this.held = true;
    this.cancel();
  }

  /** Resume after `delay` ms. Calling again restarts the delay, which is what debounces rapid seeks. */
  release(delay: number) {
    this.held = false;
    this.kick(delay);
  }

  /** (Re)start the loop, e.g. on play or when the tab becomes visible again. */
  kick(delay = 0) {
    this.cancel();
    if (this.warm && this.shouldRun()) this.timer = window.setTimeout(() => this.requestFrame(), delay);
  }

  private shouldRun(): boolean {
    const v = this.video;
    return (
      this.enabled &&
      !this.held &&
      !!v &&
      v.isConnected &&
      !v.paused &&
      !v.ended &&
      document.visibilityState === 'visible'
    );
  }

  private cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.rvfc !== undefined) this.video?.cancelVideoFrameCallback?.(this.rvfc);
    this.rvfc = undefined;
  }

  private requestFrame() {
    const v = this.video;
    if (!v || !this.shouldRun()) return;
    if (typeof v.requestVideoFrameCallback === 'function') {
      this.rvfc = v.requestVideoFrameCallback(() => {
        this.rvfc = undefined;
        void this.capture();
      });
    } else {
      // No rVFC: the timer chain alone is our setInterval. A chained timeout
      // rather than a real setInterval so a slow capture can never overlap the next.
      void this.capture();
    }
  }

  private async capture() {
    const v = this.video;
    if (!v || this.inFlight || !this.shouldRun()) return;
    if (v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !v.videoWidth) {
      this.kick(this.interval);
      return;
    }
    this.inFlight = true;
    const meter = new Meter();
    let outcome: AnalyzeOutcome;
    try {
      const pending = meter.time(() => {
        const sx = v.videoWidth * EDGE_CROP;
        const sy = v.videoHeight * EDGE_CROP;
        const sw = v.videoWidth - 2 * sx;
        const sh = v.videoHeight - 2 * sy;
        // Keep the sample's orientation so Shorts aren't squashed sideways;
        // the pixel count (and cost) stays the same either way.
        const portrait = sh > sw;
        // The resize happens on the GPU, asynchronously; we never touch a full-size frame.
        return createImageBitmap(v, sx, sy, sw, sh, {
          resizeWidth: portrait ? SAMPLE_H : SAMPLE_W,
          resizeHeight: portrait ? SAMPLE_W : SAMPLE_H,
          resizeQuality: 'low',
        });
      }, 'capture');
      const bitmap = await pending;
      const px = await this.readback(bitmap, meter);
      outcome = await this.analyzer.analyze(px, meter);
    } catch (err) {
      outcome = { ok: false, reason: errorReason(err) };
    }
    this.inFlight = false;

    // The video may have changed while we awaited; drop stale results.
    if (v !== this.video) return;
    meter.time(() => this.onSample(outcome, v), 'apply');
    if (__CHROMA_DEV__) {
      console.debug(
        `[chroma] sample ${meter.total.toFixed(2)} ms main-thread, longest block ${meter.worst.toFixed(2)} ms [${meter.worstLabel}] ` +
          `(${this.reader.accelerated ? 'webgl readback' : '2d readback'}, ${this.analyzer.usingWorker ? 'palette worker' : 'main-thread fallback'})`,
      );
    }
    this.kick(this.interval);
  }

  /** WebGL async readback, degrading to the 2D canvas if the GPU path keeps failing. */
  private async readback(bitmap: ImageBitmap, meter: Meter): Promise<Pixels> {
    try {
      const px = await this.reader.read(bitmap, meter);
      this.gpuFailures = 0;
      return px;
    } catch (err) {
      if (errorReason(err) === 'tainted') throw err;
      if (++this.gpuFailures >= GPU_GIVE_UP) this.reader.disable();
      throw err;
    }
  }

  destroy() {
    this.cancel();
    this.video = null;
    this.reader.release();
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}
