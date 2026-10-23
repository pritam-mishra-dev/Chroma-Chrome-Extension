// Typed settings schema, defaults, migrations and chrome.storage.sync helpers.
//
// Everything that reads settings goes through `sanitize()`, so a value that
// was hand-edited, written by an older build or truncated by sync can never
// put the content script into an impossible state.

export const SETTINGS_KEY = 'chroma.settings';
export const SETTINGS_VERSION = 1;

export type Mode = 'live' | 'static' | 'custom';
export type PerformanceMode = 'quality' | 'balanced' | 'battery';
export type SampleInterval = 250 | 500 | 1000;

export interface Targets {
  accents: boolean;
  progress: boolean;
  glow: boolean;
  scrollbar: boolean;
  tint: boolean;
  selection: boolean;
}

export interface Settings {
  version: number;
  enabled: boolean;
  mode: Mode;
  /** Hex color used in Custom mode. */
  customColor: string;
  sampleInterval: SampleInterval;
  /** Palette cross-fade duration. */
  transitionMs: number;
  /** 0–100. */
  glowIntensity: number;
  /** ΔE OK threshold a new palette must exceed before it replaces the current one. */
  sensitivity: number;
  targets: Targets;
  keepPaletteOffVideo: boolean;
  performance: PerformanceMode;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  version: SETTINGS_VERSION,
  enabled: true,
  mode: 'live',
  customColor: '#7c5cff',
  sampleInterval: 500,
  transitionMs: 1200,
  glowIntensity: 60,
  sensitivity: 8,
  targets: Object.freeze({
    accents: true,
    progress: true,
    glow: true,
    scrollbar: true,
    tint: false,
    selection: true,
  }),
  keepPaletteOffVideo: false,
  performance: 'balanced',
}) as Settings;

export const LIMITS = {
  transitionMs: { min: 0, max: 3000, step: 100 },
  glowIntensity: { min: 0, max: 100, step: 1 },
  sensitivity: { min: 2, max: 30, step: 1 },
} as const;

export interface PerformancePreset {
  glowBlurPx: number;
  /** Forced sample interval, or null to use the user's choice. */
  sampleInterval: SampleInterval | null;
  allowTint: boolean;
}

// Large blurred box-shadows are the single most expensive thing we paint;
// integrated Windows GPUs start dropping frames somewhere past ~100px.
export const PERFORMANCE_PRESETS: Record<PerformanceMode, PerformancePreset> = {
  // Quality samples at the user's rate (500 ms by default) rather than forcing
  // 500, so someone who picks 250 ms isn't silently overridden.
  quality: { glowBlurPx: 120, sampleInterval: null, allowTint: true },
  balanced: { glowBlurPx: 80, sampleInterval: null, allowTint: true },
  battery: { glowBlurPx: 40, sampleInterval: 1000, allowTint: false },
};

export const REDUCED_MOTION_SAMPLE_MS = 2000;

export function effectiveSampleInterval(s: Settings, reducedMotion: boolean): number {
  if (reducedMotion) return REDUCED_MOTION_SAMPLE_MS;
  return PERFORMANCE_PRESETS[s.performance].sampleInterval ?? s.sampleInterval;
}

/** Hardware-based default, decided once at install time by the service worker. */
export function defaultPerformanceFor(hardwareConcurrency: number | undefined): PerformanceMode {
  return hardwareConcurrency !== undefined && hardwareConcurrency <= 4 ? 'battery' : 'balanced';
}

// ---------------------------------------------------------------------------
// Migrations: MIGRATIONS[n] upgrades a version-n object to version n+1.
// Version 0 is "anything without a version field" (pre-release builds).
// Add a new entry and bump SETTINGS_VERSION when the schema changes.
// ---------------------------------------------------------------------------
type Loose = Record<string, unknown>;
const MIGRATIONS: Record<number, (s: Loose) => Loose> = {
  0: (s) => ({ ...s, version: 1 }),
};

export function migrate(raw: unknown): Settings {
  let s: Loose = raw && typeof raw === 'object' ? { ...(raw as Loose) } : {};
  let v = typeof s.version === 'number' ? s.version : 0;
  while (v < SETTINGS_VERSION) {
    const step = MIGRATIONS[v];
    s = step ? step(s) : { ...s, version: v + 1 };
    v = s.version as number;
  }
  return sanitize(s);
}

function bool(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d;
}

function num(v: unknown, d: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
}

function oneOf<T>(v: unknown, options: readonly T[], d: T): T {
  return options.includes(v as T) ? (v as T) : d;
}

export function sanitize(raw: Loose): Settings {
  const d = DEFAULT_SETTINGS;
  const t = (raw.targets && typeof raw.targets === 'object' ? raw.targets : {}) as Loose;
  const hex = typeof raw.customColor === 'string' && /^#[0-9a-f]{6}$/i.test(raw.customColor);
  return {
    version: SETTINGS_VERSION,
    enabled: bool(raw.enabled, d.enabled),
    mode: oneOf(raw.mode, ['live', 'static', 'custom'] as const, d.mode),
    customColor: hex ? (raw.customColor as string).toLowerCase() : d.customColor,
    sampleInterval: oneOf(raw.sampleInterval, [250, 500, 1000] as const, d.sampleInterval),
    transitionMs: num(raw.transitionMs, d.transitionMs, LIMITS.transitionMs.min, LIMITS.transitionMs.max),
    glowIntensity: num(raw.glowIntensity, d.glowIntensity, 0, 100),
    sensitivity: num(raw.sensitivity, d.sensitivity, LIMITS.sensitivity.min, LIMITS.sensitivity.max),
    targets: {
      accents: bool(t.accents, d.targets.accents),
      progress: bool(t.progress, d.targets.progress),
      glow: bool(t.glow, d.targets.glow),
      scrollbar: bool(t.scrollbar, d.targets.scrollbar),
      tint: bool(t.tint, d.targets.tint),
      selection: bool(t.selection, d.targets.selection),
    },
    keepPaletteOffVideo: bool(raw.keepPaletteOffVideo, d.keepPaletteOffVideo),
    performance: oneOf(raw.performance, ['quality', 'balanced', 'battery'] as const, d.performance),
  };
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

export async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.sync.get(SETTINGS_KEY);
  return migrate(got[SETTINGS_KEY]);
}

export type SettingsPatch = Partial<Omit<Settings, 'targets' | 'version'>> & { targets?: Partial<Targets> };

/** Read-modify-write so concurrent popups/commands only clobber the fields they touch. */
export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const current = await loadSettings();
  const next = sanitize({
    ...current,
    ...patch,
    targets: { ...current.targets, ...(patch.targets ?? {}) },
  } as unknown as Loose);
  await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function resetSettings(keepPerformance?: PerformanceMode): Promise<Settings> {
  const next: Settings = {
    ...DEFAULT_SETTINGS,
    targets: { ...DEFAULT_SETTINGS.targets },
    performance: keepPerformance ?? DEFAULT_SETTINGS.performance,
  };
  await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Returns an unsubscribe function. */
export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'sync' || !(SETTINGS_KEY in changes)) return;
    cb(migrate(changes[SETTINGS_KEY]!.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => {
    try {
      chrome.storage.onChanged.removeListener(listener);
    } catch {
      // Context already invalidated — nothing left to unsubscribe from.
    }
  };
}
