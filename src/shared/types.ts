import type { RGB } from './color';

export type Theme = 'dark' | 'light';

export interface Palette {
  vibrant: RGB;
  vibrantDark: RGB;
  vibrantLight: RGB;
  muted: RGB;
  dominant: RGB;
  /** Readable text color on top of `vibrant` (≥ 4.5:1). */
  onAccent: RGB;
}

export const PALETTE_KEYS = ['vibrant', 'vibrantDark', 'vibrantLight', 'muted', 'dominant', 'onAccent'] as const;

/** Where the palette currently on screen came from — shown in the popup. */
export type PaletteSource = 'live' | 'thumbnail' | 'custom' | 'none';

/** Content script → popup, over the long-lived port. */
export interface PopupState {
  type: 'chroma:state';
  palette: Palette | null;
  source: PaletteSource;
  /** Kind of video being themed, or null on pages without one. */
  video: 'watch' | 'shorts' | 'miniplayer' | null;
  paused: boolean;
  ad: boolean;
  forcedColors: boolean;
}
