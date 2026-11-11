import { describe, expect, it } from 'vitest';
import { AUTH_ICONS, PROFILE_ICONS } from '../../../../packages/ui/src/app-icons/index.ts';
import { signInFavicon } from '../themes/favicon';
import { environmentOfHost, faviconSvgPath, iconLinks, iconServer, tabIconHtml, tabIconLinks, tabIconPath } from '../../../../packages/ui/src/app-icons/serve.ts';

describe('app icons', () => {
	it('serves each set with its type and cache headers, GET and HEAD only', async () => {
		const serve = iconServer(AUTH_ICONS);
		const png = serve('/favicon-32x32.png')!;
		expect(png.headers.get('Content-Type')).toBe('image/png');
		expect(png.headers.get('Cache-Control')).toBe('public, max-age=86400, stale-while-revalidate=604800');
		for (const s of [16, 48, 96]) expect(serve(`/favicon-${s}x${s}.png`)!.status).toBe(200);
		// no production SVG: a browser would prefer it over the sized PNGs and blur it
		expect(serve('/favicon.svg')).toBeUndefined();
		const body = await serve('/favicon-qa.svg')!.text();
		expect(body).toContain('data:image/png;base64,');
		expect(body).toContain('<circle');
		expect(serve('/favicon.ico', 'HEAD')!.status).toBe(200);
		expect(serve('/favicon.ico', 'POST')).toBeUndefined();
		expect(serve('/authorize')).toBeUndefined();
		const manifest = await iconServer(PROFILE_ICONS)('/site.webmanifest')!.json();
		expect(manifest.name).toBe('Al Ummah Now Account');
	});

	it('sign-in and account have different marks', () => {
		expect(AUTH_ICONS['/favicon-32x32.png'].body).not.toBe(PROFILE_ICONS['/favicon-32x32.png'].body);
	});

	it('marks every non-production environment', () => {
		expect(faviconSvgPath('production')).toBeNull();
		expect(faviconSvgPath('stage')).toBe('/favicon-stage.svg');
		expect(faviconSvgPath('qa')).toBe('/favicon-qa.svg');
		expect(faviconSvgPath('development')).toBe('/favicon-qa.svg');
		expect(environmentOfHost('admin.auth.qa.alummahnow.net')).toBe('qa');
		expect(environmentOfHost('admin.auth.stage.alummahnow.net')).toBe('stage');
		expect(environmentOfHost('admin.auth.alummahnow.net')).toBe('production');
		expect(iconLinks('qa', { manifest: true })).toContain('href="/favicon-qa.svg"');
	});

	it('production links the ICO and exact-size PNGs, never an SVG', () => {
		expect(tabIconLinks('production').map((l) => [l.href, l.sizes])).toEqual([
			['/favicon.ico', '16x16 32x32 48x48'],
			['/favicon-16x16.png', '16x16'],
			['/favicon-32x32.png', '32x32'],
			['/favicon-48x48.png', '48x48'],
			['/favicon-96x96.png', '96x96'],
		]);
		expect(tabIconLinks('stage').map((l) => l.href)).toEqual(['/favicon.ico', '/favicon-stage.svg']);
		expect(tabIconHtml('production')).toContain('<link rel="icon" href="/favicon-16x16.png" type="image/png" sizes="16x16">');
		expect(iconLinks('production')).not.toContain('svg');
		expect(tabIconPath('production')).toBe('/favicon.ico');
		expect(tabIconPath('qa')).toBe('/favicon-qa.svg');
	});
});

describe('sign-in favicon', () => {
	it('uses the sign-in mark for built-in themes and a custom theme favicon when one is set', () => {
		expect(signInFavicon({ id: 'fawanees', openauth: { favicon: 'https://auth/themes/assets/x' } }, 'production')).toBe('/favicon.ico');
		expect(signInFavicon({ id: 'fawanees', openauth: {} }, 'qa')).toBe('/favicon-qa.svg');
		expect(signInFavicon({ id: 'my-brand', openauth: { favicon: 'https://auth/themes/assets/y' } }, 'qa')).toBe('https://auth/themes/assets/y');
	});
});
