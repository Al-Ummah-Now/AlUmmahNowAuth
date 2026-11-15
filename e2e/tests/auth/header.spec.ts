/**
 * The shared site header (AlUmmahNow docs/design/NAV.md "Header") on the sign-in pages and the
 * profile app: brand, QA/stage badge (never on production or local dev), Website and Videos,
 * language (keeps the page and query), light/dark (the choice wins over the device, before first
 * paint), then the account menu on the profile, nothing on the sign-in page itself. 64px bar,
 * 56px on phones; no axe violations (WCAG 2.2 AA) in the header in either mode or language.
 *
 * Fawanees is asked for with ?theme= (no environment's theme changes).
 */
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { register } from '../../fixtures/auth';
import { TEST_URLS, generateTestEmail } from '../../utils/test-data';

// Registers with the test password: traces would record it. See e2e/utils/secret-input.ts.
test.use({ trace: 'off' });

const HEADER = '[data-testid="aun-header"]';
const authHost = new URL(TEST_URLS.authServer).hostname;
const ENVIRONMENT = authHost.includes('.qa.') ? 'qa' : authHost.includes('.stage.') ? 'stage' : authHost === 'localhost' ? 'local' : 'production';
const htmlMode = (page: Page) => page.evaluate(() => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'));
/** The header's controls in reading order. */
const controls = (page: Page) =>
	page.locator(`${HEADER} :is(.aun-brand, .aun-env, .aun-apps, .aun-lang, .aun-mode, .aun-acct-btn, .aun-signin)`).evaluateAll((els) =>
		els
			.filter((el) => el.getClientRects().length)
			.map((el) => {
				if (el.classList.contains('aun-mode')) return 'aun-icon-btn:mode';
				return ['aun-brand', 'aun-env', 'aun-apps', 'aun-lang', 'aun-acct-btn', 'aun-signin'].find((c) => el.classList.contains(c))!;
			}),
	);

async function headerAxe(page: Page, label: string): Promise<string[]> {
	const result = await new AxeBuilder({ page }).include(HEADER).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
	return result.violations.map((v) => `${label}: ${v.id} ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

async function openSignIn(page: Page): Promise<void> {
	await page.goto(`${TEST_URLS.profileApp}/?theme=fawanees`);
	await expect(page).toHaveURL(new RegExp(`${TEST_URLS.authServer}/password/authorize`));
	await expect(page.locator(HEADER)).toBeVisible();
}

test.describe('Sign-in header', () => {
	test('brand, badge, app links, language, light/dark; no account control; the card stays centred', async ({ page }) => {
		await page.emulateMedia({ colorScheme: 'dark' });
		await openSignIn(page);
		const expected = ['aun-brand', ...(ENVIRONMENT === 'qa' || ENVIRONMENT === 'stage' ? ['aun-env'] : []), ...(ENVIRONMENT === 'local' ? [] : ['aun-apps']), 'aun-lang', 'aun-icon-btn:mode'];
		expect(await controls(page)).toEqual(expected);
		await expect(page.locator(HEADER).locator('.aun-brand-app')).toHaveText('Account');
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

	test('phone: a 56px bar, the app links leave it, language and light/dark stay', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await openSignIn(page);
		expect((await page.locator(HEADER).boundingBox())!.height).toBe(56);
		await expect(page.locator(`${HEADER} .aun-apps`)).toBeHidden();
		await expect(page.locator(`${HEADER} .aun-lang`)).toBeVisible();
		await expect(page.locator(`${HEADER} .aun-mode`)).toBeVisible();
		const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
		expect(scrollWidth).toBeLessThanOrEqual(390);
		expect(await headerAxe(page, 'phone')).toEqual([]);
	});
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
	});

	test('signed in: the shared header with the account menu last; language keeps the query; light/dark', async ({ page }) => {
		await register(page, generateTestEmail('header'));
		await page.emulateMedia({ colorScheme: 'dark' });
		await page.goto(`${TEST_URLS.profileApp}/?theme=fawanees`);
		await expect(page.locator('#accountSwitcher')).toBeVisible();
		const expected = ['aun-brand', ...(ENVIRONMENT === 'qa' || ENVIRONMENT === 'stage' ? ['aun-env'] : []), ...(ENVIRONMENT === 'local' ? [] : ['aun-apps']), 'aun-lang', 'aun-icon-btn:mode', 'aun-acct-btn'];
		expect(await controls(page)).toEqual(expected);
		// the centred row (aun-nav.css .aun-header-row) is the bar's 64px; the bar adds its 1px bottom border
		expect((await page.locator(`${HEADER} .aun-header-row`).boundingBox())!.height).toBe(64);
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
		expect(await headerAxe(page, 'profile ar light')).toEqual([]);
	});
});
