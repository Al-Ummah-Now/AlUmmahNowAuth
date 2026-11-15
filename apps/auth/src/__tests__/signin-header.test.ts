/**
 * The sign-in pages get the shared site header (AlUmmahNow docs/design/NAV.md "Header") through the
 * page decoration: the vendored header.js builders (packages/ui/src/nav, kept byte-identical by
 * `pnpm nav:check`), first in OpenAuth's root, with the light/dark script last in <head>.
 */
import { describe, expect, it } from 'vitest';
import { compileBuiltin } from '../../../../packages/ui/src/auth-theme/builtin.ts';
import { decorateHtml, signInHeaderHtml, SIGN_IN_HEADER_CSS } from '../../../../packages/ui/src/auth-theme/decorate.ts';
import { appLinksHtml, brandHtml, envBadgeHtml, langButtonHtml } from '../../../../packages/ui/src/nav/header.js';
import { modeButtonBothHtml, PAGE_MODE_SCRIPT } from '../../../../packages/ui/src/nav/page-header.ts';
import { signInHeaderFor } from '../themes/pages';
import { HEADER_ICON_PATHS, serveIcon } from '../themes/favicon';
import { renderPreview } from '../themes/preview';

const BASE = 'https://auth.qa.alummahnow.net';
const env = { ENVIRONMENT: 'qa', OPENAUTH_ISSUER: BASE, PROFILE_APP_URL: 'https://profile.auth.qa.alummahnow.net/' };
const page =
	'<!DOCTYPE html><html lang="en" dir="ltr"><head><style>:root{@media (prefers-color-scheme: light){--x:1}}</style></head>' +
	'<body><div data-component="root"><div data-component="center"><form></form></div></div></body></html>';

describe('sign-in header', () => {
	it('is the builders in the spec order, with no account control and no Sign in', () => {
		const url = new URL(`${BASE}/password/authorize?client_id=c&theme=fawanees`);
		const header = signInHeaderHtml(signInHeaderFor(url, 'en', env));
		expect(header).toBe(
			'<header class="aun-header" data-testid="aun-header">' +
				brandHtml({ lang: 'en', href: 'https://profile.auth.qa.alummahnow.net/', app: 'Account', logoSrc: '/brand/logo-64.webp' }) +
				envBadgeHtml('qa', 'en') +
				'<div class="aun-header-tools">' +
				appLinksHtml({
					lang: 'en',
					links: [
						{ id: 'www', href: 'https://www.qa.alummahnow.net/en/' },
						{ id: 'videos', href: 'https://videos.qa.alummahnow.net/en' },
					],
					iconBase: '/aun-nav/icons',
				}) +
				// the language button keeps the sign-in query
				langButtonHtml({ lang: 'en', href: '/password/authorize?client_id=c&theme=fawanees&lang=ar' }) +
				modeButtonBothHtml('en') +
				'</div></header>',
		);
	});

	it('Arabic: the brand goes to the Arabic account home, the button back to English keeps the query', () => {
		const url = new URL(`${BASE}/password/authorize?lang=ar&client_id=c`);
		const header = signInHeaderHtml(signInHeaderFor(url, 'ar', env));
		expect(header).toContain(brandHtml({ lang: 'ar', href: 'https://profile.auth.qa.alummahnow.net/?lang=ar', app: 'الحساب', logoSrc: '/brand/logo-64.webp' }));
		expect(header).toContain(langButtonHtml({ lang: 'ar', href: '/password/authorize?lang=en&client_id=c' }));
		expect(header).toContain('href="https://www.qa.alummahnow.net/ar/"');
		expect(header).toContain(envBadgeHtml('qa', 'ar'));
	});

	it('the language link never becomes protocol-relative (a request path like //evil.example)', () => {
		for (const path of ['//evil.example', '///evil.example/x', '/%5Cevil.example']) {
			const header = signInHeaderHtml(signInHeaderFor(new URL(`${BASE}${path}?client_id=c`), 'en', env));
			const href = /class="aun-lang" href="([^"]*)"/.exec(header)![1];
			expect(href).toMatch(/^\/(?![/\\])/);
		}
	});

	it('no badge in production', () => {
		const header = signInHeaderHtml(signInHeaderFor(new URL('https://auth.alummahnow.net/password/authorize'), 'en', { ...env, ENVIRONMENT: 'production', OPENAUTH_ISSUER: 'https://auth.alummahnow.net' }));
		expect(header).not.toContain('aun-env');
		expect(header).toContain('href="https://www.alummahnow.net/en/"');
	});

	it('goes first in OpenAuth root; styles and the mode script go last in <head>, after the page styles', () => {
		const h = signInHeaderFor(new URL(`${BASE}/password/authorize`), 'en', env);
		const out = decorateHtml(page, compileBuiltin('fawanees', BASE)!, { page: 'sign-in', header: h, street: true });
		expect(out).toContain(`<div data-component="root">${signInHeaderHtml(h)}<div data-component="center">`);
		const head = out.slice(0, out.indexOf('</head>'));
		expect(head.endsWith(`${SIGN_IN_HEADER_CSS}</style><script>${PAGE_MODE_SCRIPT}</script>`)).toBe(true);
		expect(head.indexOf('<style>:root')).toBeLessThan(head.indexOf('<style data-aun-header>'));
		expect(head).toContain('.aun-header {');
		// without the option nothing changes
		expect(decorateHtml(page, compileBuiltin('fawanees', BASE)!, { page: 'sign-in' })).not.toContain('aun-header');
	});

	it('the account switcher (no OpenAuth root) gets it first in <body>', () => {
		const h = signInHeaderFor(new URL(`${BASE}/select-account`), 'en', env);
		const out = decorateHtml('<html><head></head><body><div class="container"></div></body></html>', compileBuiltin('fawanees', BASE)!, { page: 'account-switcher', header: h });
		expect(out).toContain(`<body>${signInHeaderHtml(h)}<div class="container">`);
	});

	it('serves the logo and the Website and Videos icons it shows', async () => {
		for (const path of HEADER_ICON_PATHS) {
			const res = serveIcon(path)!;
			expect(res.headers.get('Content-Type')).toBe('image/webp');
			const bytes = new Uint8Array(await res.arrayBuffer());
			expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WEBP');
		}
	});

	it('the admin preview shows the same header, as the chosen scheme, with no script', async () => {
		const html = await renderPreview(compileBuiltin('fawanees', BASE)!, { page: 'sign-in', lang: 'en', scheme: 'dark', issuer: BASE, profileUrl: env.PROFILE_APP_URL });
		expect(html).toContain('<header class="aun-header" data-testid="aun-header">');
		expect(html).not.toMatch(/<script\b/);
		// every style answers for the chosen scheme (the inert script's text aside)
		expect(html.replace(/<template>[\s\S]*?<\/template>/g, '')).not.toContain('prefers-color-scheme');
	});
});
