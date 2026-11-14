/**
 * The add-a-passkey page (passkeys/pages.ts): the staff card's three steps,
 * which action is the filled accent button, what the skip button says (and
 * when there is none), en/ar, escaping, and that the page script is valid JS.
 *
 * Owner report 2026-11-14: in Fawanees dark "Email me a code" and "Continue"
 * were dark on dark, and nothing said the passkey prompt (where 1Password
 * offers to save it) only comes after the emailed code.
 */
import { describe, expect, it } from 'vitest';
import { renderAddPasskeyPage, skipLabel, type AddPasskeyPage } from '../passkeys/pages';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const GRACE = Math.floor(Date.UTC(2026, 10, 21, 12, 0, 0) / 1000);

function page(over: Partial<AddPasskeyPage> = {}): AddPasskeyPage {
	return {
		locale: 'en',
		mode: 'card',
		staff: true,
		graceUntil: GRACE,
		needsCode: true,
		email: 'staff@example.com',
		continueUrl: 'http://localhost:3302/callback?code=abc',
		lang: 'en',
		now: NOW,
		...over,
	};
}

async function html(over: Partial<AddPasskeyPage> = {}) {
	return (await renderAddPasskeyPage(page(over))).text();
}

/** The page without its <style> and <script> (their selectors name the same slots). */
const markup = (source: string) => source.replace(/<(script|style)\b[\s\S]*?<\/\1>/g, '');

/** The `<button …>label</button>` whose attributes contain `attr`. */
function button(source: string, attr: string): string | undefined {
	return source.match(new RegExp(`<button[^>]*${attr.replace(/[[\]"]/g, '\\$&')}[^>]*>[^<]*</button>`))?.[0];
}

/** The inline page script (the last <script> on the page). */
function script(source: string): string {
	const all = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)];
	return all[all.length - 1]![1]!;
}

describe('skipLabel', () => {
	it('members: Not now', () => {
		expect(skipLabel({ mode: 'card', staff: false, locale: 'en', now: NOW })).toBe('Not now');
	});
	it('staff in the grace period: says until when the password works', () => {
		expect(skipLabel({ mode: 'card', staff: true, graceUntil: GRACE, locale: 'en', now: NOW })).toBe('Not now, use my password until 21 November 2026');
		expect(skipLabel({ mode: 'card', staff: true, graceUntil: GRACE, locale: 'ar', now: NOW })).toMatch(/^ليس الآن، سأستخدم كلمة المرور حتى /);
	});
	it('staff with enforcement off: the password keeps working', () => {
		expect(skipLabel({ mode: 'card', staff: true, locale: 'en', now: NOW })).toBe('Not now, keep using my password');
	});
	it('staff past the deadline: no skip', () => {
		expect(skipLabel({ mode: 'card', staff: true, graceUntil: Math.floor(NOW / 1000) - 1, locale: 'en', now: NOW })).toBeNull();
	});
	it('/passkeys/setup: Back', () => {
		expect(skipLabel({ mode: 'setup', staff: true, graceUntil: GRACE, locale: 'en', now: NOW })).toBe('Back');
	});
});

describe('renderAddPasskeyPage: the staff card', () => {
	it('is three numbered steps, the first current', async () => {
		const h = await html();
		expect(h).toContain('<ol data-slot="steps" aria-label="Steps">');
		expect(h).toMatch(/<li data-step="1" data-state="current" aria-current="step">[\s\S]*Confirm it is you/);
		expect(h).toMatch(/<li data-step="2" data-state="todo" >[\s\S]*Enter the code/);
		expect(h).toMatch(/<li data-step="3" data-state="todo" >[\s\S]*Add the passkey/);
		// Step 3 tells the user their password manager or device will ask to save it
		expect(h).toContain('Your password manager or device will ask to save the passkey.');
		expect(h).toContain('We will email a 6-digit code to <bdi dir="ltr">staff@example.com</bdi>.');
	});

	it('each step has one filled accent button; the skip is outlined and says what it does', async () => {
		const h = await html();
		for (const action of ['data-action="send-code"', 'data-action="confirm-code"', 'data-action="add"', 'data-action="done"']) {
			const b = button(h, action);
			expect(b, action).toBeDefined();
			expect(b, action).toContain('data-component="button"');
			expect(b, action).not.toContain('data-color');
		}
		expect(button(h, 'data-action="skip"')).toBe(
			'<button type="button" data-component="button" data-color="ghost" data-action="skip">Not now, use my password until 21 November 2026</button>'
		);
		// The outlined style: a visible border from the text colour, never the theme's dark-on-dark ghost
		expect(h).toContain('[data-component="button"][data-color="ghost"] { background:transparent; color:inherit; border:1px solid color-mix(in srgb, currentColor 55%, transparent);');
		// "Send a new code" is a link-style action, not a third button
		expect(h).toContain('<button type="button" data-variant="link" data-action="resend-code">Send a new code</button>');
		// No grace line above the steps in the card: the skip button carries the date
		expect(h).not.toContain('you can still use your password');
	});

	it('no skip at all once the grace period is over', async () => {
		const h = markup(await html({ graceUntil: Math.floor(NOW / 1000) - 60 }));
		expect(h).toContain('data-action="send-code"');
		expect(h).not.toContain('data-action="skip"');
		expect(h).not.toContain('data-slot="secondary"');
	});

	it('the code field: numeric one-time code, left to right', async () => {
		const h = await html();
		expect(h).toMatch(/<input data-component="input" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" dir="ltr"/);
		expect(h).toContain('<form data-slot="code-form" novalidate>');
	});

	it('messages are announced politely', async () => {
		expect(await html()).toContain('<p data-slot="status" role="status" aria-live="polite"></p>');
	});

	it('Arabic: RTL copy, the email kept left to right', async () => {
		const h = await html({ locale: 'ar', lang: 'ar' });
		expect(h).toContain('dir="rtl"');
		expect(h).toContain('يحتاج دورك إلى مفتاح مرور');
		expect(h).toContain('<ol data-slot="steps" aria-label="الخطوات">');
		expect(h).toContain('أرسل لي رمزًا');
		expect(h).toContain('تأكيد الرمز');
		expect(h).toContain('<bdi dir="ltr">staff@example.com</bdi>');
		expect(button(h, 'data-action="skip"')).toContain('ليس الآن، سأستخدم كلمة المرور حتى');
	});
});

describe('renderAddPasskeyPage: other cases', () => {
	it('member card: no steps, Add a passkey is the filled button, Not now outlined', async () => {
		const h = await html({ staff: false, needsCode: false, graceUntil: undefined });
		expect(markup(h)).not.toContain('data-slot="steps"');
		expect(h).toContain('Sign in faster next time');
		expect(h).toContain('<p data-slot="hint">Your password manager or device will ask to save the passkey. Follow its steps.</p>');
		expect(button(h, 'data-action="add"')).toBe('<button type="button" data-component="button" data-action="add">Add a passkey</button>');
		expect(button(h, 'data-action="skip"')).toContain('>Not now</button>');
	});

	it('setup page (staff, setup link): no code steps, the grace line, Back', async () => {
		const h = await html({ mode: 'setup', needsCode: false, ticket: 't1' });
		expect(markup(h)).not.toContain('data-slot="steps"');
		expect(h).toContain('Until 21 November 2026 you can still use your password.');
		expect(button(h, 'data-action="skip"')).toContain('>Back</button>');
	});

	it('escapes the email and never lets the script config close its tag', async () => {
		const h = await html({ email: '<img src=x onerror=alert(1)>@example.com', continueUrl: 'http://localhost:3302/</script><script>alert(1)</script>' });
		expect(h).not.toContain('<img src=x');
		expect(h).toContain('&lt;img src=x onerror=alert(1)&gt;@example.com');
		const js = script(h);
		expect(js).not.toContain('</script>');
		expect(js).toContain('\\u003c/script>');
	});

	it('the page script parses (no template escaping slips) and uses the standard ceremony', async () => {
		for (const over of [{}, { locale: 'ar' as const, lang: 'ar' as const }, { staff: false, needsCode: false }]) {
			const js = script(await html(over));
			expect(() => new Function(js)).not.toThrow();
		}
		const js = script(await html());
		// oaPasskey.create is navigator.credentials.create: password-manager extensions hook it
		expect(js).toContain('navigator.credentials.create({publicKey:pk})');
		expect(js).toContain('pk.create(held.options)');
		// The prompt opens straight after the code only while the browser still counts the click
		expect(js).toContain('function mayPromptNow(){var a=navigator.userActivation;return !a||a.isActive;}');
		expect(js).toContain('/^\\d{6}$/');
	});
});
