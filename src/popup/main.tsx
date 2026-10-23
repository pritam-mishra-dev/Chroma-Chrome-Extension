import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fromHex, toHex, type RGB } from '../shared/color';
import {
  LIMITS,
  PERFORMANCE_PRESETS,
  defaultPerformanceFor,
  resetSettings,
  type Mode,
  type PerformanceMode,
  type SampleInterval,
  type Settings,
  type Targets,
} from '../shared/settings';
import type { Palette, PopupState } from '../shared/types';
import { Icon, Segmented, Slider, Switch, ToggleRow } from './components';
import { useLiveState, useSettings, useShortcut, type TabStatus } from './hooks';

/** Shown until a YouTube tab reports its palette: Chroma's own violet. */
const BRAND: Palette = {
  vibrant: [140, 108, 255],
  vibrantDark: [84, 52, 196],
  vibrantLight: [196, 182, 255],
  muted: [70, 64, 96],
  dominant: [44, 40, 72],
  onAccent: [255, 255, 255],
};

const SWATCHES: { key: keyof Palette; label: string }[] = [
  { key: 'vibrant', label: 'Accent' },
  { key: 'vibrantDark', label: 'Deep' },
  { key: 'vibrantLight', label: 'Light' },
  { key: 'muted', label: 'Muted' },
  { key: 'dominant', label: 'Base' },
  { key: 'onAccent', label: 'On' },
];

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: 'live', label: 'Live', hint: 'Follows the video scene by scene' },
  { value: 'static', label: 'Static', hint: 'One palette per video, from its thumbnail' },
  { value: 'custom', label: 'Custom', hint: 'Your color, no sampling' },
];

function statusLine(s: Settings, tab: TabStatus, live: PopupState | null): string {
  if (!s.enabled) return 'Paused — YouTube looks stock';
  if (tab === 'not-youtube') return 'Open a YouTube video to theme it';
  if (tab === 'unreachable') return 'Reload the YouTube tab to connect';
  if (!live) return 'Connecting…';
  if (live.forcedColors) return 'High Contrast is on — theming paused';
  if (live.ad) return 'Ad playing — palette frozen';
  if (!live.video) return live.palette ? 'Holding the last palette' : 'No video on this page';
  const where = live.video === 'shorts' ? 'Short' : live.video === 'miniplayer' ? 'miniplayer' : 'video';
  if (live.source === 'thumbnail') return `Colors from this ${where}'s thumbnail`;
  if (live.source === 'custom') return 'Using your custom color';
  if (live.paused) return `Paused ${where} — palette held`;
  return `Sampling this ${where} live`;
}

function App() {
  const { settings, update } = useSettings();
  const { status, state } = useLiveState();
  const shortcut = useShortcut();
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const palette = useMemo<Palette>(() => {
    if (state?.palette) return state.palette;
    if (settings?.mode === 'custom') {
      const rgb = fromHex(settings.customColor);
      if (rgb) return { ...BRAND, vibrant: rgb };
    }
    return BRAND;
  }, [state?.palette, settings?.mode, settings?.customColor]);

  // The popup wears the same palette as the page it controls.
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--accent', toHex(palette.vibrant));
    root.setProperty('--accent-deep', toHex(palette.vibrantDark));
    root.setProperty('--accent-light', toHex(palette.vibrantLight));
    root.setProperty('--muted', toHex(palette.muted));
    root.setProperty('--dominant', toHex(palette.dominant));
    root.setProperty('--on-accent', toHex(palette.onAccent));
  }, [palette]);

  if (!settings) return <div class="card loading" aria-busy="true" />;

  const showToast = (msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1600);
  };

  const copy = async (rgb: RGB) => {
    const hex = toHex(rgb).toUpperCase();
    try {
      await navigator.clipboard.writeText(hex);
      showToast(`Copied ${hex}`);
    } catch {
      showToast(hex);
    }
  };

  const setTarget = (key: keyof Targets) => (v: boolean) => update({ targets: { [key]: v } });
  const perf = settings.performance;
  const tintBlocked = !PERFORMANCE_PRESETS[perf].allowTint;
  const sampleLocked = PERFORMANCE_PRESETS[perf].sampleInterval;

  return (
    <div class={`card ${settings.enabled ? '' : 'is-off'}`}>
      <header class="header">
        <div class="logo" aria-hidden="true" />
        <div class="title">
          <h1>Chroma</h1>
          <p class="status" aria-live="polite">
            {statusLine(settings, status, state)}
          </p>
        </div>
        <Switch checked={settings.enabled} onChange={(v) => update({ enabled: v })} label="Enable Chroma" size="lg" />
      </header>

      <section class="swatches" aria-label="Current palette — click a color to copy it">
        {SWATCHES.map(({ key, label }) => (
          <button
            type="button"
            class="swatch"
            style={{ '--c': toHex(palette[key]) }}
            onClick={() => copy(palette[key])}
            title={`${label} · ${toHex(palette[key]).toUpperCase()} — click to copy`}
          >
            <span class="swatch-chip" />
            <span class="swatch-label">{label}</span>
          </button>
        ))}
      </section>

      <section class="section">
        <Segmented label="Color source" value={settings.mode} options={MODES} onChange={(mode) => update({ mode })} />
        {settings.mode === 'custom' && (
          <label class="custom-color">
            <input
              type="color"
              value={settings.customColor}
              onInput={(e) => update({ customColor: (e.target as HTMLInputElement).value }, false)}
              onChange={(e) => update({ customColor: (e.target as HTMLInputElement).value })}
            />
            <span>Accent color</span>
            <code>{settings.customColor.toUpperCase()}</code>
          </label>
        )}
      </section>

      <section class="section sliders">
        <Slider
          label="Glow intensity"
          value={settings.glowIntensity}
          {...LIMITS.glowIntensity}
          format={(v) => `${Math.round(v)}%`}
          onInput={(v) => update({ glowIntensity: v }, false)}
          onCommit={(v) => update({ glowIntensity: v })}
        />
        <Slider
          label="Transition speed"
          value={settings.transitionMs}
          {...LIMITS.transitionMs}
          format={(v) => (v === 0 ? 'Instant' : `${(v / 1000).toFixed(1)} s`)}
          onInput={(v) => update({ transitionMs: v }, false)}
          onCommit={(v) => update({ transitionMs: v })}
        />
        <Slider
          label="Color sensitivity"
          hint="How different a scene must look (ΔE) before the palette changes. Lower reacts to every cut; higher only to big changes."
          value={LIMITS.sensitivity.max + LIMITS.sensitivity.min - settings.sensitivity}
          {...LIMITS.sensitivity}
          format={(v) => {
            const de = LIMITS.sensitivity.max + LIMITS.sensitivity.min - v;
            return `${de <= 5 ? 'High' : de <= 12 ? 'Medium' : 'Low'} · ΔE ${de}`;
          }}
          // The slider reads "more sensitive" to the right, which is a *lower* ΔE threshold.
          onInput={(v) => update({ sensitivity: LIMITS.sensitivity.max + LIMITS.sensitivity.min - v }, false)}
          onCommit={(v) => update({ sensitivity: LIMITS.sensitivity.max + LIMITS.sensitivity.min - v })}
        />
      </section>

      <section class="section toggles" aria-label="What to recolor">
        <ToggleRow icon={Icon.accents} label="Accents" note="Links, buttons, chips" checked={settings.targets.accents} onChange={setTarget('accents')} />
        <ToggleRow icon={Icon.progress} label="Progress bar" checked={settings.targets.progress} onChange={setTarget('progress')} />
        <ToggleRow icon={Icon.glow} label="Player glow" checked={settings.targets.glow} onChange={setTarget('glow')} />
        <ToggleRow icon={Icon.scrollbar} label="Scrollbar" checked={settings.targets.scrollbar && settings.targets.selection} onChange={(v) => update({ targets: { scrollbar: v, selection: v } })} />
        <ToggleRow
          icon={Icon.tint}
          label="Background tint"
          note={tintBlocked ? 'Off in Battery mode' : undefined}
          disabled={tintBlocked}
          checked={settings.targets.tint && !tintBlocked}
          onChange={setTarget('tint')}
        />
        <ToggleRow icon={Icon.keep} label="Keep off-video" note="Home, search, channels" checked={settings.keepPaletteOffVideo} onChange={(v) => update({ keepPaletteOffVideo: v })} />
      </section>

      <section class="section perf">
        <label class="select">
          <span>Performance</span>
          <select value={perf} onChange={(e) => update({ performance: (e.target as HTMLSelectElement).value as PerformanceMode })}>
            <option value="quality">Quality</option>
            <option value="balanced">Balanced</option>
            <option value="battery">Battery</option>
          </select>
        </label>
        <label class="select">
          <span>Sample every</span>
          <select
            value={sampleLocked ?? settings.sampleInterval}
            disabled={sampleLocked !== null}
            title={sampleLocked !== null ? 'Battery mode samples once a second' : undefined}
            onChange={(e) => update({ sampleInterval: Number((e.target as HTMLSelectElement).value) as SampleInterval })}
          >
            <option value={250}>0.25 s</option>
            <option value={500}>0.5 s</option>
            <option value={1000}>1 s</option>
          </select>
        </label>
      </section>

      <footer class="footer">
        <button type="button" class="link" onClick={() => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })} title="Change keyboard shortcut">
          <kbd>{shortcut}</kbd> toggles
        </button>
        <button
          type="button"
          class="ghost"
          onClick={async () => {
            await resetSettings(defaultPerformanceFor(navigator.hardwareConcurrency));
            showToast('Defaults restored');
          }}
        >
          Reset to defaults
        </button>
      </footer>

      <div class={`toast ${toast ? 'show' : ''}`} role="status" aria-live="polite">
        {Icon.copy}
        {toast}
      </div>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
