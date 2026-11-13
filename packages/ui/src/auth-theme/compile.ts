/**
 * Compiles an Auth theme (a format v1 package with the x-auth extension) into
 * what Auth's pages use: OpenAuth's per-request theme (colours, logo, title,
 * font, CSS), the header graphic, the token CSS the profile and admin apps
 * link, and the account switcher's rules.
 *
 * Auth's pages follow the device's colour scheme, so tokens are emitted per
 * prefers-color-scheme (the platform's own compiler keys them on `.dark`). That
 * includes the lantern street's tokens (--fanous-street-*, read by the shared
 * street module) and the components' light-only styles (`lightStyle`).
 */
import { BASE } from '../theme-packages/base.generated.ts';
import { BRAND_NAMES, ELEVATION_NAMES, MATERIAL_VARS, RADIUS_NAMES, get } from '../theme-packages/components.ts';
import { lightPath, resolvedColors } from '../theme-packages/compile.ts';
import { kebab as fanousKebab, toCss } from '../theme-packages/refs.ts';
import { SECTIONS, SPEC_SLOTS, kebab, type SectionDef } from './catalog.ts';
import { sanitizeSvg } from './svg.ts';
import { BG_PLACEHOLDER, type CompiledTheme, type EmailTheme, type Scheme, type SchemeValue, type StoredPackage } from './types.ts';

export interface CompileOptions {
	/** Public URL of a package file (assets/…) with the given content hash. */
	assetUrl: (path: string, hash: string) => string;
	/** Text of the package's SVG files, by path (header graphics). */
	svgText?: Record<string, string>;
}

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong']);
const fontStack = (families: readonly string[]) => families.map((f) => (GENERIC.has(f) ? f : `'${f}'`)).join(', ');
const num = (px: string) => String(Number(px.replace(/px$/, '')));
const schemeOf = (v: SchemeValue, s: Scheme) => (typeof v === 'string' ? v : v[s]);

export function compileTheme(pkg: StoredPackage, opts: CompileOptions): CompiledTheme {
	const t = pkg.theme;
	const x = t['x-auth'] ?? {};
	const fileUrl = (path: string) => {
		const a = pkg.assets[path];
		return a ? opts.assetUrl(path, a.hash) : path;
	};
	const value = (raw: string) => toCss(raw, fileUrl);
	const imageUrl = (ref: string) => (ref.startsWith('assets/') ? fileUrl(ref) : ref);

	// ---- fonts: Google Fonts stylesheets, then the package's own faces
	let fontCss = '';
	for (const href of x.fontImports ?? []) fontCss += `@import url('${href}');\n`;
	for (const f of t.typography.faces ?? []) {
		fontCss += `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-style:${f.style ?? 'normal'};font-display:swap;src:${value(`{asset:${f.src}}`)} format('woff2')}\n`;
	}
	const body = t.typography.body;
	if (body && fontStack(body.arabic) !== fontStack(body.latin)) {
		fontCss += `:lang(ar) [data-component="root"], :lang(ar) body{font-family:${fontStack(body.arabic)}}\n`;
	}

	// ---- tokens: shared, then colours per scheme
	const colors = resolvedColors(t);
	const shared: string[] = [
		...BRAND_NAMES.map((n) => `--fanous-brand-${fanousKebab(n)}: ${t.tokens.brand[n].toLowerCase()}`),
		`--fanous-font-latin: ${fontStack(t.typography.latin)}`,
		`--fanous-font-arabic: ${fontStack(t.typography.arabic)}`,
		...RADIUS_NAMES.map((n) => `--fanous-radius-${n}: ${num(t.tokens.radius[n])}px`),
		...ELEVATION_NAMES.map((n) => {
			const e = t.tokens.elevation[n];
			const c = e.color.toLowerCase();
			const rgb = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)).join(' ');
			const alpha = c.length === 9 ? Math.round((parseInt(c.slice(7), 16) / 255) * 100) / 100 : 1;
			return `--fanous-elevation-${n}: ${num(e.offsetX)}px ${num(e.offsetY)}px ${num(e.blur)}px ${num(e.spread)}px rgb(${rgb} / ${alpha})`;
		}),
		...MATERIAL_VARS.map(([path, prop]) => `${prop}: ${value(String(get(t, path)))}`),
	];
	const decl: Record<Scheme, string[]> = { light: [], dark: [] };
	for (const s of ['light', 'dark'] as const) {
		for (const r of BASE.roles) decl[s].push(`--fanous-color-${fanousKebab(r.name)}: ${colors[s].roles[r.name]}`);
		for (const { part } of BASE.parts) decl[s].push(`--fanous-c-${part.split('.').map(fanousKebab).join('-')}: ${colors[s].parts[part]}`);
		const gv = (t.signIn as { graphicVars?: Record<Scheme, Record<string, string>> } | undefined)?.graphicVars?.[s] ?? {};
		for (const [name, v] of Object.entries(gv)) decl[s].push(`--${name}: ${value(v)}`);
		decl[s].push(...streetTokens(t, s, fileUrl));
	}
	// Light-only component styles: the same material properties again in the light scheme
	for (const [path, prop] of MATERIAL_VARS) {
		if (!path.startsWith('components.')) continue;
		const v = get(t, lightPath(path));
		if (v !== undefined && v !== '') decl.light.push(`${prop}: ${value(String(v))}`);
	}

	// ---- sections: a value that differs per scheme becomes a variable
	const sections = x.sections ?? {};
	const rawSlot = (section: SectionDef, key: string): SchemeValue | undefined => {
		if (section.id === 'base' && SPEC_SLOTS[key]) return get(t, SPEC_SLOTS[key]) as SchemeValue | undefined;
		return sections[section.id]?.[key];
	};
	const slotValue = (section: SectionDef, key: string): string | undefined => {
		const raw = rawSlot(section, key);
		if (raw === undefined) return undefined;
		const light = value(schemeOf(raw, 'light'));
		const dark = value(schemeOf(raw, 'dark'));
		const name = `--auth-${section.id}-${kebab(key)}`;
		if (section.scope === 'vars' || light !== dark) {
			decl.light.push(`${name}: ${light}`);
			decl.dark.push(`${name}: ${dark}`);
			return `var(${name})`;
		}
		return light;
	};

	const rules = (section: SectionDef, scope: string): string => {
		const bySelector = new Map<string, string[]>();
		for (const slot of section.slots) {
			const v = slotValue(section, slot.key);
			if (v === undefined || !slot.selector || !slot.property) continue;
			const list = bySelector.get(slot.selector) ?? [];
			list.push(`${slot.property}: ${v}`);
			if (slot.property === 'backdrop-filter') list.push(`-webkit-backdrop-filter: ${v}`);
			bySelector.set(slot.selector, list);
		}
		let css = '';
		for (const [selector, list] of bySelector) {
			const scoped = scope ? selector.split(',').map((part) => `${scope} ${part.trim()}`).join(', ') : selector;
			css += `${scoped} { ${list.join('; ')}; }\n`;
		}
		return css;
	};

	const openauthRules = SECTIONS.filter((s) => s.scope === 'openauth')
		.map((s) => rules(s, s.id === 'base' ? '' : `html[data-auth-page="${s.pages![0]}"]`))
		.join('');
	const pickerRules = SECTIONS.filter((s) => s.scope === 'picker').map((s) => rules(s, '')).join('');
	for (const s of SECTIONS.filter((s) => s.scope === 'vars')) for (const slot of s.slots) slotValue(s, slot.key);

	const tokens = `:root{${shared.join(';')};}@media(prefers-color-scheme:light){:root{${decl.light.join(';')};}}@media(prefers-color-scheme:dark){:root{${decl.dark.join(';')};}}`;

	// ---- photos behind the card, header graphic
	const backgrounds = (x.photos?.light ?? []).map(imageUrl);
	// The street draws between the body's background and the page: the body paints the page colour
	// (the sign-in page background) and the root wrapper, which paints it otherwise, lets the street through
	const pageRaw = get(t, SPEC_SLOTS['page.background']) as SchemeValue | undefined;
	const pagePaint = pageRaw === undefined
		? 'var(--fanous-color-background)'
		: value(schemeOf(pageRaw, 'light')) !== value(schemeOf(pageRaw, 'dark')) ? 'var(--auth-base-page-background)' : value(schemeOf(pageRaw, 'light'));
	const streetCss = t.street?.enabled
		? `html.fanous-street body { background: ${pagePaint}; }\nhtml.fanous-street [data-component="root"] { background: transparent !important; }\n`
		: '';
	const bgCss = backgrounds.length
		? `[data-component="root"] { background-image: url('${BG_PLACEHOLDER}'); background-size: cover; background-position: center; background-repeat: no-repeat; }\n`
		: '';
	const svg = (path?: string) => {
		const raw = path ? opts.svgText?.[path] : undefined;
		return raw ? sanitizeSvg(raw) ?? undefined : undefined;
	};
	const signInGraphic = (t.signIn as { graphic?: string } | undefined)?.graphic;
	const header = t.imagery.headerGraphic as { light: string; dark: string } | undefined;
	const gLight = svg(signInGraphic ?? header?.light);
	const graphic = gLight ? { light: gLight, dark: svg(signInGraphic ?? header?.dark) ?? gLight } : undefined;
	const graphicCss = graphic
		? `[data-component="center"] { overflow: hidden; }\n[data-component="center"] > .demo-gfx svg { display: block; width: 100%; height: auto; }\n` +
			(graphic.dark !== graphic.light
				? `@media(prefers-color-scheme:dark){.demo-gfx[data-scheme="light"]{display:none}}@media(prefers-color-scheme:light){.demo-gfx[data-scheme="dark"]{display:none}}\n`
				: '')
		: '';

	const logo = t.imagery.logo as { light: string; dark: string } | undefined;
	const favicon = t.imagery.favicon as string | undefined;
	const email: EmailTheme = { ...(t.email ?? {}) };
	if (email.headerImage) email.headerImage = fileUrl(email.headerImage);

	return {
		id: t.id,
		version: t.version,
		name: t.name,
		openauth: {
			title: x.title ? { en: x.title.en, ar: x.title.ar } : undefined,
			primary: { light: colors.light.roles.primary, dark: colors.dark.roles.primary },
			background: { light: colors.light.roles.background, dark: colors.dark.roles.background },
			favicon: favicon ? fileUrl(favicon) : undefined,
			logo: logo ? { light: fileUrl(logo.light), dark: fileUrl(logo.dark) } : undefined,
			radius: x.radius ?? 'md',
			font: body ? { family: fontStack(body.latin) } : undefined,
			css: `${fontCss}${tokens}\n${bgCss}${graphicCss}${openauthRules}${streetCss}`,
		},
		backgrounds,
		graphic,
		tokensCss: `${fontCss}${tokens}\n`,
		pickerCss: `${fontCss}${tokens}\n${pickerRules}`,
		email,
	};
}

/**
 * The lantern street's tokens for one scheme (the shared street module reads them):
 * --fanous-street-on 1 switches it on; a theme without a street sets 0.
 */
export function streetTokens(t: StoredPackage['theme'], s: Scheme, fileUrl: (path: string) => string): string[] {
	const street = t.street;
	if (!street) return ['--fanous-street-on: 0'];
	return [
		`--fanous-street-on: ${street.enabled ? 1 : 0}`,
		`--fanous-street-line: ${street.line[s].toLowerCase()}`,
		`--fanous-street-window: ${street.window[s].toLowerCase()}`,
		`--fanous-street-glow: ${street.glow[s]}`,
		`--fanous-street-lights: url("${fileUrl(street.lights[s])}")`,
	];
}

/** OpenAuth's theme for one page: picks one of the theme's photos. */
export function openauthThemeFor(compiled: CompiledTheme, pick: () => number = Math.random) {
	const photo = compiled.backgrounds.length ? compiled.backgrounds[Math.floor(pick() * compiled.backgrounds.length)] : '';
	return { ...compiled.openauth, css: compiled.openauth.css.split(BG_PLACEHOLDER).join(photo) };
}
