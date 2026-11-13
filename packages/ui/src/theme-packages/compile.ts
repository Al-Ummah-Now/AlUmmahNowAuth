// Compiles a theme package to the CSS the apps read: design tokens (--fanous-*), materials
// (--r-*, --m-*), body fonts and player chrome (--fanous-player-*), all scoped to
// html[data-theme='<id>'] so several themes can share one stylesheet.
import { BASE } from './base.generated.ts';
import { BRAND_NAMES, COMPONENT_PARTS, ELEVATION_NAMES, MATERIAL_VARS, OPTIONAL_MATERIAL_VARS, PLAYER_SHARED, PLAYER_TOKENS, RADIUS_NAMES, get } from './components.ts';
import { kebab, toCss } from './refs.ts';
import { MODES, type Mode, type ThemePackage } from './types.ts';

export interface CompileOptions {
  /** URL for an asset path such as assets/pattern.svg. Defaults to the path itself. */
  assetUrl?: (path: string) => string;
  /** The platform default theme: also styles a page whose <html> has no data-theme. */
  isDefault?: boolean;
  /**
   * Built-in themes keep the `:root` fallback the shared stylesheet has always had, so the
   * generated file is unchanged. Packages served on their own leave it out.
   */
  rootFallback?: boolean;
  /**
   * Inline form of an asset (a data: URL) for values that must work wherever the stylesheet is
   * copied (the street's lights in the built-in stylesheet, which www and the CMS vendor).
   * Falls back to assetUrl.
   */
  inlineAsset?: (path: string) => string | undefined;
}

export interface CompiledTheme { tokens: string; materials: string; fonts: string; player: string; css: string }

export const scopeOf = (id: string) => `html[data-theme='${id}']`;

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong']);
/** Token stacks quote only names with spaces, as the platform tokens always have. */
const tokenStack = (families: readonly string[]) => families.map((f) => (/\s/.test(f) ? `'${f}'` : f)).join(', ');
/** Body stacks quote every family name and leave generic families bare. */
const bodyStack = (families: readonly string[]) => families.map((f) => (GENERIC.has(f) ? f : `'${f}'`)).join(',');
const num = (px: string) => String(Number(px.replace(/px$/, '')));

/** Resolves {color.*} and {brand.*} in a colour slot to #rrggbb. Throws on an unknown name or a cycle. */
export function resolveColor(pkg: ThemePackage, mode: Mode, value: string, seen: string[] = []): string {
  const m = /^\{(color|brand)\.([a-zA-Z0-9]+)\}$/.exec(value);
  if (!m) return value.toLowerCase();
  if (m[1] === 'brand') {
    const brand = pkg.tokens.brand[m[2]];
    if (!brand) throw new Error(`unknown brand colour ${m[2]}`);
    return brand.toLowerCase();
  }
  if (seen.includes(m[2])) throw new Error(`colour references loop: ${[...seen, m[2]].join(' -> ')}`);
  const next = pkg.tokens.color[mode][m[2]];
  if (next === undefined) throw new Error(`unknown colour role ${m[2]}`);
  return resolveColor(pkg, mode, next, [...seen, m[2]]);
}

/** Every role and component part, per mode, as #rrggbb. */
export function resolvedColors(pkg: ThemePackage) {
  const out = {} as Record<Mode, { roles: Record<string, string>; parts: Record<string, string> }>;
  for (const mode of MODES) {
    const roles = Object.fromEntries(BASE.roles.map((r) => [r.name, resolveColor(pkg, mode, pkg.tokens.color[mode][r.name])]));
    const parts = Object.fromEntries(BASE.parts.map(({ part }) => {
      const dot = part.lastIndexOf('.');
      const section = Object.entries(PART_SECTIONS).find(([, group]) => group === part.slice(0, dot))?.[0];
      const value = section ? pkg.components[section]?.colors?.[mode]?.[part.slice(dot + 1)] : undefined;
      if (value === undefined) throw new Error(`component colour ${part} is missing`);
      return [part, resolveColor(pkg, mode, value)];
    }));
    out[mode] = { roles, parts };
  }
  return out;
}

const PART_SECTIONS = Object.fromEntries(Object.entries(COMPONENT_PARTS).filter(([, g]) => g !== null)) as Record<string, string>;

function tokensCss(pkg: ThemePackage, opts: CompileOptions): string {
  const scope = scopeOf(pkg.id);
  const top = opts.isDefault ? `:root, ${scope}` : scope;
  const dark = opts.isDefault ? `.dark, ${scope}.dark` : `${scope}.dark`;
  const light = opts.isDefault ? `html:not(.dark), ${scope}:not(.dark)` : `${scope}:not(.dark)`;
  const colors = resolvedColors(pkg);
  const px = (prefix: string, items: readonly { name: string; value: number }[]) => items.map((i) => `  --fanous-${prefix}-${kebab(i.name)}: ${i.value}px;`).join('\n');
  const type = (script: string, styles: readonly { name: string; size: number; weight: number; lineHeight: number; letterSpacing: number }[]) => styles.map((s) => {
    const base = `--fanous-type-${script}-${kebab(s.name)}`;
    return `  ${base}-size: ${s.size}px;\n  ${base}-weight: ${s.weight};\n  ${base}-line-height: ${s.lineHeight};\n  ${base}-letter-spacing: ${s.letterSpacing}px;`;
  }).join('\n');
  const spacing = BASE.spacing.map((s) => ({ name: s.name, value: pkg.tokens.spacing?.[s.name] ?? s.value }));
  const elevation = ELEVATION_NAMES.map((name) => {
    const e = pkg.tokens.elevation[name];
    const c = e.color.toLowerCase();
    const rgb = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)).join(' ');
    const alpha = c.length === 9 ? Math.round((parseInt(c.slice(7), 16) / 255) * 100) / 100 : 1;
    return `  --fanous-elevation-${name}: ${num(e.offsetX)}px ${num(e.offsetY)}px ${num(e.blur)}px ${num(e.spread)}px rgb(${rgb} / ${alpha});`;
  });
  const modeBlock = (mode: Mode) => [
    ...BASE.roles.map((r) => `  --fanous-color-${kebab(r.name)}: ${colors[mode].roles[r.name]};`),
    ...BASE.parts.map(({ part }) => `  --fanous-c-${part.split('.').map(kebab).join('-')}: ${colors[mode].parts[part]};`),
    ...streetTokens(pkg, mode, opts),
  ].join('\n');
  return `/* Theme package ${pkg.id}@${pkg.version}. Generated, do not edit. */
${top} {
${BRAND_NAMES.map((n) => `  --fanous-brand-${kebab(n)}: ${pkg.tokens.brand[n].toLowerCase()};`).join('\n')}
  --fanous-font-latin: ${tokenStack(pkg.typography.latin)};
  --fanous-font-arabic: ${tokenStack(pkg.typography.arabic)};
${BASE.fontPairs.flatMap((p) => [`  --fanous-font-${kebab(p.name)}-latin: ${tokenStack(p.latin)};`, `  --fanous-font-${kebab(p.name)}-arabic: ${tokenStack(p.arabic)};`]).join('\n')}
${type('latin', BASE.typography.latin)}
${type('arabic', BASE.typography.arabic)}
${px('spacing', spacing)}
${RADIUS_NAMES.map((n) => `  --fanous-radius-${n}: ${num(pkg.tokens.radius[n])}px;`).join('\n')}
${elevation.join('\n')}
${BASE.duration.map((d) => `  --fanous-duration-${kebab(d.name)}: ${d.value}ms;`).join('\n')}
${BASE.easing.map((e) => `  --fanous-easing-${kebab(e.name)}: cubic-bezier(${e.value.join(', ')});`).join('\n')}
${px('focus', BASE.focus)}
${px('tv', BASE.tv)}
${px('layout', BASE.layout)}
}

@media (prefers-reduced-motion: reduce) {
  ${opts.rootFallback ? ':root' : top} {
${BASE.duration.filter((d) => d.name !== 'instant').map((d) => `    --fanous-duration-${kebab(d.name)}: 0ms;`).join('\n')}
  }
}

/* Dark (night) is the default theme. */
${opts.rootFallback ? ':root,\n' : ''}${dark} {
${modeBlock('dark')}
}

${light} {
${modeBlock('light')}
}
`;
}

/**
 * The street's tokens for one mode. The shared street module reads them: --fanous-street-on 1
 * switches it on; a theme without a street sets 0.
 */
function streetTokens(pkg: ThemePackage, mode: Mode, opts: CompileOptions): string[] {
  const street = pkg.street;
  // Off, explicitly: the default theme's blocks also match unthemed selectors (html:not(.dark), .dark)
  if (!street) return ['  --fanous-street-on: 0;'];
  const lights = opts.inlineAsset?.(street.lights[mode]) ?? (opts.assetUrl ?? ((p: string) => p))(street.lights[mode]);
  return [
    `  --fanous-street-on: ${street.enabled ? 1 : 0};`,
    `  --fanous-street-line: ${street.line[mode].toLowerCase()};`,
    `  --fanous-street-window: ${street.window[mode].toLowerCase()};`,
    `  --fanous-street-glow: ${street.glow[mode]};`,
    `  --fanous-street-lights: url("${lights}");`,
  ];
}

/** `components.<name>.lightStyle.<field>` for a `components.<name>.style.<field>` path. */
export const lightPath = (path: string) => path.replace('.style.', '.lightStyle.');

function materialsCss(pkg: ThemePackage, assetUrl: (p: string) => string): string {
  const decls = MATERIAL_VARS.map(([path, prop]) => `${prop}:${toCss(String(get(pkg, path)), assetUrl)}`);
  for (const [path, prop] of OPTIONAL_MATERIAL_VARS) {
    const value = get(pkg, path);
    if (value !== undefined && value !== '') decls.push(`${prop}:${toCss(String(value), assetUrl)}`);
  }
  // Light-only styles: the same properties again for light mode (the videos app marks dark with html.dark)
  const light: string[] = [];
  for (const [path, prop] of [...MATERIAL_VARS, ...OPTIONAL_MATERIAL_VARS]) {
    if (!path.startsWith('components.')) continue;
    const value = get(pkg, lightPath(path));
    if (value !== undefined && value !== '') light.push(`${prop}:${toCss(String(value), assetUrl)}`);
  }
  const scope = scopeOf(pkg.id);
  return `${scope}{${decls.join(';')}}\n${light.length ? `${scope}:not(.dark){${light.join(';')}}\n` : ''}`;
}

const BODY_TARGETS = ['body', 'body button', 'body input', 'body textarea', 'body select', 'body .font-inter'];

function fontsCss(pkg: ThemePackage, assetUrl: (p: string) => string): string {
  const scope = scopeOf(pkg.id);
  const faces = (pkg.typography.faces ?? []).map((f) => `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-style:${f.style ?? 'normal'};font-display:swap;src:${toCss(`{asset:${f.src}}`, assetUrl)} format('woff2')}\n`).join('');
  const body = pkg.typography.body;
  if (!body) return faces;
  const rule = (sel: string, stack: string[]) => `${BODY_TARGETS.map((t) => `${sel} ${t}`).join(',')}{font-family:${bodyStack(stack)}}`;
  return `${faces}${rule(scope, body.latin)}\n${rule(`${scope}[lang=ar]`, body.arabic)}\n`;
}

function playerCss(pkg: ThemePackage, assetUrl: (p: string) => string): string {
  const chrome = pkg.components.player.chrome ?? {};
  const lines = [
    // An absent optional field (bar-pad-compact) is left out; the skin falls back to bar-pad
    ...PLAYER_TOKENS.filter((name) => chrome[name] !== undefined && chrome[name] !== '').map((name) => `  --fanous-player-${name}: ${toCss(String(chrome[name]), assetUrl)};`),
    ...Object.entries(PLAYER_SHARED).map(([name, value]) => `  --fanous-player-${name}: ${value};`),
  ];
  return `${scopeOf(pkg.id)} {\n${lines.join('\n')}\n}\n`;
}

/** The package's CSS. Validate first: compiling an invalid package throws or emits broken CSS. */
export function compilePackage(pkg: ThemePackage, opts: CompileOptions = {}): CompiledTheme {
  const assetUrl = opts.assetUrl ?? ((p: string) => p);
  const tokens = tokensCss(pkg, opts);
  const materials = materialsCss(pkg, assetUrl);
  const fonts = fontsCss(pkg, assetUrl);
  const player = playerCss(pkg, assetUrl);
  return { tokens, materials, fonts, player, css: [tokens, fonts, materials, player].join('\n') };
}
