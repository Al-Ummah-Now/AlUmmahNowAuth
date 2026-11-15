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
