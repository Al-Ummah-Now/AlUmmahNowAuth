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
import { emailThemeCss, getVerificationCodeTemplate } from '../email-templates';

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
		expect(emailThemeCss({ background: '#ffffff', text: 'red;}body{x' })).toBe('body { background-color: #ffffff; }');
	});
});
