import { describe, expect, it } from 'vitest';
import { AUTH_ICONS, PROFILE_ICONS } from '../../../../packages/ui/src/app-icons/index.ts';
import { signInFavicon } from '../themes/favicon';
import { environmentOfHost, faviconSvgPath, iconLinks, iconServer } from '../../../../packages/ui/src/app-icons/serve.ts';

describe('app icons', () => {
	it('serves each set with its type and cache headers, GET and HEAD only', async () => {
		const serve = iconServer(AUTH_ICONS);
		const svg = serve('/favicon.svg')!;
		expect(svg.headers.get('Content-Type')).toBe('image/svg+xml');
		expect(svg.headers.get('Cache-Control')).toBe('public, max-age=86400, stale-while-revalidate=604800');
		expect(await svg.text()).toContain('prefers-color-scheme:dark');
		expect(serve('/favicon.ico', 'HEAD')!.status).toBe(200);
		expect(serve('/favicon.ico', 'POST')).toBeUndefined();
		expect(serve('/authorize')).toBeUndefined();
		const manifest = await iconServer(PROFILE_ICONS)('/site.webmanifest')!.json();
		expect(manifest.name).toBe('Al Ummah Now Account');
	});

	it('sign-in and account have different marks', () => {
		expect(AUTH_ICONS['/favicon.svg'].body).not.toBe(PROFILE_ICONS['/favicon.svg'].body);
	});

	it('marks every non-production environment', () => {
		expect(faviconSvgPath('production')).toBe('/favicon.svg');
		expect(faviconSvgPath('stage')).toBe('/favicon-stage.svg');
		expect(faviconSvgPath('qa')).toBe('/favicon-qa.svg');
		expect(faviconSvgPath('development')).toBe('/favicon-qa.svg');
		expect(environmentOfHost('admin.auth.qa.alummahnow.net')).toBe('qa');
		expect(environmentOfHost('admin.auth.stage.alummahnow.net')).toBe('stage');
		expect(environmentOfHost('admin.auth.alummahnow.net')).toBe('production');
		expect(iconLinks('qa', { manifest: true })).toContain('href="/favicon-qa.svg"');
	});
});

describe('sign-in favicon', () => {
	it('uses the sign-in mark for built-in themes and a custom theme favicon when one is set', () => {
		expect(signInFavicon({ id: 'fawanees', openauth: { favicon: 'https://auth/themes/assets/x' } }, 'production')).toBe('/favicon.svg');
		expect(signInFavicon({ id: 'fawanees', openauth: {} }, 'qa')).toBe('/favicon-qa.svg');
		expect(signInFavicon({ id: 'my-brand', openauth: { favicon: 'https://auth/themes/assets/y' } }, 'qa')).toBe('https://auth/themes/assets/y');
	});
});
