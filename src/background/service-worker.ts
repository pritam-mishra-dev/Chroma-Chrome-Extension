// Service worker: thumbnail palettes (the fallback for DRM / unreadable
// frames and the source for Static mode), the toggle shortcut, and settings
// migration on install/update.

import { handleAnalyze, isAnalyzeRequest } from '../content/palette.worker';
import { analyzeBitmap } from '../shared/bitmap';
import { LRU } from '../shared/lru';
import type { QuantizeResult } from '../shared/quantize';
import type { ThumbnailRequest } from '../shared/runtime';
import {
  SETTINGS_KEY,
  defaultPerformanceFor,
  loadSettings,
  migrate,
  onSettingsChanged,
  updateSettings,
  type Settings,
} from '../shared/settings';

const VIDEO_ID = /^[\w-]{11}$/;
// maxres first: it has no letterbox bars and more detail. It 404s for many
// older/smaller videos, in which case hqdefault always exists.
const THUMBNAILS = ['maxresdefault.jpg', 'hqdefault.jpg'];

// In-memory only: a service worker is torn down after ~30 s idle, which
// conveniently bounds this cache's lifetime as well as its size.
const cache = new LRU<string, QuantizeResult | null>(50);
const inflight = new Map<string, Promise<QuantizeResult | null>>();

async function thumbnailPalette(videoId: string): Promise<QuantizeResult | null> {
  if (cache.has(videoId)) return cache.get(videoId) ?? null;
  let p = inflight.get(videoId);
  if (!p) {
    p = extract(videoId).finally(() => inflight.delete(videoId));
    inflight.set(videoId, p);
  }
  const result = await p;
  cache.set(videoId, result);
  return result;
}

async function extract(videoId: string): Promise<QuantizeResult | null> {
  for (const name of THUMBNAILS) {
    try {
      const res = await fetch(`https://i.ytimg.com/vi/${videoId}/${name}`, { credentials: 'omit' });
      if (!res.ok) continue;
      const full = await createImageBitmap(await res.blob());
      const { width, height } = full;
      // hqdefault is 4:3 with black bars around a 16:9 frame; crop to the
      // 16:9 band first, then trim 5% like live frames do.
      const bandH = width / height < 1.5 ? (width * 9) / 16 : height;
      const sx = width * 0.05;
      const sy = (height - bandH) / 2 + bandH * 0.05;
      const small = await createImageBitmap(full, sx, sy, width - 2 * sx, bandH * 0.9, {
        resizeWidth: 64,
        resizeHeight: 36,
        resizeQuality: 'medium',
      });
      full.close();
      try {
        return analyzeBitmap(small);
      } finally {
        small.close();
      }
    } catch {
      // Network error or undecodable image: try the next size.
    }
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (isAnalyzeRequest(msg)) {
    // Synchronous: a 64×36 k-means finishes long before an await would help.
    sendResponse({ result: handleAnalyze(msg) });
    return false;
  }
  if (!isThumbnailRequest(msg)) return false;
  thumbnailPalette(msg.videoId).then(
    (result) => sendResponse({ result }),
    () => sendResponse({ result: null }),
  );
  return true; // keep the channel open for the async response
});

function isThumbnailRequest(msg: unknown): msg is ThumbnailRequest {
  const m = msg as ThumbnailRequest;
  return m?.type === 'chroma:thumbnail' && typeof m.videoId === 'string' && VIDEO_ID.test(m.videoId);
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-chroma') return;
  const s = await loadSettings();
  await updateSettings({ enabled: !s.enabled });
});

chrome.runtime.onInstalled.addListener(async () => {
  const stored = (await chrome.storage.sync.get(SETTINGS_KEY))[SETTINGS_KEY];
  let next: Settings;
  if (stored === undefined) {
    // First install: big blurred shadows and frequent sampling are what hurt
    // on low-core laptops, so start those machines in Battery mode.
    next = { ...migrate(undefined), performance: defaultPerformanceFor(navigator.hardwareConcurrency) };
  } else {
    // Update: bring whatever an older version stored up to the current schema.
    next = migrate(stored);
  }
  await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
  await updateBadge(next);
});

chrome.runtime.onStartup.addListener(async () => updateBadge(await loadSettings()));
onSettingsChanged((s) => void updateBadge(s));

async function updateBadge(s: Settings) {
  await chrome.action.setBadgeText({ text: s.enabled ? '' : 'off' });
  await chrome.action.setBadgeBackgroundColor({ color: '#3a3a3a' });
}
