/**
 * The Fawanees lantern street in the accounts admin (design: AlUmmahNow
 * docs/design/FAWANEES-STREET.md). It follows the admin's light/dark mode like the profile app:
 * the light street in light mode, the dark street in dark, over the theme's page colour for that mode.
 * Asked for with ?theme=fawanees (no environment's theme changes): the street is on, garlands hang
 * in the page's gaps, every lantern on screen is drawn whole, nothing is see-through; with
 * ?theme=lantern there is no street. The per-run admin account is removed by the global teardown.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAdmin } from '../../fixtures/admin';
import { TEST_URLS, TEST_USERS } from '../../utils/test-data';

const STILL = '*:not(html),*::before,*::after{transition:none!important;animation-duration:0s!important;animation-delay:0s!important}';

async function settle(page: Page): Promise<void> {
	await page.waitForTimeout(400);
	// The module measures when the browser is idle: wait for its drawing when the theme switches the street on
	await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--fanous-street-on').trim() !== '1' || !!document.getElementById('fanous-street'), undefined, { timeout: 5000 }).catch(() => {});
	let last = '';
	for (let i = 0; i < 20; i++) {
		const now = await page.evaluate(() => `${document.documentElement.className}:${document.getElementById('fanous-street')?.innerHTML.length}:${document.documentElement.scrollHeight}`);
		if (now === last) return;
		last = now;
		await page.waitForTimeout(350);
	}
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

/** Lanterns on screen drawn less than 85% of their height (the screen with and without the street). */
async function cutLanterns(page: Page): Promise<{ inView: number; cut: string[] }> {
	const boxes = await page.evaluate(() => {
		const chrome = Array.from(document.querySelectorAll('body *')).filter((e) => !e.closest('#fanous-street, #fanous-street-lights') && ['fixed', 'sticky'].includes(getComputedStyle(e).position))
			.map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight);
		const hit = (b: { x: number; y: number; w: number; h: number }) => chrome.some((r) => b.x < r.right && b.x + b.w > r.left && b.y < r.bottom && b.y + b.h > r.top);
		return Array.from(document.querySelectorAll('#fanous-street .fs-l use')).map((u) => { const r = u.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })
			.filter((b) => b.y >= 0 && b.y + b.h <= innerHeight && b.x >= 0 && b.x + b.w <= innerWidth && !hit(b));
	});
	if (!boxes.length) return { inView: 0, cut: [] };
	const on = (await page.screenshot()).toString('base64');
	await page.evaluate(() => { document.getElementById('fanous-street')!.style.visibility = 'hidden'; });
	const off = (await page.screenshot()).toString('base64');
	await page.evaluate(() => { document.getElementById('fanous-street')!.style.visibility = ''; });
	const cut = await page.evaluate(async ({ on, off, boxes }) => {
		const load = (b: string) => new Promise<HTMLImageElement>((res) => { const i = new Image(); i.onload = () => res(i); i.src = `data:image/png;base64,${b}`; });
		const [a, b] = await Promise.all([load(on), load(off)]);
		const px = (img: HTMLImageElement) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d')!; g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
		const A = px(a), B = px(b), W = a.width, k = a.width / innerWidth;
		const out: string[] = [];
		for (const bx of boxes) {
			const x0 = Math.round(bx.x * k), x1 = Math.round((bx.x + bx.w) * k), y0 = Math.round(bx.y * k), y1 = Math.round((bx.y + bx.h) * k);
			let rows = 0;
			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) { const i = (y * W + x) * 4; if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 18) { rows++; break; } }
			}
			if (rows / (y1 - y0) < 0.85) out.push(`lantern at ${Math.round(bx.x)},${Math.round(bx.y)}: ${Math.round((100 * rows) / (y1 - y0))}% drawn`);
		}
		return out;
	}, { on, off, boxes });
	return { inView: boxes.length, cut };
}

test.describe('Fawanees lantern street in the accounts admin', () => {
	test.setTimeout(120000);

	test('the street follows the mode, whole lanterns, nothing see-through; Lantern has none', async ({ page }) => {
		await loginAdmin(page, TEST_USERS.admin().email);
		const problems: string[] = [];
		const lines: Record<string, string> = {};
		for (const mode of ['light', 'dark'] as const) {
			// the admin's saved choice, with the device saying the other mode
			await page.emulateMedia({ colorScheme: mode === 'light' ? 'dark' : 'light' });
			await page.addInitScript((m) => localStorage.setItem('theme', m), mode);
			await page.goto(`${TEST_URLS.adminDashboard}/users?theme=fawanees`);
			await expect(page.locator('a:has-text("Users")').first()).toBeVisible();
			await page.addStyleTag({ content: STILL });
			await settle(page);
			await expect(page.locator('html'), mode).toHaveClass(/fanous-street/);
			await expect(page.locator('html'), mode).toHaveClass(new RegExp(`\\b${mode}\\b`));
			// the street of this mode (Fawanees dark line #f5cf9242), over the theme's page colour for it
			lines[mode] = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fanous-street-line').trim());
			expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(mode === 'light' ? 'rgb(243, 238, 229)' : 'rgb(9, 21, 30)');
			for (const s of await seeThrough(page)) problems.push(`${mode} see-through: ${s}`);
			const l = await cutLanterns(page);
			for (const c of l.cut) problems.push(`${mode} ${c}`);
			expect(await page.locator('#fanous-street .fs-l').count(), `${mode}: lanterns on the page`).toBeGreaterThan(0);
		}
		expect(problems, problems.join('\n')).toEqual([]);
		expect(lines.dark).toBe('#f5cf9242');
		expect(lines.light).not.toBe(lines.dark);

		await page.goto(`${TEST_URLS.adminDashboard}/users?theme=lantern`);
		await expect(page.locator('a:has-text("Users")').first()).toBeVisible();
		await settle(page);
		await expect(page.locator('html')).not.toHaveClass(/fanous-street/);
		await expect(page.locator('#fanous-street')).toHaveCount(0);
	});
});
