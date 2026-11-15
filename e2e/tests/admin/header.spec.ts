/**
 * The accounts admin's header frame (AlUmmahNow docs/design/NAV.md "Header"), the same as the videos
 * site's: full width, 64px (56px on phones), the drawer toggle first at the inline-start edge as the
 * videos site's 40px round `.aun-icon-btn.aun-menu-btn` with lucide `menu` (in every state: no X, no chevron),
 * one line from 320 to 1440 with no links to other sites (owner, 2026-11-15),
 * and the contract's typeface on every piece of text (system-ui; Noto Naskh Arabic in Arabic),
 * whatever font the theme gives the page. English and Arabic, desktop and phone; axe on the header.
 *
 * Fawanees is asked for with ?theme= (no environment's theme changes).
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAdmin } from '../../fixtures/admin';
import { TEST_URLS, TEST_USERS } from '../../utils/test-data';
import { HEADER, HEADER_FONT, headerAxe, headerMetrics, oneLineProblems } from '../../utils/header-axe';

const url = (lang: 'en' | 'ar') => `${TEST_URLS.adminDashboard}/?theme=fawanees${lang === 'ar' ? '&lang=ar' : ''}`;

/** The visible drawer toggle: its box, its distance from the inline-start edge, and whether it comes first. */
const toggle = (page: Page) =>
	page.locator(HEADER).evaluate((h) => {
		const b = [...h.querySelectorAll<HTMLElement>('[data-testid="nav-drawer-toggle"]')].find((e) => e.getClientRects().length)!;
		const r = b.getBoundingClientRect();
		const rtl = getComputedStyle(h).direction === 'rtl';
		const first = [...h.querySelectorAll('button, a')].find((e) => e.getClientRects().length) === b;
		return {
			w: r.width,
			h: r.height,
			inset: Math.round(rtl ? document.documentElement.clientWidth - r.right : r.left),
			first,
			cls: b.className,
			icon: b.querySelector('svg')?.getAttribute('class'),
			radius: getComputedStyle(b).borderRadius,
		};
	});

test.describe('Accounts admin header frame', () => {
	test.setTimeout(120000);

	for (const lang of ['en', 'ar'] as const) {
		test(`${lang}: full width, 64px / 56px, the videos drawer toggle first, the contract's font`, async ({ page }) => {
			await loginAdmin(page, TEST_USERS.admin().email);
			await page.setViewportSize({ width: 1440, height: 900 });
			await page.goto(url(lang));
			await expect(page.locator('html')).toHaveAttribute('lang', lang);
			await expect(page.locator('[data-shell="sidebar"]')).toBeAttached();

			const desk = await headerMetrics(page);
			expect(desk.height).toBe(64);
			expect(desk.fonts).toEqual([HEADER_FONT[lang]]);
			expect((await page.locator(HEADER).boundingBox())!.width).toBe(1440);
			const t = await toggle(page);
			expect(t).toMatchObject({ w: 40, h: 40, first: true, cls: 'aun-icon-btn aun-menu-btn', icon: 'lucide lucide-menu' });
			expect(t.inset).toBeLessThanOrEqual(16);
			// collapsing the rail keeps the same icon
			await page.locator(`${HEADER} [data-testid="nav-drawer-toggle"]:visible`).click();
			await expect(page.locator(`${HEADER} [data-testid="nav-drawer-toggle"]:visible svg.lucide-menu`)).toBeVisible();
			await page.locator(`${HEADER} [data-testid="nav-drawer-toggle"]:visible`).click();
			expect(await headerAxe(page, `admin ${lang} desktop`)).toEqual([]);

			await page.setViewportSize({ width: 390, height: 844 });
			const phone = await headerMetrics(page);
			expect(phone.height).toBe(56);
			expect(phone.fonts).toEqual([HEADER_FONT[lang]]);
			const p = await toggle(page);
			expect(p).toMatchObject({ w: 40, h: 40, first: true, cls: 'aun-icon-btn aun-menu-btn', icon: 'lucide lucide-menu' });
			expect(p.inset).toBeLessThanOrEqual(12);
			// the open drawer keeps the menu icon (no X), like the videos site
			await page.locator(`${HEADER} [data-testid="nav-drawer-toggle"]:visible`).click();
			await expect(page.locator(`${HEADER} [data-testid="nav-drawer-toggle"]:visible`)).toHaveAttribute('aria-expanded', 'true');
			await expect(page.locator(`${HEADER} [data-testid="nav-drawer-toggle"]:visible svg.lucide-menu`)).toBeVisible();
			expect(await headerAxe(page, `admin ${lang} phone`)).toEqual([]);
			// one line from 320 to 1440 (drawer closed), no links to other sites
			await page.locator(`${HEADER} [data-testid="nav-drawer-toggle"]:visible`).click();
			expect(await oneLineProblems(page, `admin ${lang}`)).toEqual([]);
		});
	}
});
