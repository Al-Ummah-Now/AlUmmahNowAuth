/**
 * Auth's own themes on the sign-in pages: an app may ask for one of Auth's
 * published themes with ?theme=<id>; the theme stays for the whole flow; an
 * id Auth doesn't have falls back to the client's default, then Auth's.
 * Read-only: nothing is created, so there is nothing to clean up.
 */
import { test, expect, type Page } from '@playwright/test';
import { TEST_URLS } from '../../utils/test-data';

const LINK = (page: 'authorize' | 'register' | 'change') => `a[href^="${page}?"]`;

async function signInUrl(page: Page): Promise<URL> {
	await page.goto(TEST_URLS.profileApp);
	await expect(page).toHaveURL(new RegExp(`${TEST_URLS.authServer}/password/authorize`));
	return new URL(page.url());
}

/** The /authorize URL the profile app started with, with ?theme= set. */
async function authorizeWithTheme(page: Page, theme: string, lang = 'en'): Promise<string> {
	let authorize = '';
	page.on('request', (r) => {
		if (!authorize && r.url().startsWith(`${TEST_URLS.authServer}/authorize`)) authorize = r.url();
	});
	await signInUrl(page);
	expect(authorize).not.toBe('');
	const u = new URL(authorize);
	u.searchParams.set('theme', theme);
	u.searchParams.set('lang', lang);
	return u.toString();
}

test.describe('Sign-in themes', () => {
	test.setTimeout(90000);

	test('lists the published themes', async ({ request }) => {
		const res = await request.get(`${TEST_URLS.authServer}/themes`);
		expect(res.ok()).toBe(true);
		const body = await res.json();
		expect(body.themes.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining(['classic', 'fawanees', 'lantern', 'nahas', 'zujaj']));
		expect(typeof body.default).toBe('string');
	});

	for (const lang of ['en', 'ar']) {
		test(`?theme=nahas styles every page of the flow (${lang})`, async ({ page }) => {
			await page.goto(await authorizeWithTheme(page, 'nahas', lang));
			await expect(page).toHaveURL(/\/password\/authorize/);
			const html = page.locator('html');
			await expect(html).toHaveAttribute('data-theme', 'nahas');
			await expect(html).toHaveAttribute('data-auth-page', 'sign-in');
			await expect(html).toHaveAttribute('lang', lang);
			await expect(page.locator('[data-component="center"] > .demo-gfx svg')).toBeVisible();

			await page.click(LINK('register'));
			await expect(page).toHaveURL(/\/password\/register/);
			await expect(html).toHaveAttribute('data-theme', 'nahas');
			await expect(html).toHaveAttribute('data-auth-page', 'register');

			await page.click(LINK('authorize'));
			await page.click(LINK('change'));
			await expect(page).toHaveURL(/\/password\/change/);
			await expect(html).toHaveAttribute('data-theme', 'nahas');
			await expect(html).toHaveAttribute('data-auth-page', 'reset');
		});
	}

	test('an unknown theme id falls back to the default', async ({ page, request }) => {
		const resolved = await (await request.get(`${TEST_URLS.authServer}/themes/resolve?theme=no-such-theme`)).json();
		expect(resolved.source).not.toBe('requested');
		await page.goto(await authorizeWithTheme(page, 'no-such-theme'));
		await expect(page).toHaveURL(/\/password\/authorize/);
		const theme = await page.locator('html').getAttribute('data-theme');
		expect(theme).not.toBe('no-such-theme');
		expect(['classic', 'fawanees', 'lantern', 'nahas', 'zujaj', resolved.id]).toContain(theme);
	});
});
