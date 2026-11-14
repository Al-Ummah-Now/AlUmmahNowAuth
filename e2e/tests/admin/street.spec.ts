/**
 * The Fawanees lantern street in the accounts admin (design: AlUmmahNow
 * docs/design/FAWANEES-STREET.md). It follows the admin's light/dark mode like the profile app:
 * the light street in light mode, the dark street in dark, over the theme's page colour for that mode.
 * The street is pre-made art painted by CSS (a wide image tile repeated behind the page); the server
 * picks one of the theme's 4 tile variants per response and sends it as <html
 * data-fanous-street-variant>; the tiles are static files on the auth origin.
 * Asked for with ?theme=fawanees (no environment's theme changes): the street is on with the
 * server's variant of this mode's tile, only that tile downloads, nothing is see-through; the
 * aun_street_variant cookie pins the variant; with ?theme=lantern there is no street. The per-run
 * admin account is removed by the global teardown.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAdmin } from '../../fixtures/admin';
import { TEST_URLS, TEST_USERS } from '../../utils/test-data';

/** Tile files the page fetches, by file name. */
function watchTiles(page: Page): Set<string> {
	const fetched = new Set<string>();
	page.on('request', (r) => {
		const m = r.url().match(/street-tile[\w-]*\.webp/);
		if (m) fetched.add(m[0]);
	});
	return fetched;
}

/** Translucent controls and text blocks whose backdrop is the page itself. */
function seeThrough(page: Page) {
	return page.evaluate(() => {
		const alpha = (bg: string) => {
			const slash = bg.match(/\/\s*([\d.]+)\)/), rgba = bg.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/);
			return slash ? parseFloat(slash[1]) : rgba ? parseFloat(rgba[1]) : bg === 'transparent' ? 0 : 1;
		};
		const paints = (e: Element) => { const st = getComputedStyle(e); return alpha(st.backgroundColor) === 1 || st.backgroundImage !== 'none' || /^(IMG|VIDEO|CANVAS|PICTURE|IFRAME)$/.test(e.tagName); };
		return Array.from(document.querySelectorAll('main *')).filter((el) => {
			if (el.tagName === 'IMG') return false;
			const r = el.getBoundingClientRect();
			if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) return false;
			const a = alpha(getComputedStyle(el).backgroundColor);
			if (!(a > 0 && a < 1)) return false;
			const stack = document.elementsFromPoint(r.left + r.width / 2, Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)));
			const below = stack.slice(stack.indexOf(el) + 1).filter((e) => !el.contains(e) && e !== document.body && e !== document.documentElement);
			return !below.some(paints);
		}).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 3).join('.')}`);
	});
}

/** The street layer and its variant as the browser computes them. */
function street(page: Page) {
	return page.evaluate(() => {
		const after = getComputedStyle(document.body, '::after');
		return {
			variant: document.documentElement.getAttribute('data-fanous-street-variant'),
			tile: after.content !== 'none' ? after.backgroundImage : 'none',
			repeat: after.backgroundRepeat,
			covers: Math.round(parseFloat(after.height)) >= document.documentElement.scrollHeight - 2,
		};
	});
}

test.describe('Fawanees lantern street in the accounts admin', () => {
	test.setTimeout(120000);

	test("the street follows the mode with the server's tile variant, nothing see-through; a cookie pins it; Lantern has none", async ({ page }) => {
		await loginAdmin(page, TEST_USERS.admin().email);
		const problems: string[] = [];
		for (const mode of ['light', 'dark'] as const) {
			// the admin's saved choice, with the device saying the other mode
			await page.emulateMedia({ colorScheme: mode === 'light' ? 'dark' : 'light' });
			await page.addInitScript((m) => localStorage.setItem('theme', m), mode);
			const fetched = watchTiles(page);
			await page.goto(`${TEST_URLS.adminDashboard}/users?theme=fawanees`);
			await expect(page.locator('a:has-text("Users")').first()).toBeVisible();
			await page.waitForLoadState('networkidle').catch(() => {});
			await expect(page.locator('html'), mode).toHaveClass(/fanous-street/);
			await expect(page.locator('html'), mode).toHaveClass(new RegExp(`\\b${mode}\\b`));
			const s = await street(page);
			expect(s.variant, `${mode}: a variant from the server`).toMatch(/^[1-4]$/);
			expect(s.tile, `${mode}: this mode's tile, the server's variant`).toContain(`/fanous/street/street-tile${mode === 'dark' ? '-dark' : ''}-${s.variant}.webp`);
			expect(s.repeat, mode).toBe('repeat');
			expect(s.covers, `${mode}: down the whole page`).toBe(true);
			expect([...fetched], `${mode}: only the picked variant downloads`).toEqual([`street-tile${mode === 'dark' ? '-dark' : ''}-${s.variant}.webp`]);
			// over the theme's page colour for this mode
			expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(mode === 'light' ? 'rgb(243, 238, 229)' : 'rgb(9, 21, 30)');
			for (const x of await seeThrough(page)) problems.push(`${mode} see-through: ${x}`);
		}
		expect(problems, problems.join('\n')).toEqual([]);

		await page.context().addCookies([{ name: 'aun_street_variant', value: '2', url: TEST_URLS.adminDashboard }]);
		for (let i = 0; i < 3; i++) {
			await page.goto(`${TEST_URLS.adminDashboard}/users?theme=fawanees`);
			await expect(page.locator('html')).toHaveAttribute('data-fanous-street-variant', '2');
		}
		await page.context().clearCookies({ name: 'aun_street_variant' });

		const fetched = watchTiles(page);
		await page.goto(`${TEST_URLS.adminDashboard}/users?theme=lantern`);
		await expect(page.locator('a:has-text("Users")').first()).toBeVisible();
		await page.waitForLoadState('networkidle').catch(() => {});
		await expect(page.locator('html')).not.toHaveClass(/fanous-street/);
		await expect(page.locator('html')).not.toHaveAttribute('data-fanous-street-variant', /.*/);
		expect((await street(page)).tile).toBe('none');
		expect([...fetched]).toEqual([]);
	});
});
