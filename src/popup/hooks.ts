// Data plumbing for the popup: settings (chrome.storage.sync, live both
// ways) and the active tab's palette (a port to its content script).

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { POPUP_PORT } from '../shared/runtime';
import { loadSettings, onSettingsChanged, updateSettings, type Settings, type SettingsPatch } from '../shared/settings';
import type { PopupState } from '../shared/types';

/** sync storage allows ~120 writes/minute; a slider drag would blow through that unthrottled. */
const WRITE_THROTTLE_MS = 400;

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const pending = useRef<SettingsPatch>({});
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    void loadSettings().then(setSettings);
    // Keeps the popup honest when the keyboard shortcut toggles Chroma while it's open.
    return onSettingsChanged(setSettings);
  }, []);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length) void updateSettings(patch);
  }, []);

  /** Optimistic local update; storage writes are throttled. `commit` forces an immediate write. */
  const update = useCallback(
    (patch: SettingsPatch, commit = true) => {
      setSettings((s) => (s ? { ...s, ...patch, targets: { ...s.targets, ...(patch.targets ?? {}) } } : s));
      pending.current = {
        ...pending.current,
        ...patch,
        targets: { ...(pending.current.targets ?? {}), ...(patch.targets ?? {}) },
      };
      if (!pending.current.targets || Object.keys(pending.current.targets).length === 0) delete pending.current.targets;
      if (commit) flush();
      else if (timer.current === undefined) timer.current = window.setTimeout(flush, WRITE_THROTTLE_MS);
    },
    [flush],
  );

  // Don't lose the last slider position if the popup closes mid-drag.
  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [flush]);

  return { settings, update, setSettings };
}

export type TabStatus = 'loading' | 'not-youtube' | 'connected' | 'unreachable';

const YOUTUBE = /^https?:\/\/([a-z0-9-]+\.)*youtube\.com\//i;

export function useLiveState() {
  const [status, setStatus] = useState<TabStatus>('loading');
  const [state, setState] = useState<PopupState | null>(null);

  useEffect(() => {
    let port: chrome.runtime.Port | null = null;
    let cancelled = false;
    // `?tab=<id>` targets a specific tab when the popup is opened as a page
    // (used to render store screenshots next to a playing video).
    const forced = Number(new URLSearchParams(location.search).get('tab'));
    const target = forced
      ? chrome.tabs.get(forced).then((t) => [t])
      : chrome.tabs.query({ active: true, currentWindow: true });
    void target.then(([tab]) => {
      if (cancelled) return;
      // tab.url is only visible for hosts we have permission for — i.e. YouTube.
      if (!tab?.id || !tab.url || !YOUTUBE.test(tab.url)) {
        setStatus('not-youtube');
        return;
      }
      try {
        port = chrome.tabs.connect(tab.id, { name: POPUP_PORT });
      } catch {
        setStatus('unreachable');
        return;
      }
      port.onMessage.addListener((msg: PopupState) => {
        if (msg?.type !== 'chroma:state') return;
        setState(msg);
        setStatus('connected');
      });
      port.onDisconnect.addListener(() => {
        // Reading lastError marks it handled (otherwise Chrome logs it). It is
        // set when the tab was open before Chroma was installed/updated.
        void chrome.runtime.lastError;
        setStatus((s) => (s === 'connected' ? s : 'unreachable'));
      });
    });
    return () => {
      cancelled = true;
      port?.disconnect();
    };
  }, []);

  return { status, state };
}

export type Platform = 'mac' | 'other';

export function detectPlatform(): Platform {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = nav.userAgentData?.platform || navigator.platform || '';
  return /mac/i.test(p) ? 'mac' : 'other';
}

/** The shortcut the user actually has bound (they may have changed it), else the platform default. */
export function useShortcut(): string {
  const platform = detectPlatform();
  const fallback = platform === 'mac' ? '⌃⇧C' : 'Alt+Shift+C';
  const [label, setLabel] = useState(fallback);
  useEffect(() => {
    void chrome.commands.getAll().then((cmds) => {
      const cmd = cmds.find((c) => c.name === 'toggle-chroma');
      // An empty shortcut means it was unbound or lost to a conflict.
      setLabel(cmd ? cmd.shortcut || 'Not set' : fallback);
    });
  }, [fallback]);
  return label;
}
