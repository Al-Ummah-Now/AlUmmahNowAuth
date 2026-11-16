/**
 * Arabic emails and pages show Eastern Arabic (Hindi) numerals ٠–٩ in every formatted value: dates,
 * minutes, limits (owner decision 2026-11-15). The emailed one-time code stays in Arabic numerals 0–9,
 * the digits the reader types; ids and URLs stay as they are.
 */
import { describe, expect, it } from 'vitest';
import { renderVerificationCodeEmail } from '../email-templates';
import { renderInviteEmail } from '../invites/email';
import { passkeyEmailDoc } from '../passkeys/email';
import { copyFor } from '../passkeys/pages';
import { renderEmail } from '../email/layout';
import { guardPasswordRequest, type PasswordCopy } from '../security/password-guard';
import { env } from 'cloudflare:test';

const ASCII_DIGIT = /[0-9]/;
const EXPIRES = Date.UTC(2026, 10, 22, 9, 30);

/** The text a reader sees, without URLs and the one-time code. */
const visible = (text: string, code = '') => text.replace(/https?:\/\/\S+/g, '').split(code || '\u0000').join('');

describe('Arabic emails: ٠–٩, the code itself in 0–9', () => {
	it('sign-up code email', () => {
		const { text, subject } = renderVerificationCodeEmail({ email: 'a@example.com', code: '123456', locale: 'ar', expiryMinutes: 15 });
		expect(text).toContain('123456');
		expect(text).toContain('١٥ دقيقة');
		expect(visible(text, '123456')).not.toMatch(ASCII_DIGIT);
		expect(subject).not.toMatch(ASCII_DIGIT);
	});

	it('passkey code email', () => {
		const { text } = renderEmail(passkeyEmailDoc({ kind: 'code', code: '654321' }, 'ar'));
		expect(text).toContain('654321');
		expect(text).toContain('١٥ دقيقة');
		expect(visible(text, '654321')).not.toMatch(ASCII_DIGIT);
	});

	it('passkey setup link email: the date', () => {
		const { text } = renderEmail(passkeyEmailDoc({ kind: 'setup-link', link: 'https://auth.example.com/passkeys/setup?t=abc123', expiresAt: EXPIRES }, 'ar'));
		expect(text).toContain('٢٠٢٦');
		expect(visible(text)).not.toMatch(ASCII_DIGIT);
	});

	it('invite email: the date', () => {
		const { text } = renderInviteEmail({ email: 'a@example.com', name: 'Ali', link: 'https://auth.example.com/invite/abc123', expiresAt: EXPIRES, note: null, locale: 'ar', channels: [{ name: 'One' }, { name: 'Two' }] });
		expect(text).toContain('٢٠٢٦');
		expect(visible(text)).not.toMatch(ASCII_DIGIT);
	});

	it('English stays in 0–9', () => {
		const { text } = renderVerificationCodeEmail({ email: 'a@example.com', code: '123456', locale: 'en', expiryMinutes: 15 });
		expect(text).toContain('15 minutes');
	});
});

describe('Arabic passkey page copy', () => {
	it('the passkey limit in ٠–٩', () => {
		expect(copyFor('ar').limit).toContain('١٠');
		expect(copyFor('ar').limit).not.toMatch(ASCII_DIGIT);
		expect(copyFor('en').limit).toContain('10 passkeys');
	});
});

describe('a code typed with ٠–٩ is the same code in 0–9', () => {
	it('the password pages get the code in Arabic numerals', async () => {
		const form = new FormData();
		form.set('action', 'verify');
		form.set('code', '١٢٣٤٥٦');
		const url = new URL('https://auth.example.com/password/register?lang=ar');
		const request = new Request(url, { method: 'POST', body: form });
		const guard = await guardPasswordRequest(request, { AUTH_DB: env.AUTH_DB }, url, {} as PasswordCopy);
		expect((await guard.request.formData()).get('code')).toBe('123456');
	});

	it('a code already in 0–9 passes through untouched', async () => {
		const form = new FormData();
		form.set('action', 'verify');
		form.set('code', '123456');
		const url = new URL('https://auth.example.com/password/register');
		const request = new Request(url, { method: 'POST', body: form });
		const guard = await guardPasswordRequest(request, { AUTH_DB: env.AUTH_DB }, url, {} as PasswordCopy);
		expect(guard.request).toBe(request);
	});
});
