// Types for format version 1. The JSON Schema (theme-package.v1.schema.json) is the contract;
// these mirror it for code.

export type Mode = 'light' | 'dark';
export const MODES: Mode[] = ['light', 'dark'];
export type ByMode<T> = Record<Mode, T>;
export interface Localized { en: string; ar: string }
export interface Elevation { color: string; offsetX: string; offsetY: string; blur: string; spread: string }

export interface ComponentSection {
  colors?: ByMode<Record<string, string>>;
  style?: Record<string, string>;
  /** Light mode only: replaces the same `style` fields in light mode (dark keeps `style`). */
  lightStyle?: Record<string, string>;
  chrome?: Record<string, string>;
}

/** The lantern street (drawn by the apps' shared street module; the package only switches it on and gives its colours and art). */
export interface StreetSection {
  enabled: boolean;
  /** Tiling SVG of the soft distant lights behind the content. */
  lights: ByMode<string>;
  /** Strings and lantern outlines, #rrggbbaa. */
  line: ByMode<string>;
  /** Lantern windows, #rrggbbaa. */
  window: ByMode<string>;
  /** Opacity of the glow behind each lantern, 0–1. */
  glow: ByMode<number>;
  /**
   * The street itself: wide image tiles (strings and lit lanterns across the full width, drawn at
   * 2x) repeated in both directions behind the whole page; each wraps both ways with no seam. Up to
   * 4 variants per mode, one picked at random per page load (index i is the same street in both modes).
   */
  tile?: ByMode<string[]>;
  /** Opacity of the street where its lanterns lie behind text (every text colour keeps 4.5:1), 0–1. */
  faint?: ByMode<number>;
  /** Opacity of the distant lights layer, 0–1 (default 1). */
  lightsOpacity?: ByMode<number>;
}

export interface ThemePackage {
  $schema?: string;
  format: 'alummahnow.theme-package';
  formatVersion: 1;
  id: string;
  version: string;
  name: Localized;
  description?: Localized;
  author: string;
  kind: 'base' | 'look' | 'event' | 'rebrand' | 'custom';
  basedOn?: string;
  tokens: {
    brand: Record<string, string>;
    color: ByMode<Record<string, string>>;
    radius: Record<string, string>;
    elevation: Record<string, Elevation>;
    borderStyle?: string;
    spacing?: Record<string, number>;
  };
  materials: { radius: Record<string, string>; glow: string; blur: string; hover: string };
  components: Record<string, ComponentSection>;
  typography: {
    pair?: string;
    latin: string[];
    arabic: string[];
    body?: { latin: string[]; arabic: string[] };
    faces?: { family: string; weight: number; style?: 'normal' | 'italic'; src: string }[];
  };
  imagery: Record<string, string | ByMode<string>>;
  signIn?: Record<string, unknown>;
  profile?: Record<string, unknown>;
  browser?: { themeColor: ByMode<string>; manifest: { background: string; theme: string } };
  email?: Record<string, string>;
  banner?: { enabled: boolean; text?: Localized };
  street?: StreetSection;
  [extension: `x-${string}`]: unknown;
}

/** A package with the bytes of its asset files, keyed by path relative to the package root (assets/...). */
export interface PackageFiles { theme: ThemePackage; assets: Record<string, Uint8Array> }
