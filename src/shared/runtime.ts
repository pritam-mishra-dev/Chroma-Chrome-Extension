// Wrappers around chrome.runtime that survive the extension being reloaded,
// updated or disabled while a YouTube tab stays open. In that state the old
// content script keeps running but every chrome.* call throws
// "Extension context invalidated", so callers need a way to notice and stand down.

export function isContextValid(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

export async function safeSendMessage<T>(message: unknown): Promise<T | null> {
  if (!isContextValid()) return null;
  try {
    return (await chrome.runtime.sendMessage(message)) as T;
  } catch {
    return null;
  }
}

/** Messages exchanged between content script, service worker and popup. */
export type ThumbnailRequest = { type: 'chroma:thumbnail'; videoId: string };
export type PopupPort = 'chroma-popup';
export const POPUP_PORT: PopupPort = 'chroma-popup';
