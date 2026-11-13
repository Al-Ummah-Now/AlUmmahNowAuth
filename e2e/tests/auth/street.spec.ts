/**
 * The Fawanees lantern street on Auth's pages (the shared street module, vendored by
 * scripts/themes/sync-fanous-street.ts; design: AlUmmahNow docs/design/FAWANEES-STREET.md).
 * Asked for with ?theme=fawanees (no environment's theme changes), light and dark (the device's
 * colour scheme), English and Arabic, on the sign-in page and the profile page:
 *   - the street is on (html.fanous-street: the module ran under the pages' own CSP);
 *   - no control or text block is see-through (the street must never show through one);
 *   - every lantern on screen is drawn whole (the screen with and without the street, compared
 *     by pixels: a lantern drawn less than 85% of its height is cut by something in front of it);
 *   - garlands hang in the gaps around the sign-in card;
 * the other themes draw no street; and with reduced motion the distant lights stand still.
 * Read-only: nothing is created, so there is nothing to clean up.
 */
import { test, expect, type Page } from '@playwright/test';
import { TEST_URLS } from '../../utils/test-data';

const MODES = ['light', 'dark'] as const;
const LANGS = ['en', 'ar'] as const;
const OTHER_THEMES = ['classic', 'lantern', 'nahas', 'zujaj'];
// Transitions and time-based animations off; the root's scroll-driven animation stays
const STILL = '*:not(html),*::before,*::after{transition:none!important;animation-duration:0s!important;animation-delay:0s!important}';

/** The sign-in page for a theme, through the profile app's real /authorize redirect. */
async function openSignIn(page: Page, theme: string, lang: string): Promise<void> {
	let authorize = '';
	page.on('request', (r) => {
		if (!authorize && r.url().startsWith(`${TEST_URLS.authServer}/authorize`)) authorize = r.url();
	});
	await page.goto(TEST_URLS.profileApp);
	await expect(page).toHaveURL(new RegExp(`${TEST_URLS.authServer}/password/authorize`));
	expect(authorize).not.toBe('');
	const u = new URL(authorize);
	u.searchParams.set('theme', theme);
	u.searchParams.set('lang', lang);
	await page.goto(u.toString());
	await expect(page).toHaveURL(/\/password\/authorize/);
	await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
	await page.addStyleTag({ content: STILL });
}

/** The profile page signed out (?error= renders it instead of redirecting into sign-in). */
async function openProfile(page: Page, theme: string, lang: string): Promise<void> {
	await page.goto(`${TEST_URLS.profileApp}/?error=street-check&theme=${theme}&lang=${lang}`);
	await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
	await page.addStyleTag({ content: STILL });
}

/** Waits until the module has drawn for the current scheme and stopped re-measuring. */
async function settle(page: Page): Promise<void> {
	await page.waitForTimeout(400);
	await page.waitForFunction(() => document.documentElement.classList.contains('fanous-street') === (getComputedStyle(document.documentElement).getPropertyValue('--fanous-street-on').trim() === '1'));
	let last = '';
	for (let i = 0; i < 20; i++) {
		const now = await page.evaluate(() => `${document.getElementById('fanous-street')?.innerHTML.length}:${document.documentElement.scrollHeight}`);
		if (now === last) return;
		last = now;
		await page.waitForTimeout(350);
	}
}

/** Translucent controls and text blocks whose backdrop is the page itself (the street would show through). */
function seeThrough(page: Page) {
	return page.evaluate(() => {
		const alpha = (bg: string) => {
			const slash = bg.match(/\/\s*([\d.]+)\)/), rgba = bg.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/);
			return slash ? parseFloat(slash[1]) : rgba ? parseFloat(rgba[1]) : bg === 'transparent' ? 0 : 1;
		};
		const paints = (e: Element) => {
			const st = getComputedStyle(e);
			return alpha(st.backgroundColor) === 1 || st.backgroundImage !== 'none' || /^(IMG|VIDEO|CANVAS|PICTURE|IFRAME)$/.test(e.tagName);
		};
		return Array.from(document.querySelectorAll('body *')).filter((el) => {
			if (el.tagName === 'IMG' || el.closest('#fanous-street')) return false;
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

/** Lanterns fully inside the window, and those drawn less than 85% of their height (cut by something in front). */
async function lanterns(page: Page): Promise<{ inView: number; cut: string[] }> {
	const boxes = await page.evaluate(() => {
		const chrome = Array.from(document.querySelectorAll('body *')).filter((e) => !e.closest('#fanous-street') && ['fixed', 'sticky'].includes(getComputedStyle(e).position))
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

/** Every mode on one open page: street on, nothing see-through, whole lanterns. */
async function checkStreet(page: Page, where: string): Promise<{ problems: string[]; inView: Record<string, number> }> {
	const problems: string[] = [];
	const inView: Record<string, number> = {};
	for (const mode of MODES) {
		await page.emulateMedia({ colorScheme: mode });
		await settle(page);
		await expect(page.locator('html'), `${where} ${mode}`).toHaveClass(/fanous-street/);
		for (const s of await seeThrough(page)) problems.push(`${where} ${mode} see-through: ${s}`);
		const l = await lanterns(page);
		inView[mode] = l.inView;
		for (const c of l.cut) problems.push(`${where} ${mode} ${c}`);
	}
	return { problems, inView };
}

test.describe('Fawanees lantern street', () => {
	test.setTimeout(120000);

	for (const lang of LANGS) {
		test(`sign-in (${lang}): street on in light and dark, nothing see-through, whole lanterns around the card`, async ({ page }) => {
			await openSignIn(page, 'fawanees', lang);
			const { problems, inView } = await checkStreet(page, `sign-in ${lang}`);
			expect(problems, problems.join('\n')).toEqual([]);
			// the card is centred with room around it: garlands hang there, on screen
			for (const mode of MODES) expect(inView[mode], `sign-in ${lang} ${mode}: lanterns on screen`).toBeGreaterThan(0);
		});

		test(`profile (${lang}): street on in light and dark, nothing see-through, whole lanterns`, async ({ page }) => {
			await openProfile(page, 'fawanees', lang);
			const { problems } = await checkStreet(page, `profile ${lang}`);
			expect(problems, problems.join('\n')).toEqual([]);
		});
	}

	test('the other themes draw no street', async ({ page }) => {
		for (const theme of OTHER_THEMES) {
			await openSignIn(page, theme, 'en');
			for (const mode of MODES) {
				await page.emulateMedia({ colorScheme: mode });
				await settle(page);
				await expect(page.locator('html'), `${theme} ${mode}`).not.toHaveClass(/fanous-street/);
				await expect(page.locator('#fanous-street'), `${theme} ${mode}`).toHaveCount(0);
			}
			// and the page does not load the module at all
			await expect(page.locator('script[data-fanous-street]')).toHaveCount(0);
		}
	});

	for (const motion of ['reduce', 'no-preference'] as const) {
		test(`distant lights ${motion === 'reduce' ? 'stand still with reduced motion' : 'move at 0.2x the scroll'}`, async ({ browser }) => {
			// A short window so the profile page scrolls
			const context = await browser.newContext({ reducedMotion: motion, viewport: { width: 1280, height: 400 }, colorScheme: 'light' });
			const page = await context.newPage();
			await openProfile(page, 'fawanees', 'en');
			await settle(page);
			await expect(page.locator('html')).toHaveClass(/fanous-street/);
			const pos = () => page.evaluate(() => getComputedStyle(document.documentElement).backgroundPositionY.split(',')[0].trim());
			const sway = () => page.evaluate(() => { const g = document.querySelector('#fanous-street .fs-l'); return g ? getComputedStyle(g).animationName : 'none'; });
			expect(await pos()).toBe('0px');
			const y = await page.evaluate(() => Math.min(300, document.documentElement.scrollHeight - innerHeight));
			expect(y, 'the page scrolls').toBeGreaterThanOrEqual(100);
			await page.evaluate((to) => window.scrollTo(0, to), y);
			await page.waitForTimeout(300);
			if (motion === 'reduce') {
				expect(await pos()).toBe('0px');
				expect(await sway()).toBe('none');
			} else {
				expect(await pos()).toBe(`${-y * 0.2}px`);
			}
			await context.close();
		});
	}
});
