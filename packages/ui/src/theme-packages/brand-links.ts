// Brand colours drive the theme: a role or component colour written as the same hex as a brand
// colour becomes a {brand.*} reference, so editing that brand swatch repaints everything painted
// with it (the header from night, the page from parchment...). Packages written as plain hex
// copies ignored brand edits: the builder's brand swatches changed nothing in the preview.
import { BRAND_NAMES } from './components.ts';
import { MODES, type ThemePackage } from './types.ts';

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Each colour slot of a package, per mode: [path, value]. */
export function colorSlots(pkg: ThemePackage): [(string)[], string][] {
  const out: [string[], string][] = [];
  for (const mode of MODES) {
    for (const [role, value] of Object.entries(pkg.tokens.color[mode] ?? {})) out.push([['tokens', 'color', mode, role], value]);
    for (const [section, body] of Object.entries(pkg.components ?? {})) {
      for (const [part, value] of Object.entries(body.colors?.[mode] ?? {})) out.push([['components', section, 'colors', mode, part], value]);
    }
  }
  return out;
}

/** The brand colour a hex equals (the first in brand order on a tie), or undefined. */
export function brandFor(pkg: ThemePackage, value: string): string | undefined {
  if (!HEX.test(value)) return undefined;
  const v = value.toLowerCase();
  return BRAND_NAMES.find((n) => pkg.tokens.brand[n]?.toLowerCase() === v);
}

/**
 * A copy whose hex colours that equal a brand colour reference it instead. It compiles to the same
 * CSS; only later brand edits differ, and they now reach every linked colour.
 */
export function linkBrandColors(pkg: ThemePackage): ThemePackage {
  const copy = structuredClone(pkg);
  for (const [path, value] of colorSlots(pkg)) {
    const brand = brandFor(pkg, value);
    if (!brand) continue;
    let at = copy as unknown as Record<string, Record<string, unknown>>;
    for (const key of path.slice(0, -1)) at = at[key] as Record<string, Record<string, unknown>>;
    (at as Record<string, unknown>)[path[path.length - 1]] = `{brand.${brand}}`;
  }
  return copy;
}

/** How many colour slots could be linked to a brand colour but are plain hex. */
export const unlinkedBrandColors = (pkg: ThemePackage) => colorSlots(pkg).filter(([, v]) => brandFor(pkg, v)).length;

/** How many colour slots reference each brand colour. */
export function brandUsage(pkg: ThemePackage): Record<string, number> {
  const out = Object.fromEntries(BRAND_NAMES.map((n) => [n, 0]));
  for (const [, value] of colorSlots(pkg)) {
    const m = /^\{brand\.([a-zA-Z0-9]+)\}$/.exec(value);
    if (m && m[1] in out) out[m[1]]++;
  }
  return out;
}
