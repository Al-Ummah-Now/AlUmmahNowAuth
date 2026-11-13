// Validates a theme package: the JSON Schema, then everything a schema cannot say — references
// resolve, asset files exist and are safe, and every text/background pair meets WCAG AA.
import { BASE } from './base.generated.ts';
import { BRAND_NAMES, COMPONENT_PARTS, MATERIAL_NAMES, get } from './components.ts';
import { resolveColor, resolvedColors } from './compile.ts';
import { contrastRatio } from './contrast.ts';
import { checkSchema } from './json-schema.ts';
import { isKnownKind, parseRefs } from './refs.ts';
import { SCHEMA } from './schema.generated.ts';
import { MODES, type ThemePackage } from './types.ts';

export interface Issue { path: string; message: string }
export interface Validation { ok: boolean; errors: Issue[]; warnings: Issue[] }
export interface ValidateOptions {
  /** The package's files (assets/...). When given, every referenced file must exist and be safe. */
  assets?: Record<string, Uint8Array>;
  /** Built-in packages also hold text on the primary action to 7:1, as the platform themes always have. */
  builtIn?: boolean;
}

export const AA_TEXT = 4.5;
export const AA_NON_TEXT = 3;
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 12 * 1024 * 1024;
const RADIUS_REFS = new Set(['sm', 'md', 'lg', 'xl', 'pill']);
const SPACING_REFS = new Set(BASE.spacing.map((s) => s.name as string));
const PART_NAMES = new Set(BASE.parts.map((p) => p.part as string));
const ROLE_NAMES = new Set(BASE.roles.map((r) => r.name as string));

/** Every string in the package with its dotted path. */
function strings(value: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) strings(v, path ? `${path}.${k}` : k, out);
  return out;
}

export function sniff(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | 'ico' | 'svg' | 'woff2' | 'unknown' {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'ico';
  if (b[0] === 0x77 && b[1] === 0x4f && b[2] === 0x46 && b[3] === 0x32) return 'woff2';
  const head = new TextDecoder().decode(b.subarray(0, 4096));
  return /<svg[\s>]/.test(head) ? 'svg' : 'unknown';
}

/** Why an SVG is unsafe to serve from the site, or undefined. */
export function svgProblem(text: string): string | undefined {
  if (!/<svg[\s>]/.test(text)) return 'is not an SVG';
  if (/<script|<foreignObject|\son[a-z]+\s*=|<!ENTITY/i.test(text)) return 'contains a script or entity';
  if (/(?:href|src)\s*=\s*["'](?!#)|url\(\s*["']?(?!#)/i.test(text)) return 'contains an external reference';
  return undefined;
}

const EXPECTED: Record<string, string[]> = { svg: ['svg'], png: ['png'], jpg: ['jpeg'], jpeg: ['jpeg'], webp: ['webp'], ico: ['ico'], woff2: ['woff2'] };

function checkAssets(pkg: ThemePackage, assets: Record<string, Uint8Array>, errors: Issue[], warnings: Issue[]) {
  const used = new Set<string>();
  for (const [path, value] of strings(pkg, '')) {
    if (/^assets\//.test(value) && !path.startsWith('$')) used.add(value);
    for (const ref of parseRefs(value)) if (ref.kind === 'asset') used.add(ref.name);
    if (/^assets\//.test(value) || value.includes('{asset:')) {
      for (const file of /^assets\//.test(value) ? [value] : parseRefs(value).filter((r) => r.kind === 'asset').map((r) => r.name)) {
        if (!assets[file]) errors.push({ path, message: `names ${file}, which is not in the package` });
      }
    }
  }
  let total = 0;
  for (const [file, bytes] of Object.entries(assets)) {
    total += bytes.byteLength;
    if (!/^assets\/(?!.*\.\.)[A-Za-z0-9_-][A-Za-z0-9._/-]*\.(svg|png|jpg|jpeg|webp|ico|woff2)$/.test(file)) { errors.push({ path: file, message: 'is not an allowed asset name (assets/…, .svg .png .jpg .webp .ico .woff2)' }); continue; }
    if (bytes.byteLength > MAX_ASSET_BYTES) errors.push({ path: file, message: `is ${(bytes.byteLength / 1048576).toFixed(1)} MB; the limit is 2 MB per file` });
    const ext = file.split('.').pop()!.toLowerCase();
    const kind = sniff(bytes);
    if (!EXPECTED[ext]?.includes(kind)) errors.push({ path: file, message: `is not a real .${ext} file` });
    if (kind === 'svg') {
      const problem = svgProblem(new TextDecoder().decode(bytes));
      if (problem) errors.push({ path: file, message: problem });
    }
    if (!used.has(file)) warnings.push({ path: file, message: 'is not used by theme.json' });
  }
  if (total > MAX_PACKAGE_BYTES) errors.push({ path: 'assets', message: `total ${(total / 1048576).toFixed(1)} MB; the limit is 12 MB` });
}

function checkRefs(pkg: ThemePackage, errors: Issue[]) {
  for (const [path, value] of strings(pkg, '')) {
    for (const ref of parseRefs(value)) {
      if (!isKnownKind(ref.kind)) { errors.push({ path, message: `${ref.raw} is not a known reference` }); continue; }
      const bad = (what: string) => errors.push({ path, message: `${ref.raw} names an unknown ${what}` });
      if (ref.kind === 'color' && !ROLE_NAMES.has(ref.name)) bad('colour role');
      if (ref.kind === 'brand' && !BRAND_NAMES.includes(ref.name)) bad('brand colour');
      if (ref.kind === 'component' && !PART_NAMES.has(ref.name)) bad('component colour');
      if (ref.kind === 'material' && !MATERIAL_NAMES.has(ref.name)) bad('material');
      if (ref.kind === 'radius' && !RADIUS_REFS.has(ref.name)) bad('radius');
      if (ref.kind === 'spacing' && !SPACING_REFS.has(ref.name)) bad('spacing step');
    }
  }
}

/** Text and controls against what they sit on, in both modes. */
export function contrastIssues(pkg: ThemePackage, builtIn = false): Issue[] {
  const issues: Issue[] = [];
  const colors = resolvedColors(pkg);
  for (const mode of MODES) {
    const roles = colors[mode].roles;
    const surfaces = BASE.roles.filter((r) => r.role === 'surface');
    for (const r of BASE.roles) {
      const pairs: [string, number][] =
        r.role === 'text' ? surfaces.map((s) => [s.name, AA_TEXT]) :
        r.role === 'nontext' ? surfaces.map((s) => [s.name, AA_NON_TEXT]) :
        r.role === 'on' && 'on' in r ? [[r.on as string, builtIn && /^onPrimary(Hover|Pressed)?$/.test(r.name) ? 7 : AA_TEXT]] : [];
      for (const [bg, min] of pairs) {
        const ratio = contrastRatio(roles[r.name], roles[bg]);
        if (ratio < min) issues.push({ path: `tokens.color.${mode}.${r.name}`, message: `${roles[r.name]} on ${bg} ${roles[bg]} is ${ratio.toFixed(2)}:1, needs ${min}:1 (WCAG AA)` });
      }
    }
    // The header is dark in every theme and both modes (owner decision, 2026-11-11), as on the site
    const header = colors[mode].parts['nav.bg'];
    const headerRatio = contrastRatio('#ffffff', header);
    if (headerRatio < AA_TEXT) issues.push({ path: `components.header.colors.${mode}.bg`, message: `the header is dark in every theme: ${header} is ${headerRatio.toFixed(2)}:1 against white, needs ${AA_TEXT}:1` });
    for (const [fg, bg, min] of BASE.componentPairs) {
      const ratio = contrastRatio(colors[mode].parts[fg], colors[mode].parts[bg]);
      if (ratio < min) issues.push({ path: `components.${sectionOf(fg)}.colors.${mode}.${fg.slice(fg.lastIndexOf('.') + 1)}`, message: `${fg} ${colors[mode].parts[fg]} on ${bg} ${colors[mode].parts[bg]} is ${ratio.toFixed(2)}:1, needs ${min}:1 (WCAG AA)` });
    }
  }
  return issues;
}

/**
 * Backgrounds the apps paint as `background: var(--m-…) padding-box, var(--m-border) border-box`
 * (cards, menus, the hero). A colour may only be the last layer of a `background`, so a colour
 * there makes the whole declaration invalid and the surface see-through (#937). Write a flat
 * colour as `linear-gradient(<colour>,<colour>)`.
 */
export const LAYERED_BACKGROUNDS = ['components.card.style.background', 'components.menu.style.background', 'components.hero.style.background',
  'components.card.lightStyle.background', 'components.menu.lightStyle.background', 'components.hero.lightStyle.background'];

/** Top-level comma-separated layers of a CSS value. */
export function cssLayers(value: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { layers.push(value.slice(start, i).trim()); start = i + 1; }
  }
  layers.push(value.slice(start).trim());
  return layers;
}

const IMAGE_LAYER = /^(none|(repeating-)?(linear|radial|conic)-gradient\(|url\(|image-set\(|\{material\.)/i;

function checkLayeredBackgrounds(pkg: ThemePackage, errors: Issue[]) {
  for (const path of LAYERED_BACKGROUNDS) {
    const value = get(pkg, path);
    if (typeof value !== 'string') continue;
    const bad = cssLayers(value).find((layer) => !IMAGE_LAYER.test(layer));
    if (bad) errors.push({ path, message: `has a colour layer (${bad.slice(0, 60)}); the apps add more layers after it, so write it as linear-gradient(<colour>,<colour>)` });
  }
}

export function sectionOf(part: string): string {
  const group = part.slice(0, part.lastIndexOf('.'));
  return Object.entries(COMPONENT_PARTS).find(([, g]) => g === group)?.[0] ?? group;
}

export function validatePackage(input: unknown, opts: ValidateOptions = {}): Validation {
  const errors: Issue[] = checkSchema(input, SCHEMA);
  const warnings: Issue[] = [];
  if (errors.length) return { ok: false, errors, warnings };
  const pkg = input as ThemePackage;
  checkRefs(pkg, errors);
  for (const mode of MODES) {
    for (const role of ROLE_NAMES) {
      try { void resolvedColorsOne(pkg, mode, role); } catch (e) { errors.push({ path: `tokens.color.${mode}.${role}`, message: (e as Error).message }); }
    }
  }
  if (opts.assets) checkAssets(pkg, opts.assets, errors, warnings);
  if (!errors.length) {
    try { errors.push(...contrastIssues(pkg, opts.builtIn)); } catch (e) { errors.push({ path: 'tokens.color', message: (e as Error).message }); }
  }
  checkLayeredBackgrounds(pkg, errors);
  if (get(pkg, 'banner.enabled') && !pkg.banner?.text) errors.push({ path: 'banner.text', message: 'is needed when the banner is on (both languages)' });
  return { ok: errors.length === 0, errors, warnings };
}

const resolvedColorsOne = (pkg: ThemePackage, mode: 'light' | 'dark', role: string) => resolveColor(pkg, mode, pkg.tokens.color[mode][role]);
