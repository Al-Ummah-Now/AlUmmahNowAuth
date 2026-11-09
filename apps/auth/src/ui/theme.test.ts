import { describe, expect, it } from 'vitest';
import { Layout } from '@al-ummah-now/openauth/ui/base';
import { setTheme } from '@al-ummah-now/openauth/ui/theme';
import { AUTH_THEME, BACKGROUND_IMAGES, authTheme } from './theme';

type LayoutProps = Parameters<typeof Layout>[0];

/** Renders OpenAuth's page shell the way its password pages do (theme from the global). */
async function renderShell(locale: 'en' | 'ar'): Promise<string> {
	const node = Layout({ locale, children: 'page' } as LayoutProps);
	return String(await node.toString());
}

const htmlTag = (html: string) => html.match(/<html[^>]*>/)?.[0] ?? '';

describe('sign-in theme (shared by every request in the isolate)', () => {
	it('is the same whichever request built it: no locale, no direction', () => {
		expect(AUTH_THEME).not.toHaveProperty('locale');
		expect(AUTH_THEME).not.toHaveProperty('direction');
		expect(authTheme(BACKGROUND_IMAGES[0])).toEqual(authTheme(BACKGROUND_IMAGES[0]));
	});

	it('an Arabic page is rtl even when an English request set the global theme last', async () => {
		// The race: an English request's setTheme lands between an Arabic request's
		// setTheme and its render. With a request-independent theme that is harmless.
		setTheme(AUTH_THEME);
		expect(htmlTag(await renderShell('ar'))).toMatch(/lang="ar"[^>]*dir="rtl"|dir="rtl"[^>]*lang="ar"/);
		expect(htmlTag(await renderShell('en'))).toMatch(/lang="en"[^>]*dir="ltr"|dir="ltr"[^>]*lang="en"/);
	});

	it('a theme carrying a direction overrides the locale (why the theme must not have one)', async () => {
		setTheme({ ...AUTH_THEME, direction: 'ltr' } as typeof AUTH_THEME);
		expect(htmlTag(await renderShell('ar'))).toContain('dir="ltr"');
		setTheme(AUTH_THEME);
	});

	it('uses the Farsi title font for Arabic through CSS, not per request', () => {
		expect(AUTH_THEME.css).toMatch(/:lang\(ar\) \[data-component="title"\]\s*\{\s*font-family: "Farsi Simple Bold";/);
	});
});
