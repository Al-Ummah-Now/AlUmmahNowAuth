import { describe, expect, it } from 'vitest';
import { Layout } from '@al-ummah-now/openauth/ui/base';
import * as openauthTheme from '@al-ummah-now/openauth/ui/theme';
import { BACKGROUND_IMAGES, authTheme, requestTheme } from './theme';

type LayoutProps = Parameters<typeof Layout>[0];

/** Renders OpenAuth's page shell with a theme passed to this render. */
async function renderShell(locale: 'en' | 'ar', theme = requestTheme()): Promise<string> {
	const node = Layout({ locale, theme, children: 'page' } as LayoutProps);
	return String(await node.toString());
}

const htmlTag = (html: string) => html.match(/<html[^>]*>/)?.[0] ?? '';

describe('sign-in theme (passed per request)', () => {
	it('OpenAuth no longer keeps a theme in a global', () => {
		expect(openauthTheme).not.toHaveProperty('setTheme');
		expect(openauthTheme).not.toHaveProperty('getTheme');
	});

	it('carries no locale or direction: the request decides those', () => {
		const theme = requestTheme();
		expect(theme).not.toHaveProperty('locale');
		expect(theme).not.toHaveProperty('direction');
		expect(authTheme(BACKGROUND_IMAGES[0])).toEqual(authTheme(BACKGROUND_IMAGES[0]));
	});

	it('picks one of the background images for each request', () => {
		expect(requestTheme(() => 0).css).toContain(BACKGROUND_IMAGES[0]);
		expect(requestTheme(() => 0.99).css).toContain(BACKGROUND_IMAGES[BACKGROUND_IMAGES.length - 1]);
	});

	it('concurrent renders keep their own language and direction', async () => {
		const pages = await Promise.all(
			Array.from({ length: 8 }, (_, i) => renderShell(i % 2 ? 'ar' : 'en', requestTheme(() => (i % 2 ? 0 : 0.99))))
		);
		pages.forEach((html, i) => {
			const tag = htmlTag(html);
			if (i % 2) expect(tag).toMatch(/lang="ar"[^>]*dir="rtl"|dir="rtl"[^>]*lang="ar"/);
			else expect(tag).toMatch(/lang="en"[^>]*dir="ltr"|dir="ltr"[^>]*lang="en"/);
		});
	});

	it('uses the Farsi title font for Arabic through CSS, not per request', () => {
		expect(requestTheme().css).toMatch(/:lang\(ar\) \[data-component="title"\]\s*\{\s*font-family: "Farsi Simple Bold";/);
	});
});
