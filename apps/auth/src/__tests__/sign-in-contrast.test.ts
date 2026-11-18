/**
 * Design audit of Auth #426 / issue #427: the sign-in card's "or" divider and ghost (secondary)
 * buttons follow the theme's tokens (OpenAuth derived them from the page background: white on a
 * light card, navy on a navy card), the passkey block is inset like the form, and the staff
 * passkey card isolates the email address in Arabic.
 */
import { describe, expect, it } from 'vitest';
import { compileBuiltin } from '../../../../packages/ui/src/auth-theme/builtin.ts';
import { OPENAUTH_FIXED_CSS } from '../../../../packages/ui/src/auth-theme/compile.ts';
import { renderAddPasskeyPage } from '../passkeys/pages';

const BASE = 'https://auth.example';

describe('sign-in card contrast', () => {
	it.each(['fawanees', 'classic'])('%s: divider and ghost buttons use the theme tokens', (id) => {
		const css = compileBuiltin(id, BASE)!.openauth.css;
		expect(css).toContain(OPENAUTH_FIXED_CSS);
		expect(OPENAUTH_FIXED_CSS).toContain('[data-component="divider"]{color:var(--fanous-color-text-secondary');
		expect(OPENAUTH_FIXED_CSS).toContain('border-top-color:var(--fanous-color-outline');
		expect(OPENAUTH_FIXED_CSS).toMatch(/:root \[data-component="button"\]\[data-color="ghost"\]\{background:var\(--fanous-c-button-secondary-bg/);
	});

	it('the passkey block is inset like the form (card content padding)', () => {
		const css = compileBuiltin('fawanees', BASE)!.openauth.css;
		const rule = css.split('\n').find((line) => line.includes('padding-inline') && line.includes('[data-component="form-footer"]'));
		expect(rule).toContain('[data-passkey]');
	});
});

describe('staff passkey card: the code step', () => {
	const page = (locale: 'en' | 'ar') =>
		renderAddPasskeyPage({ locale, mode: 'card', staff: true, needsCode: true, email: 'yusuf.rahman@alummahnow.net', continueUrl: 'https://profile.example/callback', autoContinue: true, lang: locale }).then((r) => r.text());

	it.each(['en', 'ar'] as const)('isolates the email address left to right (%s)', async (locale) => {
		const html = await page(locale);
		expect(html).toContain('<bdi dir="ltr">yusuf.rahman@alummahnow.net</bdi>');
	});

	it('the Arabic sentence keeps its words around the address and ends with its full stop', async () => {
		const html = await page('ar');
		expect(html).toContain('أكّد هويتك أولًا: سنرسل رمزًا إلى <bdi dir="ltr">yusuf.rahman@alummahnow.net</bdi>.');
	});

	it('the code step has its own spacing and the title reads as a heading', async () => {
		const html = await page('en');
		expect(html).toContain('[data-page="passkey"] [data-slot="code"] { display:flex; flex-direction:column; gap:1rem; }');
		expect(html).toContain('[data-page="passkey"] [data-component="title"] { font-size:1.25rem; font-weight:600;');
	});
});
