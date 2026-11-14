/**
 * Light and dark in the accounts admin (apps/admin/app/lib/color-mode.ts), the same switch as the
 * videos site: the Sun/Moon button at the foot of the side rail, the choice saved in
 * localStorage `theme`, the device's mode until the first choice, no flash on reload.
 *
 * - toggle → reload keeps the mode, and the saved choice wins over the device;
 * - every admin route renders in light and in dark with the theme's tokens for that mode and no
 *   axe violations (WCAG 2.2 AA);
 * - Arabic (?lang=ar): the shell is RTL, the switch speaks Arabic and still works.
 *
 * Fawanees is asked for with ?theme= (no environment's theme changes). The per-run admin account
 * is removed by the global teardown.
 */
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAdmin } from '../../fixtures/admin';
import { TEST_URLS, TEST_USERS } from '../../utils/test-data';

const ADMIN = TEST_URLS.adminDashboard;
const THEME = 'theme=fawanees';
const url = (path: string, extra = '') => `${ADMIN}${path}${path.includes('?') ? '&' : '?'}${THEME}${extra}`;
// Fawanees page colours (packages/ui/src/auth-theme/themes/fawanees/theme.json)
const PAGE = { light: 'rgb(243, 238, 229)', dark: 'rgb(9, 21, 30)' } as const;

const htmlMode = (page: Page) => page.evaluate(() => (document.documentElement.classList.contains('dark') ? 'dark' : document.documentElement.classList.contains('light') ? 'light' : 'none'));
const bodyBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

async function shell(page: Page) {
	await expect(page.locator('[data-shell="sidebar"]')).toBeAttached();
	await page.waitForLoadState('networkidle').catch(() => {});
}

/** Every admin route with the admin shell; detail pages from the first link on their list. */
async function adminRoutes(page: Page): Promise<string[]> {
	const routes = ['/', '/users', '/roles', '/sessions', '/clients', '/audit', '/moderation', '/themes', '/deleted', '/security'];
	const firstHref = async (list: string, selector: string) => {
		await page.goto(url(list));
		await shell(page);
		const href = await page.locator(selector).first().getAttribute('href').catch(() => null);
		return href ? new URL(href, ADMIN).pathname : null;
	};
	for (const [list, selector] of [
		['/users', 'main a[href*="/passkeys"]'],
		['/roles', 'main a[href^="/roles/"]'],
		['/moderation', 'main a[href^="/moderation/"]'],
		['/themes', 'main a[href^="/themes/"]:not([href$="/export"]):not([href$="/preview"])'],
	] as const) {
		const href = await firstHref(list, selector);
		if (href) routes.push(href);
	}
	return routes;
}

test.describe('Accounts admin: light and dark', () => {
	test.setTimeout(240000);

	test('the switch saves the mode, a reload keeps it, and the choice wins over the device', async ({ page }) => {
		await loginAdmin(page, TEST_USERS.admin().email);
		await page.emulateMedia({ colorScheme: 'dark' });
		await page.goto(url('/'));
		await shell(page);
		await page.evaluate(() => localStorage.removeItem('theme'));
		await page.reload();
		await shell(page);
		// first visit: the device's mode
		expect(await htmlMode(page)).toBe('dark');
		const toggle = page.getByTestId('theme-toggle');
		await expect(toggle).toHaveAttribute('aria-label', 'Switch to light mode');

		await toggle.click();
		expect(await htmlMode(page)).toBe('light');
		await expect(toggle).toHaveAttribute('aria-label', 'Switch to dark mode');
		expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('light');
		await expect.poll(() => bodyBg(page)).toBe(PAGE.light);

		// reload on a dark device: still light, from the first paint (the class is set before any stylesheet)
		await page.reload();
		expect(await page.evaluate(() => document.documentElement.classList.contains('light'))).toBe(true);
		await shell(page);
		expect(await htmlMode(page)).toBe('light');
		expect(await bodyBg(page)).toBe(PAGE.light);
		// the device changing does not undo a choice
		await page.emulateMedia({ colorScheme: 'light' });
		await page.emulateMedia({ colorScheme: 'dark' });
		expect(await htmlMode(page)).toBe('light');

		await toggle.click();
		await page.reload();
		await shell(page);
		expect(await htmlMode(page)).toBe('dark');
		expect(await bodyBg(page)).toBe(PAGE.dark);
		// client navigation keeps it
		await page.locator('[data-shell="sidebar"] a[href^="/users"]').click();
		await expect(page).toHaveURL(/\/users/);
		expect(await htmlMode(page)).toBe('dark');
	});

	test('every admin route renders in light and dark with no axe violations', async ({ page }) => {
		await loginAdmin(page, TEST_USERS.admin().email);
		const routes = await adminRoutes(page);
		const problems: string[] = [];
		for (const mode of ['light', 'dark'] as const) {
			// the device says the other mode: the saved choice must win
			await page.emulateMedia({ colorScheme: mode === 'light' ? 'dark' : 'light' });
			await page.evaluate((m) => localStorage.setItem('theme', m), mode);
			for (const route of routes) {
				await page.goto(url(route));
				await shell(page);
				if ((await htmlMode(page)) !== mode) problems.push(`${route} ${mode}: html is ${await htmlMode(page)}`);
				const bg = await bodyBg(page);
				if (bg !== PAGE[mode]) problems.push(`${route} ${mode}: page colour ${bg}`);
				await expect(page.getByTestId('theme-toggle'), `${route} ${mode}`).toBeAttached();
				const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
				for (const v of result.violations) {
					problems.push(`${route} ${mode}: ${v.id} ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
				}
			}
		}
		expect(problems, problems.join('\n')).toEqual([]);
	});

	test('Arabic: the shell is right to left and the switch speaks Arabic, in both modes', async ({ page }) => {
		await loginAdmin(page, TEST_USERS.admin().email);
		await page.emulateMedia({ colorScheme: 'light' });
		await page.goto(url('/', '&lang=ar'));
		await page.evaluate(() => localStorage.setItem('theme', 'light'));
		await page.reload();
		await shell(page);
		await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
		await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
		const rail = page.locator('[data-shell="sidebar"]');
		await expect(rail.getByRole('link', { name: 'المستخدمون' })).toBeVisible();
		// the rail sits at the inline start: the right edge
		const box = (await rail.boundingBox())!;
		expect(Math.round(box.x + box.width)).toBe(page.viewportSize()!.width);
		const toggle = page.getByTestId('theme-toggle');
		await expect(toggle).toHaveAttribute('aria-label', 'التبديل إلى الوضع الداكن');
		await toggle.click();
		expect(await htmlMode(page)).toBe('dark');
		await expect(toggle).toHaveAttribute('aria-label', 'التبديل إلى الوضع الفاتح');
		// the rail keeps the language across sections
		await rail.getByRole('link', { name: 'المستخدمون' }).click();
		await expect(page).toHaveURL(/\/users\?lang=ar/);
		await shell(page);
		await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
		expect(await htmlMode(page)).toBe('dark');
		for (const mode of ['dark', 'light'] as const) {
			await page.evaluate((m) => localStorage.setItem('theme', m), mode);
			await page.reload();
			await shell(page);
			const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
			expect(result.violations.map((v) => `${mode}: ${v.id}`)).toEqual([]);
		}
	});

	test('phone: the switch is in the drawer', async ({ page }) => {
		await loginAdmin(page, TEST_USERS.admin().email);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(url('/'));
		await shell(page);
		await expect(page.getByTestId('theme-toggle')).toBeHidden();
		await page.getByRole('button', { name: 'Open menu' }).click();
		const toggle = page.getByTestId('theme-toggle');
		await expect(toggle).toBeVisible();
		const before = await htmlMode(page);
		await toggle.click();
		expect(await htmlMode(page)).toBe(before === 'dark' ? 'light' : 'dark');
	});
});
