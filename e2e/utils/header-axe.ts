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
	ar: '"Noto Naskh Arabic", "Geeza Pro", "Segoe UI", Tahoma, sans-serif',
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
