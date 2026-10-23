# Chroma — ambient theme for YouTube

Recolors YouTube in real time from the video you're watching: accents, progress bar, player glow, scrollbar, selection and an optional background tint. Manifest V3, Chrome 121+ (Edge, Brave, Arc, Opera).

## Setup
```bash
npm install
npm run build      # typecheck + build to dist/ + bundle-size budget check
npm run dev        # Vite dev server with HMR for the popup (reload the tab for content-script changes)
npm run zip        # build + release/chroma-<version>.zip for the Web Store
npm test           # unit tests (color math, quantizer, contrast guarantees, settings migration)
CHROME_PATH=… npm run e2e   # live YouTube smoke test (needs Chrome for Testing: npx @puppeteer/browsers install chrome@stable)
```

**Load unpacked:** `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/`.

## Architecture
```mermaid
flowchart LR
  subgraph Page[YouTube tab · content script]
    W[video-watcher<br/>SPA events + observers] --> S[sampler<br/>timer → rVFC → createImageBitmap 64×36]
    S --> G[gpu-readback<br/>WebGL2 PBO + fence, async]
    P[palette.ts<br/>roles + contrast + hysteresis] --> A[theme-applier<br/>@property vars + token overrides]
  end
  subgraph SW[Service worker]
    Q[palette.worker<br/>k-means in OKLab]
    T[thumbnail fallback<br/>i.ytimg.com + LRU 50]
  end
  G -- 9 KB pixels --> Q -- clusters --> P
  P -. DRM / black / Static mode .-> T -- clusters --> P
  Popup -- chrome.storage.sync --> Page
  Page -- port: live palette --> Popup
```

## Design notes (found by testing against live YouTube)
- **YouTube's color tokens are obfuscated.** `--yt-spec-*` variables are no longer defined; components read per-build hashed tokens (`--t2d807…`). `tokens.ts` finds them at runtime by their dark/light value signature, so it survives re-hashing. Legacy names are still overridden.
- **Palette extraction runs in the service worker, not a page Worker.** YouTube's CSP blocks `blob:`/`data:` workers and extension-URL workers are cross-origin. The service worker is the only off-main-thread context reachable with just `storage` permission. A main-thread fallback exists.
- **Readback uses WebGL2, not `getImageData`.** Canvas readback of a video frame stalls ~2 ms on the GPU (even on Apple M5). WebGL2 `readPixels` into a pixel-pack buffer + fence is async. Measured: longest main-thread block per sample ≈ 0.5 ms median, < 2 ms max.
- **Content script is a standalone IIFE** (CRXJS `standaloneFiles`) — the default dynamic-import loader logs errors in YouTube's console.
- All YouTube selectors live in `src/content/selectors.ts`, injected into CSS via forgiving `:is()` so a stale selector skips one target instead of breaking others.

## Known limitations
- Verified on macOS (Apple Silicon) Chrome for Testing 156 only. Windows, Edge, High Contrast, display scaling and the miniplayer still need a manual pass per the checklist.
- The DRM/thumbnail path is implemented, but a paid rental hasn't been tested.
- Shorts' Subscribe button uses different markup and isn't themed yet.
- Palette transitions recalc inherited custom properties across YouTube's DOM; Battery mode reduces glow cost but not this.
- YouTube changes its DOM often; expect to update `selectors.ts` occasionally.
