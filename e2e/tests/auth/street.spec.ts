/**
 * The Fawanees lantern street on Auth's pages (the shared street module, vendored by
 * scripts/themes/sync-fanous-street.ts; design: AlUmmahNow docs/design/FAWANEES-STREET.md).
 * The street is pre-made art painted by CSS: a wide image tile of strings and lit lanterns,
 * repeated behind the whole page (it wraps both ways, shown at 2x) over the distant lights. The
 * theme gives 4 tile variants per scheme; the server picks one per response and sends it as
 * <html data-fanous-street-variant> (no inline script). The built-in tiles are static files on the
 * auth origin (/fanous/street/<file>), which the profile page loads too.
 * Asked for with ?theme=fawanees (no environment's theme changes), light and dark (the device's
 * colour scheme), English and Arabic, on the sign-in page and the profile page:
 *   - the street is on, shows the server's variant of this scheme's tile, repeated, centred, at its
 *     own size, down the whole page, and no other variant is fetched; the tile files are served;
 *   - no control or text block is see-through (the street must never show through one);
 * the HTML names a variant, random per request and pinned by the aun_street_variant cookie; the
 * other themes have no street and fetch no tile; the street adds no element and runs no animation.
 * Read-only: nothing is created, so there is nothing to clean up.
 */
import { test, expect, type Page } from '@playwright/test';
import { TEST_URLS } from '../../utils/test-data';

const MODES = ['light', 'dark'] as const;
const LANGS = ['en', 'ar'] as const;
const OTHER_THEMES = ['classic', 'lantern', 'nahas', 'zujaj'];
const TILE = /street-tile(-dark)?-([1-4])\.webp/;

/** The sign-in page URL for a theme, through the profile app's real /authorize redirect. */
async function signInUrl(page: Page, theme: string, lang: string): Promise<string> {
	let authorize = '';
	const watch = (r: { url(): string }) => {
		if (!authorize && r.url().startsWith(`${TEST_URLS.authServer}/authorize`)) authorize = r.url();
	};
	page.on('request', watch);
	await page.goto(TEST_URLS.profileApp);
	await expect(page).toHaveURL(new RegExp(`${TEST_URLS.authServer}/password/authorize`));
	page.off('request', watch);
	expect(authorize).not.toBe('');
	const u = new URL(authorize);
	u.searchParams.set('theme', theme);
	u.searchParams.set('lang', lang);
	return u.toString();
}

/** The profile page signed out (?error= renders it instead of redirecting into sign-in). */
const profileUrl = (theme: string, lang: string) => `${TEST_URLS.profileApp}/?error=street-check&theme=${theme}&lang=${lang}`;

async function openProfile(page: Page, theme: string, lang: string): Promise<void> {
	await page.goto(profileUrl(theme, lang));
	await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

/** Tile files the page fetches, by file name. */
function watchTiles(page: Page): Set<string> {
	const fetched = new Set<string>();
	page.on('request', (r) => {
		const m = r.url().match(/street-tile[\w-]*\.webp/);
		if (m) fetched.add(m[0]);
	});
	return fetched;
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

/** The street's two layers as the browser computes them. */
function layers(page: Page) {
	return page.evaluate(() => {
		const before = getComputedStyle(document.body, '::before'), after = getComputedStyle(document.body, '::after');
		return {
			variant: document.documentElement.getAttribute('data-fanous-street-variant'),
			lights: before.content !== 'none' ? before.backgroundImage : 'none',
			street: after.content !== 'none' ? after.backgroundImage : 'none',
			repeat: after.backgroundRepeat,
			at: after.backgroundPosition,
			size: after.backgroundSize,
			position: after.position,
			covers: Math.round(parseFloat(after.height)) >= document.documentElement.scrollHeight - 2,
			body: getComputedStyle(document.body).backgroundColor,
		};
	});
}

/** One page in both schemes: the server's variant of each scheme's tile, painted right, nothing see-through. */
async function checkStreet(page: Page, where: string, open: () => Promise<void>): Promise<void> {
	const problems: string[] = [];
	for (const mode of MODES) {
		// leave the last page first: switching the scheme under it would fetch that page's other tile
		await page.goto('about:blank');
		await page.emulateMedia({ colorScheme: mode });
		const fetched = watchTiles(page);
		await open();
		await page.waitForLoadState('networkidle').catch(() => {});
		await expect(page.locator('html'), `${where} ${mode}`).toHaveClass(/fanous-street/);
		const l = await layers(page);
		expect(l.variant, `${where} ${mode}: a variant from the server`).toMatch(/^[1-4]$/);
		expect(l.street, `${where} ${mode}: street tile`).toMatch(TILE);
		expect(l.street.includes('-dark-'), `${where} ${mode}: the ${mode} tile`).toBe(mode === 'dark');
		expect(l.street, `${where} ${mode}: the server's variant`).toContain(`-${l.variant}.webp`);
		expect(l.street, `${where} ${mode}: from the auth origin`).toContain(`${TEST_URLS.authServer}/fanous/street/`);
		expect(l.lights, `${where} ${mode}: distant lights`).toMatch(/url\(/);
		expect(l.repeat, `${where} ${mode}: repeated both ways`).toBe('repeat');
		expect(l.at, `${where} ${mode}: centred`).toMatch(/^50% 0(%|px)?$/);
		expect(l.size, `${where} ${mode}: at the tile's own size`).toBe('auto');
		expect(l.position, `${where} ${mode}: scrolls with the page`).toBe('absolute');
		expect(l.covers, `${where} ${mode}: down the whole page`).toBe(true);
		// the page keeps its own flat, opaque page colour on the body (the street paints above it)
		expect(l.body, `${where} ${mode}: body`).toMatch(/^rgb\(/);
		expect([...fetched], `${where} ${mode}: only the picked variant downloads`).toEqual([l.street.match(/street-tile[\w-]*\.webp/)![0]]);
		for (const f of fetched) {
			const res = await page.request.get(`${TEST_URLS.authServer}/fanous/street/${f}`);
			expect(res.status(), f).toBe(200);
			expect(res.headers()['content-type'], f).toContain('image/webp');
		}
		for (const s of await seeThrough(page)) problems.push(`${where} ${mode} see-through: ${s}`);
	}
	expect(problems, problems.join('\n')).toEqual([]);
}

/** The variant named in a page's HTML (undefined when there is none). */
async function variantIn(page: Page, url: string): Promise<string | undefined> {
	const html = await (await page.request.get(url, { headers: { Accept: 'text/html' } })).text();
	expect(html).not.toContain('__AUN_STREET_VARIANT__');
	return /<html[^>]*\sdata-fanous-street-variant="([^"]*)"/.exec(html)?.[1];
}

test.describe('Fawanees lantern street', () => {
	test.setTimeout(120000);

	for (const lang of LANGS) {
		test(`sign-in (${lang}): the server's tile variant in light and dark, repeated not stretched; nothing see-through`, async ({ page }) => {
			const url = await signInUrl(page, 'fawanees', lang);
			await checkStreet(page, `sign-in ${lang}`, async () => {
				await page.goto(url);
				await expect(page.locator('html')).toHaveAttribute('data-theme', 'fawanees');
			});
		});

		test(`profile (${lang}): the server's tile variant in light and dark, repeated not stretched; nothing see-through`, async ({ page }) => {
			await checkStreet(page, `profile ${lang}`, () => openProfile(page, 'fawanees', lang));
		});
	}

	test('the HTML names a variant: random per request, pinned by the aun_street_variant cookie, no inline picker', async ({ page }) => {
		const signIn = await signInUrl(page, 'fawanees', 'en');
		for (const url of [signIn, profileUrl('fawanees', 'en')]) {
			const seen = new Set<string | undefined>();
			for (let i = 0; i < 16 && seen.size < 2; i++) seen.add(await variantIn(page, url));
			expect([...seen].every((v) => v !== undefined && /^[1-4]$/.test(v)), `${url}: ${[...seen].join(', ')}`).toBe(true);
			expect(seen.size, `${url}: requests get different variants`).toBeGreaterThan(1);
		}
		for (const origin of [TEST_URLS.authServer, TEST_URLS.profileApp]) await page.context().addCookies([{ name: 'aun_street_variant', value: '3', url: origin }]);
		for (const url of [signIn, profileUrl('fawanees', 'en')]) for (let i = 0; i < 3; i++) expect(await variantIn(page, url), url).toBe('3');
		await page.goto('about:blank');
		await page.emulateMedia({ colorScheme: 'dark' });
		const fetched = watchTiles(page);
		await openProfile(page, 'fawanees', 'en');
		await page.waitForLoadState('networkidle').catch(() => {});
		expect([...fetched]).toEqual(['street-tile-dark-3.webp']);
		await page.context().clearCookies({ name: 'aun_street_variant' });
	});

	test('the other themes have no street and fetch no tile; the street adds no element and runs no animation', async ({ page }) => {
		for (const theme of OTHER_THEMES) {
			// (the profile page that redirects into sign-in has Fawanees' street: watch from the sign-in page on)
			const url = await signInUrl(page, theme, 'en');
			await page.goto('about:blank');
			const fetched = watchTiles(page);
			await page.goto(url);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			for (const mode of MODES) {
				await page.emulateMedia({ colorScheme: mode });
				await expect(page.locator('html'), `${theme} ${mode}`).not.toHaveClass(/fanous-street/);
				expect((await layers(page)).street, `${theme} ${mode}`).toBe('none');
			}
			// the page loads neither the module nor a tile, and names no variant
			await expect(page.locator('script[data-fanous-street]')).toHaveCount(0);
			await expect(page.locator('html')).not.toHaveAttribute('data-fanous-street-variant', /.*/);
			expect([...fetched], theme).toEqual([]);
		}
		await openProfile(page, 'fawanees', 'en');
		await expect(page.locator('html')).toHaveClass(/fanous-street/);
		await expect(page.locator('#fanous-street, #fanous-street-lights')).toHaveCount(0);
		const ours = await page.evaluate(() => document.getAnimations().filter((a) => {
			const t = (a.effect as KeyframeEffect | null)?.target;
			return t === document.documentElement || t === document.body;
		}).length);
		expect(ours, 'the street runs no animations').toBe(0);
	});
});
