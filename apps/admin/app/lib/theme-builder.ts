/**
 * The theme builder's helpers (browser and server): reading and writing
 * theme.json paths, colour swatches, fonts, and gradient / shadow values.
 */
import { resolveColor } from '../../../../packages/ui/src/theme-packages/compile.ts';
import { SPEC_SLOTS } from '../../../../packages/ui/src/auth-theme/catalog.ts';
import type { AuthThemeJson, SchemeValue } from '../../../../packages/ui/src/auth-theme/types.ts';

export type Mode = 'light' | 'dark';

export interface Swatches {
  light: { background: string; card: string; primary: string; text: string; input: string };
  dark: { background: string; card: string; primary: string; text: string; input: string };
}

/** The colours a theme card shows: page, card, primary, text and field, per mode. */
export function swatchesOf(theme: AuthThemeJson): Swatches | null {
  try {
    const of = (mode: Mode) => {
      const role = (name: string) => resolveColor(theme, mode, theme.tokens.color[mode][name]);
      const part = (section: string, name: string, fallback: string) => {
        const v = theme.components?.[section]?.colors?.[mode]?.[name];
        return v ? resolveColor(theme, mode, v) : fallback;
      };
      return {
        background: role('background'),
        card: part('input', 'sectionBg', role('surface')),
        primary: role('primary'),
        text: role('textPrimary'),
        input: part('input', 'inputBg', role('background')),
      };
    };
    return { light: of('light'), dark: of('dark') };
  } catch {
    return null;
  }
}

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((n, k) => (n && typeof n === 'object' ? (n as Record<string, unknown>)[k] : undefined), obj);
}

/** A copy of `obj` with `path` set (undefined removes it; emptied objects are removed too). */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const root = structuredClone(obj) as Record<string, unknown>;
  const stack: Record<string, unknown>[] = [root];
  let node = root;
  for (const k of keys.slice(0, -1)) {
    if (!node[k] || typeof node[k] !== 'object') node[k] = {};
    node = node[k] as Record<string, unknown>;
    stack.push(node);
  }
  const last = keys[keys.length - 1];
  if (value === undefined) {
    delete node[last];
    for (let i = keys.length - 2; i >= 0; i--) {
      const parent = stack[i];
      const child = parent[keys[i]] as Record<string, unknown>;
      if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0) delete parent[keys[i]];
      else break;
    }
  } else node[last] = value;
  return root as T;
}

/** Fonts the builder offers. `google` names a Google Fonts family (loaded on the sign-in pages). */
export interface FontChoice {
  label: string;
  stack: string[];
  google?: string;
  arabic: boolean;
}

export const FONT_CHOICES: FontChoice[] = [
  { label: 'System', stack: ['system-ui', 'sans-serif'], arabic: true },
  { label: 'Cairo', stack: ['Cairo', 'sans-serif'], google: 'Cairo:wght@400;500;600;700', arabic: true },
  { label: 'Tajawal', stack: ['Tajawal', 'sans-serif'], google: 'Tajawal:wght@400;500;700', arabic: true },
  { label: 'Noto Kufi Arabic', stack: ['Noto Kufi Arabic', 'sans-serif'], google: 'Noto+Kufi+Arabic:wght@400;500;600;700', arabic: true },
  { label: 'IBM Plex Sans Arabic', stack: ['IBM Plex Sans Arabic', 'sans-serif'], google: 'IBM+Plex+Sans+Arabic:wght@400;500;600;700', arabic: true },
  { label: 'Almarai', stack: ['Almarai', 'sans-serif'], google: 'Almarai:wght@400;700', arabic: true },
  { label: 'Amiri', stack: ['Amiri', 'serif'], google: 'Amiri:wght@400;700', arabic: true },
  { label: 'Reem Kufi', stack: ['Reem Kufi', 'sans-serif'], google: 'Reem+Kufi:wght@400;500;600;700', arabic: true },
  { label: 'Inter', stack: ['Inter', 'sans-serif'], google: 'Inter:wght@400;500;600;700', arabic: false },
  { label: 'Source Serif 4', stack: ['Source Serif 4', 'serif'], google: 'Source+Serif+4:wght@400;600;700', arabic: false },
];

export const fontChoiceOf = (stack: string[] | undefined) => FONT_CHOICES.find((f) => stack && f.stack[0] === stack[0]);

/** The Google Fonts stylesheet for the chosen families (undefined when none need loading). */
export function googleFontsUrl(choices: (FontChoice | undefined)[]): string | undefined {
  const families = [...new Set(choices.filter((c): c is FontChoice => !!c?.google).map((c) => c.google!))];
  return families.length ? `https://fonts.googleapis.com/css2?${families.map((f) => `family=${f}`).join('&')}&display=swap` : undefined;
}

export interface Gradient {
  angle: number;
  stops: { color: string; at: number }[];
}

export const gradientCss = (g: Gradient) => `linear-gradient(${g.angle}deg,${g.stops.map((s) => `${s.color} ${s.at}%`).join(',')})`;

/** Reads back a gradient the builder wrote; undefined for anything else. */
export function parseGradient(value: string | undefined): Gradient | undefined {
  const m = value && /^linear-gradient\((-?\d+)deg,(.+)\)$/.exec(value.trim());
  if (!m) return undefined;
  const stops = m[2].split(',').map((s) => /^\s*(#[0-9a-fA-F]{6}|\{[a-z]+\.[a-zA-Z.]+\})\s+(\d+)%\s*$/.exec(s));
  if (stops.some((s) => !s)) return undefined;
  return { angle: Number(m[1]), stops: stops.map((s) => ({ color: s![1], at: Number(s![2]) })) };
}

export interface Shadow {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
  alpha: number;
}

export function shadowCss(s: Shadow): string {
  const rgb = [1, 3, 5].map((i) => parseInt(s.color.slice(i, i + 2), 16)).join(' ');
  return `${s.x}px ${s.y}px ${s.blur}px ${s.spread}px rgb(${rgb} / ${s.alpha})`;
}

export function parseShadow(value: string | undefined): Shadow | undefined {
  const m = value && /^(-?\d+)px (-?\d+)px (\d+)px (-?\d+)px rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(value.trim());
  if (!m) return undefined;
  const hex = [m[5], m[6], m[7]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  return { x: +m[1], y: +m[2], blur: +m[3], spread: +m[4], color: `#${hex}`, alpha: +m[8] };
}

export const HEX = /^#[0-9a-f]{6}$/;

/** A colour slot's value shown in a colour picker: its resolved hex. */
export function pickerHex(theme: AuthThemeJson, mode: Mode, value: string | undefined): string {
  if (!value) return '#000000';
  try {
    const hex = resolveColor(theme, mode, value);
    return HEX.test(hex) ? hex : '#000000';
  } catch {
    return '#000000';
  }
}

// ---- theme.json places the builder edits

export function sectionPath(sectionId: string, key: string): string | null {
  return sectionId === "base" && SPEC_SLOTS[key] ? SPEC_SLOTS[key] : null;
}

export function getSlot(theme: AuthThemeJson, sectionId: string, key: string): SchemeValue | undefined {
  const spec = sectionPath(sectionId, key);
  if (spec) return getPath(theme, spec) as SchemeValue | undefined;
  return theme["x-auth"]?.sections?.[sectionId]?.[key];
}

export function setSlot(theme: AuthThemeJson, sectionId: string, key: string, value: SchemeValue | undefined): AuthThemeJson {
  const spec = sectionPath(sectionId, key);
  if (spec) {
    // signIn.background is per mode in the format; the card fields are one value
    if (spec === "signIn.background" && typeof value === "string") value = { light: value, dark: value };
    if (spec !== "signIn.background" && value && typeof value === "object") value = value.light;
    return setPath(theme, spec, value);
  }
  const next = structuredClone(theme);
  const ext = (next["x-auth"] ??= {});
  const sections = (ext.sections ??= {});
  const section = (sections[sectionId] ??= {});
  if (value === undefined || value === "") delete section[key];
  else section[key] = value;
  if (!Object.keys(section).length) delete sections[sectionId];
  return next;
}

/** The theme with an uploaded file put in the place it was uploaded for. */
export function withUpload(theme: AuthThemeJson, target: string, path: string): AuthThemeJson {
  switch (target) {
    case "logo":
      return setPath(theme, "imagery.logo", { light: path, dark: path });
    case "favicon":
      return setPath(theme, "imagery.favicon", path);
    case "headerGraphic":
      return setPath(theme, "imagery.headerGraphic", { light: path, dark: path });
    case "photo":
      return setPath(theme, "x-auth.photos.light", [...(theme["x-auth"]?.photos?.light ?? []), path]);
    case "emailHeader":
      return setPath(theme, "email.headerImage", path);
    default:
      return theme;
  }
}
