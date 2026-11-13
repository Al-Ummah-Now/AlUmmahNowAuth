/**
 * Auth theme packages (format v1 + x-auth): built-ins, validation, compiler,
 * page decoration, fallback order, SVG sanitizing, zip round trip, email.
 */
import { describe, expect, it } from 'vitest';
import vendoredSchema from '../../../../packages/ui/src/theme-packages/theme-package.v1.schema.json?raw';
import { BUILTIN_IDS, blobBytes, builtinBlob, builtinPackage, compileBuiltin } from '../../../../packages/ui/src/auth-theme/builtin.ts';
import { compileTheme, openauthThemeFor } from '../../../../packages/ui/src/auth-theme/compile.ts';
import { carryThemeOnLocation, decorateHtml, forceScheme, pageKind } from '../../../../packages/ui/src/auth-theme/decorate.ts';
import { BUILTIN_DEFAULT_THEME, chooseTheme } from '../../../../packages/ui/src/auth-theme/resolve.ts';
import { sanitizeSvg } from '../../../../packages/ui/src/auth-theme/svg.ts';
import type { AuthThemeJson, StoredPackage } from '../../../../packages/ui/src/auth-theme/types.ts';
import { referencedAssets, validateTheme } from '../../../../packages/ui/src/auth-theme/validate.ts';
import { SCHEMA } from '../../../../packages/ui/src/theme-packages/schema.generated.ts';
import { packageToZip, zipToPackage } from '../../../../packages/ui/src/theme-packages/zip.ts';
import { STREET_CSS_PATH, STREET_JS_PATH, STREET_START_JS, streetAsset, streetHeadTags, streetOn, streetResponse } from '../../../../packages/ui/src/fanous-street/index.ts';
import { STREET_CSS, STREET_JS } from '../../../../packages/ui/src/fanous-street/street.generated.ts';
import { getVerificationCodeTemplate } from '../email-templates';

const BASE = 'https://auth.example';
const fawanees = () => structuredClone(builtinPackage('fawanees')!) as StoredPackage;
const files = (pkg: StoredPackage) => Object.fromEntries(Object.entries(pkg.assets).map(([p, a]) => [p, blobBytes(builtinBlob(a.hash)!)]));

describe('built-in packages', () => {
	it('are the five Auth looks, Fawanees by default', () => {
		expect(BUILTIN_IDS.sort()).toEqual(['classic', 'fawanees', 'lantern', 'nahas', 'zujaj']);
		expect(BUILTIN_DEFAULT_THEME).toBe('fawanees');
	});

	it.each(['classic', 'fawanees', 'lantern', 'nahas', 'zujaj'])('%s is a valid format v1 package with its files', (id) => {
		const pkg = builtinPackage(id)!;
		expect(pkg.theme.format).toBe('alummahnow.theme-package');
		expect(pkg.theme.formatVersion).toBe(1);
		const v = validateTheme(pkg.theme, { files: files(pkg), builtIn: true });
		expect(v.errors).toEqual([]);
		expect(v.contrast).toEqual([]);
	});

	it('uses the platform schema unchanged', () => {
		expect(JSON.parse(vendoredSchema)).toEqual(SCHEMA);
	});
});

describe('validateTheme', () => {
	it('rejects unknown keys, but keeps x- extension keys', () => {
		const t = fawanees().theme as Record<string, unknown>;
		expect(validateTheme({ ...t, extends: 'classic' }).errors.map((e) => `${e.path}: ${e.message}`).join()).toMatch(/extends: is not a known field/);
		expect(validateTheme({ ...t, 'x-videos': { anything: 1 } }).errors).toEqual([]);
	});

	it('refuses another format version', () => {
		expect(validateTheme({ ...fawanees().theme, formatVersion: 2 }).errors.length).toBeGreaterThan(0);
	});

	it('checks x-auth: section slots, font hosts, CSS values', () => {
		const bad = (ext: unknown) => validateTheme({ ...fawanees().theme, 'x-auth': ext }).errors;
		expect(bad({ sections: { base: { 'card.padding': '2rem' } } })).toEqual([]);
		expect(bad({ sections: { base: { 'card.wobble': '2rem' } } })).not.toEqual([]);
		// Kept in the platform field signIn.card.background, not in x-auth
		expect(bad({ sections: { base: { 'card.background': '#000000' } } })).not.toEqual([]);
		expect(bad({ sections: { signIn: { 'card.background': '#000000' } } })).toEqual([]);
		expect(bad({ fontImports: ['https://evil.example/font.css'] })).not.toEqual([]);
		expect(bad({ sections: { base: { 'page.background': 'url(https://evil.example/x.png)' } } })).not.toEqual([]);
		expect(bad({ sections: { register: { 'card.background': 'red;}</style><script>' } } })).not.toEqual([]);
		expect(bad({ sections: { register: { 'card.background': '{color.nope}' } } })).not.toEqual([]);
		expect(bad({ sections: { register: { 'card.background': { light: '{color.surface}', dark: '{component.form.sectionBg}' } } } })).toEqual([]);
	});

	it('needs every named file in the package', () => {
		const pkg = fawanees();
		const theme = { ...pkg.theme, imagery: { ...pkg.theme.imagery, favicon: 'assets/missing.ico' } };
		expect(validateTheme(theme, { stored: pkg.assets }).errors.map((e) => e.message).join()).toMatch(/missing\.ico/);
		expect(referencedAssets(pkg.theme)).toContain('assets/auth-header.svg');
	});

	it('reports contrast apart from errors (drafts may save, publishing may not)', () => {
		const theme = fawanees().theme;
		theme.tokens.color.light.textMuted = '#fff1c4';
		const v = validateTheme(theme, { stored: fawanees().assets });
		expect(v.errors).toEqual([]);
		expect(v.contrast.map((i) => i.path)).toContain('tokens.color.light.textMuted');
	});
});

describe('compileTheme', () => {
	it('gives OpenAuth the colours, title, logo and font', () => {
		const c = compileBuiltin('fawanees', BASE)!;
		expect(c.openauth.primary).toEqual({ light: '#f4ae3a', dark: '#f4ae3a' });
		expect(c.openauth.title).toEqual({ en: 'Al Ummah Now', ar: 'الأمة الآن' });
		expect(c.openauth.logo!.light).toMatch(/^https:\/\/auth\.example\/themes\/assets\/[0-9a-f]{64}$/);
		expect(c.openauth.font!.family).toBe("'Cairo', sans-serif");
	});

	it('emits tokens per colour scheme, then the sign-in rules', () => {
		const css = compileBuiltin('fawanees', BASE)!.openauth.css;
		expect(css.indexOf('@import')).toBe(0);
		expect(css).toMatch(/@media\(prefers-color-scheme:light\)\{:root\{--fanous-color-background: #/);
		expect(css).toContain('--fanous-c-form-section-bg:');
		expect(css).toContain('--m-primary:');
		expect(css).toContain('[data-component="center"] { width: min(400px, calc(100vw - 32px))');
		expect(css).toContain('background: var(--fanous-c-form-section-bg)');
		expect(css).toContain('box-shadow: 0 18px 40px rgb(0 0 0 / 0.28)');
		expect(css).not.toMatch(/\{(?:color|component)\./);
	});

	it('scopes per-page sections and turns per-scheme values into variables', () => {
		const pkg = fawanees();
		pkg.theme['x-auth']!.sections!.register = { 'card.background': { light: '#ffffff', dark: '#000000' }, 'button.radius': '2px' };
		const css = compileTheme(pkg, { assetUrl: (_p, h) => `${BASE}/themes/assets/${h}` }).openauth.css;
		expect(css).toContain('html[data-auth-page="register"] [data-component="center"] { background: var(--auth-register-card-background)');
		expect(css).toContain('--auth-register-card-background: #ffffff');
		expect(css).toContain('--auth-register-card-background: #000000');
		expect(css).toContain('html[data-auth-page="register"] [data-component="button"] { border-radius: 2px');
	});

	it('classic picks one of its photos per page', () => {
		const c = compileBuiltin('classic', BASE)!;
		expect(c.backgrounds).toHaveLength(2);
		expect(openauthThemeFor(c, () => 0).css).toContain(`url('${c.backgrounds[0]}')`);
		expect(openauthThemeFor(c, () => 0.99).css).toContain(`url('${c.backgrounds[1]}')`);
	});

	it('inlines the header graphic, sanitized', () => {
		const c = compileBuiltin('lantern', BASE)!;
		expect(c.graphic!.light).toMatch(/^<svg/);
		expect(c.graphic!.light).not.toMatch(/<script/i);
	});
});

describe('the lantern street (Fawanees 1.2.0)', () => {
	/** The declarations of one colour scheme's :root block. */
	const scheme = (css: string, s: 'light' | 'dark') => {
		const m = new RegExp(`@media\\(prefers-color-scheme:${s}\\)\\{:root\\{([^}]*)\\}\\}`).exec(css);
		expect(m, `${s} block`).not.toBeNull();
		return m![1].split(';').map((d) => d.trim());
	};

	it('Fawanees switches the street on in both schemes, with each scheme\'s colours and lights', () => {
		const pkg = builtinPackage('fawanees')!;
		expect(pkg.theme.version).toBe('1.2.0');
		const css = compileBuiltin('fawanees', BASE)!.tokensCss;
		const light = scheme(css, 'light');
		const dark = scheme(css, 'dark');
		const url = (path: string) => `url("${BASE}/themes/assets/${pkg.assets[path]!.hash}")`;
		expect(light).toEqual(expect.arrayContaining(['--fanous-street-on: 1', '--fanous-street-line: #d8cebdff', '--fanous-street-window: #f4ae3a29', '--fanous-street-glow: 0.34', `--fanous-street-lights: ${url('assets/street-lights.svg')}`]));
		expect(dark).toEqual(expect.arrayContaining(['--fanous-street-on: 1', '--fanous-street-line: #f5cf9242', '--fanous-street-window: #fbc661b8', '--fanous-street-glow: 0.6', `--fanous-street-lights: ${url('assets/street-lights-dark.svg')}`]));
		expect(streetOn(css)).toBe(true);
	});

	it('Fawanees light is the approved palette', () => {
		const light = scheme(compileBuiltin('fawanees', BASE)!.tokensCss, 'light');
		expect(light).toEqual(expect.arrayContaining(['--fanous-color-background: #f3eee5', '--fanous-color-surface: #fffdf9', '--fanous-color-surface-raised: #ffffff', '--fanous-color-text-primary: #16232b', '--fanous-color-link: #7a4300', '--fanous-color-primary: #f4ae3a', '--fanous-color-outline: #7a7468', '--fanous-color-divider: #e4ded3']));
	});

	it.each(['classic', 'lantern', 'nahas', 'zujaj'])('%s has no street (switched off explicitly in both schemes)', (id) => {
		const c = compileBuiltin(id, BASE)!;
		expect(scheme(c.tokensCss, 'light')).toContain('--fanous-street-on: 0');
		expect(scheme(c.tokensCss, 'dark')).toContain('--fanous-street-on: 0');
		expect(c.tokensCss).not.toContain('--fanous-street-lights');
		expect(streetOn(c.tokensCss)).toBe(false);
		expect(c.openauth.css).not.toContain('fanous-street [data-component');
	});

	it('a disabled street stays off', () => {
		const pkg = fawanees();
		pkg.theme.street!.enabled = false;
		const c = compileTheme(pkg, { assetUrl: (_p, h) => `${BASE}/themes/assets/${h}` });
		expect(scheme(c.tokensCss, 'light')).toContain('--fanous-street-on: 0');
		expect(streetOn(c.tokensCss)).toBe(false);
		expect(c.openauth.css).not.toContain('fanous-street [data-component');
	});

	it('light-only component styles override the shared ones in the light scheme only', () => {
		const css = compileBuiltin('fawanees', BASE)!.tokensCss;
		const shared = /^:root\{([^}]*)\}/.exec(css.slice(css.indexOf(':root{')))![1];
		// shared (dark) primary button: the sheen gradient; light: flat primary
		expect(shared).toMatch(/--m-primary: linear-gradient\(180deg/);
		expect(scheme(css, 'light')).toContain('--m-primary: linear-gradient(var(--fanous-color-primary),var(--fanous-color-primary))');
		expect(scheme(css, 'dark').some((d) => d.startsWith('--m-primary:'))).toBe(false);
		// only components with a lightStyle: lantern gets none
		expect(scheme(compileBuiltin('lantern', BASE)!.tokensCss, 'light').some((d) => d.startsWith('--m-'))).toBe(false);
	});

	it('the sign-in root wrapper lets the street through (html paints the page colour)', () => {
		expect(compileBuiltin('fawanees', BASE)!.openauth.css).toContain('html.fanous-street [data-component="root"] { background: transparent !important; }');
	});

	it('pages load the street module same-origin when the theme has one, never in the preview', () => {
		const html = '<html lang="en"><head><style>x</style></head><body><div data-component="center"></div></body></html>';
		const live = decorateHtml(html, compileBuiltin('fawanees', BASE)!, { page: 'sign-in', street: true });
		expect(live).toContain(`${streetHeadTags()}</head>`);
		expect(live.indexOf('<style>x</style>')).toBeLessThan(live.indexOf(STREET_CSS_PATH));
		expect(streetHeadTags()).toBe(`<link rel="stylesheet" href="${STREET_CSS_PATH}" data-fanous-street><script type="module" src="${STREET_JS_PATH}" data-fanous-street></script>`);
		expect(decorateHtml(html, compileBuiltin('lantern', BASE)!, { page: 'sign-in', street: true })).not.toContain('fanous-street');
		expect(decorateHtml(html, compileBuiltin('fawanees', BASE)!, { page: 'sign-in' })).not.toContain(STREET_JS_PATH);
	});

	it('serves the module and its start call under hashed, immutable paths', async () => {
		expect(STREET_CSS_PATH).toMatch(/^\/fanous-street\/street\.[0-9a-f]{12}\.css$/);
		expect(STREET_JS_PATH).toMatch(/^\/fanous-street\/start\.[0-9a-f]{12}\.js$/);
		expect(STREET_START_JS.startsWith(STREET_JS)).toBe(true);
		expect(STREET_START_JS.trimEnd().endsWith('startStreet();')).toBe(true);
		expect(STREET_JS).toContain('export function startStreet(');
		expect(STREET_CSS).toContain('html.fanous-street');
		expect(streetAsset(STREET_CSS_PATH)!.type).toBe('text/css; charset=utf-8');
		expect(streetAsset('/fanous-street/start.000000000000.js')).toBeUndefined();
		const res = streetResponse(STREET_JS_PATH)!;
		expect(res.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
		expect(res.headers.get('Cache-Control')).toContain('immutable');
		expect(await res.text()).toBe(STREET_START_JS);
	});
});

describe('page decoration', () => {
	const html = '<html lang="en"><head></head><body><div data-component="center"><a href="/password/register?auth_flow=abc">r</a></div></body></html>';

	it('names the theme and page, adds the graphic and carries the theme in links', () => {
		const out = decorateHtml(html, compileBuiltin('lantern', BASE)!, { page: 'register', carryTheme: 'my-theme' });
		expect(out).toContain('data-theme="lantern" data-auth-page="register"');
		expect(out).toContain('<div class="demo-gfx"');
		expect(out).toContain('auth_flow=abc&amp;theme=my-theme');
	});

	it('tells pages apart', () => {
		expect(pageKind('/password/authorize', '')).toBe('sign-in');
		expect(pageKind('/password/register', '<input name="code">')).toBe('code');
		expect(pageKind('/password/change', '')).toBe('reset');
		expect(pageKind('/activate', '')).toBe('consent');
	});

	it('forces a colour scheme for previews', () => {
		expect(forceScheme('@media (prefers-color-scheme: dark){a{}}', 'dark')).toBe('@media (min-width: 0px){a{}}');
		expect(forceScheme('@media (prefers-color-scheme: dark){a{}}', 'light')).toBe('@media (max-width: 0px){a{}}');
	});

	it('keeps the theme on same-origin redirects only', () => {
		expect(carryThemeOnLocation('/password/authorize?x=1', BASE, 'nahas')).toBe('/password/authorize?x=1&theme=nahas');
		expect(carryThemeOnLocation('https://app.example/cb?code=1', BASE, 'nahas')).toBe('https://app.example/cb?code=1');
	});
});

describe('theme fallback order', () => {
	const published = (ids: string[]) => (id: string) => ids.includes(id);
	it('requested, then the client default, then the Auth default, then Fawanees', () => {
		const all = published(['a', 'b', 'c']);
		expect(chooseTheme({ requested: 'a', clientDefault: 'b', authDefault: 'c' }, all)).toEqual({ id: 'a', source: 'requested' });
		expect(chooseTheme({ requested: 'zz', clientDefault: 'b', authDefault: 'c' }, all)).toEqual({ id: 'b', source: 'client' });
		expect(chooseTheme({ requested: null, clientDefault: 'gone', authDefault: 'c' }, all)).toEqual({ id: 'c', source: 'auth' });
		expect(chooseTheme({ requested: 'zz', clientDefault: null, authDefault: 'gone' }, all)).toEqual({ id: 'fawanees', source: 'builtin' });
	});
});

describe('sanitizeSvg', () => {
	it('drops scripts, handlers and outside links', () => {
		const out = sanitizeSvg(
			'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><a href="https://evil.example"><rect width="1" height="1"/></a><use href="#x"/><image href="https://evil.example/a.png"/></svg>'
		)!;
		expect(out).not.toMatch(/onload|<script|evil\.example|<image/i);
		expect(out).toContain('<use href="#x"');
	});

	it('leaves no comment openers or script schemes after nested tricks', () => {
		const out = sanitizeSvg(
			'<svg><!<!-- x -->-- <script>alert(1)</script --><style>a{b:java<!-- -->script:x;c:vbscript:y;d:data:z;e:expres<!-- -->sion(1)}</style><rect/></svg>'
		)!;
		expect(out).not.toMatch(/<!--|<script|javascript:|vbscript:|data:|expression\(/i);
		expect(out).toContain('<rect');
	});

	it('keeps CDATA styles and drops comments, doctype and processing instructions', () => {
		const out = sanitizeSvg(
			'<?xml version="1.0"?><!DOCTYPE svg><svg><style><![CDATA[ .a > .b { fill: red } ]]></style><!-- <script>alert(1)</script> --><?pi x?><g class="a"><rect class="b"/></g></svg>'
		)!;
		expect(out).toBe('<svg><style> .a > .b { fill: red } </style><g class="a"><rect class="b"/></g></svg>');
	});
});

describe('zip', () => {
	it('round-trips a package as <id>/theme.json + assets/', async () => {
		const pkg = fawanees();
		const zip = packageToZip({ theme: pkg.theme as AuthThemeJson, assets: files(pkg) });
		const back = await zipToPackage(zip);
		expect(back.theme).toEqual(pkg.theme);
		expect(Object.keys(back.assets).sort()).toEqual(Object.keys(pkg.assets).sort());
	});
});

describe('email theme', () => {
	it('leaves the email unchanged without a theme and keeps only safe values', () => {
		const data = { code: '123456', email: 'a@example.com' } as never;
		expect(getVerificationCodeTemplate(data, {})).toBe(getVerificationCodeTemplate(data));
		const themed = getVerificationCodeTemplate(data, { background: '#ffffff', text: 'red;}body{x', buttonBackground: '#123456' });
		expect(themed).toContain('background:#ffffff');
		expect(themed).not.toContain('red;}body{x');
	});
});
