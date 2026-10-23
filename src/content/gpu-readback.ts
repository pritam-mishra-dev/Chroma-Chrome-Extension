// Asynchronous GPU → CPU readback for the 64×36 sample.
//
// Video frames live on the GPU. Reading one back through a 2D canvas
// (drawImage + getImageData) makes the main thread wait for the GPU to drain
// its queue — measured at ~2 ms median, 12 ms worst case, even on an Apple M5,
// and that is YouTube's main thread we'd be stalling.
//
// WebGL2 can do the same copy without waiting: readPixels into a
// PIXEL_PACK_BUFFER is queued on the GPU, a fence tells us when it's done,
// and only then do we fetch the bytes. Main-thread cost is ~0.2 ms to submit
// plus ~0.2 ms to fetch, with nothing blocking in between.

import { readPixels, type Pixels } from '../shared/bitmap';

/** Runs a synchronous main-thread slice and records its duration (see Meter in sampler.ts). */
export interface SliceTimer {
  time<T>(fn: () => T, label?: string): T;
}

const untimed: SliceTimer = { time: (fn) => fn() };

/** Give up on a fence after this long (GPU hung, tab throttled…) and drop the sample. */
const FENCE_TIMEOUT_MS = 250;
const POLL_MS = 4;

export class GpuReadback {
  private canvas: OffscreenCanvas | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private tex: WebGLTexture | null = null;
  private fb: WebGLFramebuffer | null = null;
  private pbo: WebGLBuffer | null = null;
  private texW = 0;
  private texH = 0;
  /** Set when WebGL2 is unavailable or keeps failing; we then use the 2D path. */
  private disabled = false;
  private lost = false;

  get accelerated(): boolean {
    return !this.disabled;
  }

  /**
   * Returns pixels for a small bitmap. Consumes (closes) the bitmap.
   * Rejects with a SecurityError DOMException for tainted frames.
   */
  async read(bitmap: ImageBitmap, meter: SliceTimer = untimed): Promise<Pixels> {
    if (this.disabled || !meter.time(() => this.ensure(), 'gl-init')) {
      return meter.time(() => {
        try {
          return readPixels(bitmap);
        } finally {
          bitmap.close();
        }
      }, '2d-readback');
    }
    const gl = this.gl!;
    const { width, height } = bitmap;
    const bytes = width * height * 4;
    const sync = meter.time(() => this.submit(gl, bitmap, width, height), 'gl-submit');

    const start = performance.now();
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (this.lost) throw new Error('context lost');
        const status = gl.clientWaitSync(sync, 0, 0); // timeout 0: never blocks
        if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) break;
        if (status === gl.WAIT_FAILED || performance.now() - start > FENCE_TIMEOUT_MS) throw new Error('fence timeout');
      }
      return meter.time(() => {
        const data = new Uint8ClampedArray(bytes);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
        // Framebuffer row 0 is texture row 0, i.e. the top of the uploaded
        // bitmap, so no vertical flip is needed.
        return { data, width, height };
      }, 'gl-fetch');
    } finally {
      if (!this.lost) gl.deleteSync(sync);
    }
  }

  /** Queue upload + readPixels + fence. Returns immediately; nothing here waits on the GPU. */
  private submit(gl: WebGL2RenderingContext, bitmap: ImageBitmap, width: number, height: number): WebGLSync {
    let sync: WebGLSync | null = null;
    try {
      this.allocate(gl, width, height);
      // GPU → GPU copy into existing storage. Throws SecurityError for
      // cross-origin (tainted) frames.
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      // With a PACK buffer bound, readPixels only *queues* the copy.
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
    } finally {
      bitmap.close();
    }
    if (!sync) throw new Error('fenceSync failed');
    return sync;
  }

  /**
   * (Re)allocate texture, framebuffer attachment and pack buffer only when
   * the sample size changes (landscape ↔ Shorts), never per sample —
   * first-use allocation was the single most expensive call in the pipeline.
   */
  private allocate(gl: WebGL2RenderingContext, width: number, height: number) {
    if (width === this.texW && height === this.texH) return;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, width * height * 4, gl.STREAM_READ);
    this.texW = width;
    this.texH = height;
  }

  private ensure(): boolean {
    if (this.gl && !this.lost) return true;
    this.release();
    try {
      this.canvas = new OffscreenCanvas(1, 1);
      const gl = this.canvas.getContext('webgl2', {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'low-power',
      });
      if (!gl) {
        this.disabled = true;
        return false;
      }
      this.canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.lost = true;
      });
      this.lost = false;
      this.gl = gl;
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      this.fb = gl.createFramebuffer();
      this.pbo = gl.createBuffer();
      this.texW = this.texH = 0;
      return true;
    } catch {
      this.disabled = true;
      return false;
    }
  }

  /** Create the context ahead of the first sample (see Sampler.warmUp). */
  warmUp(width: number, height: number) {
    if (this.disabled || !this.ensure()) return;
    const gl = this.gl!;
    // Allocate for the common size and push one empty readback through the
    // pipeline, so driver-side lazy initialisation happens now, not mid-video.
    this.allocate(gl, width, height);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    if (sync) setTimeout(() => !this.lost && gl.deleteSync(sync), 100);
  }

  /** Called after repeated non-security failures: stop trying WebGL for this page. */
  disable() {
    this.disabled = true;
    this.release();
  }

  release() {
    const gl = this.gl;
    if (gl && !this.lost) {
      gl.deleteTexture(this.tex);
      gl.deleteFramebuffer(this.fb);
      gl.deleteBuffer(this.pbo);
      // Free the context now rather than waiting for GC; browsers cap live WebGL contexts per page.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.gl = null;
    this.canvas = null;
    this.tex = this.fb = this.pbo = null;
  }
}
