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
  chrome?: Record<string, string>;
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
  [extension: `x-${string}`]: unknown;
}

/** A package with the bytes of its asset files, keyed by path relative to the package root (assets/...). */
export interface PackageFiles { theme: ThemePackage; assets: Record<string, Uint8Array> }
