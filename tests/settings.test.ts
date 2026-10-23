import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_VERSION, defaultPerformanceFor, effectiveSampleInterval, migrate } from '../src/shared/settings';

describe('settings', () => {
  it('returns defaults for missing/garbage input', () => {
    expect(migrate(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(migrate('nonsense')).toEqual(DEFAULT_SETTINGS);
  });

  it('migrates unversioned objects and keeps valid fields', () => {
    const s = migrate({ enabled: false, glowIntensity: 30, targets: { tint: true } });
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.enabled).toBe(false);
    expect(s.glowIntensity).toBe(30);
    expect(s.targets.tint).toBe(true);
    expect(s.targets.accents).toBe(true);
  });

  it('clamps and rejects invalid values', () => {
    const s = migrate({ version: 1, glowIntensity: 900, sampleInterval: 333, mode: 'disco', customColor: 'red' });
    expect(s.glowIntensity).toBe(100);
    expect(s.sampleInterval).toBe(500);
    expect(s.mode).toBe('live');
    expect(s.customColor).toBe(DEFAULT_SETTINGS.customColor);
  });

  it('picks battery mode on ≤4 cores and honours reduced motion', () => {
    expect(defaultPerformanceFor(4)).toBe('battery');
    expect(defaultPerformanceFor(8)).toBe('balanced');
    expect(effectiveSampleInterval({ ...DEFAULT_SETTINGS, performance: 'battery' }, false)).toBe(1000);
    expect(effectiveSampleInterval({ ...DEFAULT_SETTINGS, sampleInterval: 250 }, false)).toBe(250);
    expect(effectiveSampleInterval(DEFAULT_SETTINGS, true)).toBe(2000);
  });
});
