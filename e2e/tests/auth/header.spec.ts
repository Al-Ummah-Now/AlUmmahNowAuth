/**
 * The shared site header (AlUmmahNow docs/design/NAV.md "Header") on the sign-in pages and the
 * profile app: brand, QA/stage badge (never on production or local dev), no links to other sites
 * (owner, 2026-11-15), language (keeps the page and query), light/dark (the choice wins over the device, before first
 * paint), then the account menu on the profile, nothing on the sign-in page itself. 64px bar,
 * 56px on phones, full width (the brand 16px from the edge, 12px on phones; never centred), in the
 * contract's typeface whatever the page's font (system-ui; Noto Naskh Arabic in Arabic); no axe violations in the header (WCAG 2.2 AA plus label-content-name-mismatch,
 * e2e/utils/header-axe.ts) in English and Arabic: no aria-label on the language button.
 *
 * Fawanees is asked for with ?theme= (no environment's theme changes).
 */
import { test, expect, type Page } from '@playwright/test';
import { register } from '../../fixtures/auth';
import { HEADER, HEADER_FONT, headerAxe, headerMetrics, oneLineProblems } from '../../utils/header-axe';
import { TEST_URLS, generateTestEmail } from '../../utils/test-data';

// Registers with the test password: traces would record it. See e2e/utils/secret-input.ts.
test.use({ trace: 'off' });

const authHost = new URL(TEST_URLS.authServer).hostname;
const ENVIRONMENT = authHost.includes('.qa.') ? 'qa' : authHost.includes('.stage.') ? 'stage' : authHost === 'localhost' ? 'local' : 'production';
const htmlMode = (page: Page) => page.evaluate(() => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'));
/** The header's controls in reading order. */
const controls = (page: Page) =>
	page.locator(`${HEADER} :is(.aun-brand, .aun-env, .aun-lang, .aun-mode, .aun-acct-btn, .aun-signin)`).evaluateAll((els) =>
		els
			.filter((el) => el.getClientRects().length)
			.map((el) => {
				if (el.classList.contains('aun-mode')) return 'aun-icon-btn:mode';
				return ['aun-brand', 'aun-env', 'aun-lang', 'aun-acct-btn', 'aun-signin'].find((c) => el.classList.contains(c))!;
			}),
	);

async function openSignIn(page: Page): Promise<void> {
	await page.goto(`${TEST_URLS.profileApp}/?theme=fawanees`);
	await expect(page).toHaveURL(new RegExp(`${TEST_URLS.authServer}/password/authorize`));
	await expect(page.locator(HEADER)).toBeVisible();
}

test.describe('Sign-in header', () => {
	test('brand, badge, language, light/dark; no links to other sites, no account control; the card stays centred', async ({ page }) => {
		await page.emulateMedia({ colorScheme: 'dark' });
		await openSignIn(page);
		const expected = ['aun-brand', ...(ENVIRONMENT === 'qa' || ENVIRONMENT === 'stage' ? ['aun-env'] : []), 'aun-lang', 'aun-icon-btn:mode'];
		expect(await controls(page)).toEqual(expected);
		await expect(page.locator(HEADER).locator('.aun-brand-app')).toHaveText('Account');
		await expect(page.locator(`${HEADER} :is(.aun-apps, .aun-app, a[href*="//www."], a[href*="//videos."])`)).toHaveCount(0);
		expect((await page.locator(HEADER).boundingBox())!.height).toBe(64);
		// the header spans the top; the card sits below it, centred
		const header = (await page.locator(HEADER).boundingBox())!;
		const card = (await page.locator('[data-component="center"]').boundingBox())!;
		expect(header.y).toBe(0);
		expect(header.width).toBe(page.viewportSize()!.width);
		expect(card.y).toBeGreaterThanOrEqual(header.height);
		expect(Math.abs(card.x + card.width / 2 - page.viewportSize()!.width / 2)).toBeLessThanOrEqual(1);
		expect(await headerAxe(page, 'en dark')).toEqual([]);
	});

	test('the language button keeps the sign-in page and its query', async ({ page }) => {
		await openSignIn(page);
		const before = new URL(page.url());
		const lang = page.locator(`${HEADER} .aun-lang`);
		await expect(lang).toHaveAccessibleName('Switch to Arabic: العربية');
		await lang.click();
		await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
		const after = new URL(page.url());
		expect(after.pathname).toBe(before.pathname);
		expect(after.searchParams.get('lang')).toBe('ar');
		for (const [k, v] of before.searchParams) if (k !== 'lang') expect(after.searchParams.get(k)).toBe(v);
		await expect(page.locator(HEADER).locator('.aun-brand-app')).toHaveText('الحساب');
		await expect(page.locator(`${HEADER} .aun-lang`)).toHaveAccessibleName('التبديل إلى الإنجليزية: English');
		await expect(page.locator(`${HEADER} .aun-lang`)).not.toHaveAttribute('aria-label');
		await expect(page.locator('input[type="password"]')).toBeVisible();
		expect(await headerAxe(page, 'ar')).toEqual([]);
	});

	test('light/dark: the device until a choice, the choice wins after a reload, no System option', async ({ page }) => {
		await page.emulateMedia({ colorScheme: 'dark' });
		await openSignIn(page);
		await page.evaluate(() => localStorage.removeItem('theme'));
		await page.reload();
		expect(await htmlMode(page)).toBe('dark');
		const toggle = page.locator(`${HEADER} .aun-mode`);
		await expect(toggle).toHaveAttribute('aria-label', 'Switch to light mode');
		await expect(toggle.locator('svg.lucide-sun')).toBeVisible();
		const darkBg = await page.evaluate(() => getComputedStyle(document.querySelector('[data-component="center"]')!).backgroundColor);

		await toggle.click();
		expect(await htmlMode(page)).toBe('light');
		await expect(toggle).toHaveAttribute('aria-label', 'Switch to dark mode');
		await expect(toggle.locator('svg.lucide-moon')).toBeVisible();
		expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('light');
		// the page's own styles follow the choice, not the device
		const lightBg = await page.evaluate(() => getComputedStyle(document.querySelector('[data-component="center"]')!).backgroundColor);
		expect(lightBg).not.toBe(darkBg);
		expect(await headerAxe(page, 'en light')).toEqual([]);

		// a dark device, reloaded: still light
		await page.reload();
		expect(await htmlMode(page)).toBe('light');
		expect(await page.evaluate(() => getComputedStyle(document.querySelector('[data-component="center"]')!).backgroundColor)).toBe(lightBg);
		await toggle.click();
		expect(await htmlMode(page)).toBe('dark');
		expect(await page.evaluate(() => getComputedStyle(document.querySelector('[data-component="center"]')!).backgroundColor)).toBe(darkBg);
	});

	test('phone: a 56px bar with language and light/dark', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await openSignIn(page);
		expect((await page.locator(HEADER).boundingBox())!.height).toBe(56);
		await expect(page.locator(`${HEADER} .aun-lang`)).toBeVisible();
		await expect(page.locator(`${HEADER} .aun-mode`)).toBeVisible();
		const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
		expect(scrollWidth).toBeLessThanOrEqual(390);
		expect(await headerAxe(page, 'phone')).toEqual([]);
	});
});

/**
 * Full width, one typeface, one line: the same frame as www and the videos site at 1440 and 390,
 * in English and Arabic (the brand at the inline-start edge, mirrored).
 */
test.describe('Header frame: full width, one typeface', () => {
	for (const [name, open] of [
		['sign-in', (page: Page, ar: boolean) => openSignIn(page).then(() => (ar ? page.goto(`${page.url()}&lang=ar`) : undefined))],
		['profile', (page: Page, ar: boolean) => page.goto(`${TEST_URLS.profileApp}/?error=access_denied&theme=fawanees${ar ? '&lang=ar' : ''}`)],
	] as const) {
		for (const lang of ['en', 'ar'] as const) {
			test(`${name} ${lang}: 64px at 1440 and 56px at 390, one line from 320, the brand at the edge, the contract's font`, async ({ page }) => {
				await page.setViewportSize({ width: 1440, height: 900 });
				await open(page, lang === 'ar');
				await expect(page.locator('html')).toHaveAttribute('lang', lang);
				const desk = await headerMetrics(page);
				expect(desk.height).toBe(64);
				expect(desk.brandInset).toBeLessThanOrEqual(16);
				expect(desk.fonts).toEqual([HEADER_FONT[lang]]);
				await page.setViewportSize({ width: 390, height: 844 });
				const phone = await headerMetrics(page);
				expect(phone.height).toBe(56);
				expect(phone.brandInset).toBeLessThanOrEqual(12);
				expect(phone.fonts).toEqual([HEADER_FONT[lang]]);
				// one line from 320 to 1440, no links to other sites
				expect(await oneLineProblems(page, `${name} ${lang}`)).toEqual([]);
			});
		}
	}
});

test.describe('Profile header', () => {
	test.setTimeout(90000);

	test('signed out (after a failed sign-in): Sign in in the header, back to this page; the page script runs', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.goto(`${TEST_URLS.profileApp}/?error=access_denied&theme=fawanees`);
		const signIn = page.locator(`${HEADER} .aun-signin`);
		await expect(signIn).toHaveText('Sign in');
		expect(await signIn.getAttribute('href')).toBe(`/login?return=${encodeURIComponent('/?theme=fawanees')}`);
		await expect(page.locator('#loggedOutView')).toBeVisible();
		await expect(page.locator(`${HEADER} .aun-acct-btn`)).toHaveCount(0);
		expect(errors).toEqual([]);
		expect(await headerAxe(page, 'profile signed out')).toEqual([]);
		await page.locator(`${HEADER} .aun-lang`).click();
		await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
		await expect(page.locator(`${HEADER} .aun-lang`)).not.toHaveAttribute('aria-label');
		expect(await headerAxe(page, 'profile signed out ar')).toEqual([]);
		expect(errors).toEqual([]);
	});

	test('signed in: the shared header with the account menu last; language keeps the query; light/dark', async ({ page }) => {
		await register(page, generateTestEmail('header'));
		await page.emulateMedia({ colorScheme: 'dark' });
		await page.goto(`${TEST_URLS.profileApp}/?theme=fawanees`);
		await expect(page.locator('#accountSwitcher')).toBeVisible();
		const expected = ['aun-brand', ...(ENVIRONMENT === 'qa' || ENVIRONMENT === 'stage' ? ['aun-env'] : []), 'aun-lang', 'aun-icon-btn:mode', 'aun-acct-btn'];
		expect(await controls(page)).toEqual(expected);
		// full width, like every app's header: no centred row
		await expect(page.locator(`${HEADER} .aun-header-row`)).toHaveCount(0);
		expect((await page.locator(HEADER).boundingBox())!.width).toBe(page.viewportSize()!.width);
		// the account button too: the contract's typeface, not the page's
		expect((await headerMetrics(page)).fonts).toEqual([HEADER_FONT.en]);
		expect(await oneLineProblems(page, 'profile signed in en')).toEqual([]);
		await page.setViewportSize({ width: 1280, height: 720 });
		expect(await headerAxe(page, 'profile en dark')).toEqual([]);

		const toggle = page.locator(`${HEADER} .aun-mode`);
		await toggle.click();
		expect(await htmlMode(page)).toBe('light');
		await page.reload();
		expect(await htmlMode(page)).toBe('light');
		expect(await headerAxe(page, 'profile en light')).toEqual([]);

		await page.locator(`${HEADER} .aun-lang`).click();
		await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
		const url = new URL(page.url());
		expect(url.searchParams.get('lang')).toBe('ar');
		expect(url.searchParams.get('theme')).toBe('fawanees');
		await expect(page.locator(`${HEADER} .aun-brand-app`)).toHaveText('الحساب');
		expect((await headerMetrics(page)).fonts).toEqual([HEADER_FONT.ar]);
		expect(await oneLineProblems(page, 'profile signed in ar')).toEqual([]);
		await page.setViewportSize({ width: 1280, height: 720 });
		expect(await headerAxe(page, 'profile ar light')).toEqual([]);
	});
});
