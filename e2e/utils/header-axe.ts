import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

/** The shared site header (AlUmmahNow docs/design/NAV.md "Header") on every app. */
export const HEADER = '[data-testid="aun-header"]';

/**
 * axe (WCAG 2.2 AA) on the header only, plus `label-content-name-mismatch`: an experimental rule
 * the WCAG tags never run. It catches an aria-label that doesn't contain the visible text (the
 * language button once said "Switch to English" over "English"; the shared langButtonHtml
 * contract is a hidden "Switch to …: " before the visible label, no aria-label). Run it in both
 * languages. Returns one line per violation, labelled.
 */
export async function headerAxe(page: Page, label: string): Promise<string[]> {
	const result = await new AxeBuilder({ page })
		.include(HEADER)
		// options() replaces every option set before it, so it goes before withTags()
		.options({ rules: { 'label-content-name-mismatch': { enabled: true } } })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
		.analyze();
	return result.violations.map((v) => `${label}: ${v.id} ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

/** The contract's typeface (aun-nav.css .aun-header), the same in every app's header whatever the page uses. */
export const HEADER_FONT = {
	en: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
	ar: '"Noto Naskh Arabic", "Geeza Pro", system-ui, "Segoe UI", Tahoma, sans-serif',
} as const;

/**
 * The header's layout and type, as every app must draw it (NAV.md "Header"): its height, the
 * brand's distance from the inline-start edge (full width, never centred), and every distinct
 * font-family on the header and its text (icons aside).
 */
export async function headerMetrics(page: Page): Promise<{ height: number; brandInset: number; fonts: string[] }> {
	return page.locator(HEADER).evaluate((h) => {
		const brand = h.querySelector('.aun-brand')!.getBoundingClientRect();
		const rtl = getComputedStyle(h).direction === 'rtl';
		const fonts = new Set<string>();
		for (const el of [h, ...h.querySelectorAll('*')]) {
			if (el.closest('svg') || !el.getClientRects().length) continue;
			fonts.add(getComputedStyle(el).fontFamily);
		}
		return {
			height: h.getBoundingClientRect().height,
			brandInset: Math.round(rtl ? document.documentElement.clientWidth - brand.right : brand.left),
			fonts: [...fonts],
		};
	});
}

/** The widths the header must hold one line at (NAV.md "Header": 320 to 1440). */
export const ONE_LINE_WIDTHS = [320, 360, 390, 414, 480, 640, 768, 1024, 1280, 1440] as const;

/**
 * One 64px line (56px below 640px) at every width from 320 to 1440: every visible control sits in
 * the bar (none wraps below it), nothing scrolls sideways, and no link to another site is in the
 * bar (owner, 2026-11-15: the other apps are in the account menu). Returns one line per problem.
 */
export async function oneLineProblems(page: Page, label: string): Promise<string[]> {
	const problems: string[] = [];
	const height = page.viewportSize()?.height ?? 900;
	for (const width of ONE_LINE_WIDTHS) {
		await page.setViewportSize({ width, height });
		const r = await page.locator(HEADER).evaluate((h) => {
			const bar = h.getBoundingClientRect();
			const out: string[] = [];
			for (const el of h.querySelectorAll<HTMLElement>('.aun-brand, .aun-env, .aun-lang, .aun-mode, .aun-acct-btn, .aun-signin, .aun-icon-btn')) {
				const b = el.getBoundingClientRect();
				if (!b.width || getComputedStyle(el).visibility === 'hidden' || el.closest('[hidden], .aun-menu')) continue;
				if (b.top < bar.top - 0.5 || b.bottom > bar.bottom + 0.5) out.push(`${el.className} outside the bar`);
				if (b.left < -0.5 || b.right > document.documentElement.clientWidth + 0.5) out.push(`${el.className} off screen`);
			}
			const sites = h.querySelectorAll('.aun-apps, .aun-app').length;
			if (sites) out.push(`${sites} links to other sites`);
			if (document.documentElement.scrollWidth > document.documentElement.clientWidth) out.push('scrolls sideways');
			return { height: bar.height, out };
		});
		const want = width < 640 ? 56 : 64;
		if (r.height !== want) problems.push(`${label} ${width}px: ${r.height}px tall, not ${want}`);
		for (const o of r.out) problems.push(`${label} ${width}px: ${o}`);
	}
	return problems;
}
