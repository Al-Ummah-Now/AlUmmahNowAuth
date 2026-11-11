/**
 * Every Auth email in the shared design (src/email/layout.ts): one language per
 * email, RTL for Arabic, escaping, the conditional channel text of the invite,
 * and the plain-text part carrying everything the HTML says.
 */
import { describe, it, expect } from 'vitest';
import { codePurposeOf, renderVerificationCodeEmail } from '../email-templates';
import { inviteChannels, renderInviteEmail } from '../invites/email';
import { EMAIL_LOGO_URL, escapeHtml, renderEmail, type RenderedEmailParts } from '../email/layout';

const ARABIC = /[؀-ۿ]/;
/** The text a reader sees: skips <head>, comments and the hidden preheader, drops tags, decodes entities. */
function visibleText(html: string): string {
	let rest = html.slice(html.indexOf('<body'));
	const pre = rest.indexOf('<div style="display:none');
	if (pre >= 0) rest = rest.slice(0, pre) + rest.slice(rest.indexOf('</div>', pre) + 6);
	let out = '';
	let inTag = false;
	for (let k = 0; k < rest.length; k++) {
		if (rest.startsWith('<!--', k)) {
			k = rest.indexOf('-->', k) + 2;
			continue;
		}
		const ch = rest[k];
		if (ch === '<') inTag = true;
		else if (ch === '>' && inTag) {
			inTag = false;
			out += ' ';
		} else if (!inTag) out += ch;
	}
	const named: Record<string, string> = { quot: '"', lt: '<', gt: '>', amp: '&' };
	return out.replace(/&(#\d+|quot|lt|gt|amp);/g, (_, e: string) => (e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1))) : named[e]));
}
/** Sentences compared without the label colons the text part adds. */
const norm = (s: string) => s.replace(/(?:[:\s\u200f\u200e\u2007\ufeff]|\u034f)+/g, ' ').trim();

/** Shared checks for every rendered email. */
function expectWellFormed(email: RenderedEmailParts, locale: 'en' | 'ar') {
	const { html, text, subject } = email;
	expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
	expect(html).toContain(`<html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`);
	expect(html).toContain('<meta name="color-scheme" content="light dark">');
	expect(html).toContain('@media (prefers-color-scheme:dark)');
	expect(html).toContain('max-width:600px');
	expect(html).toContain(`src="${EMAIL_LOGO_URL}"`);
	expect(html).toContain(`<title>${escapeHtml(subject)}</title>`);
	// One language: an English email has no Arabic, an Arabic one is in Arabic
	if (locale === 'en') {
		expect(ARABIC.test(subject)).toBe(false);
		expect(ARABIC.test(text)).toBe(false);
		expect(ARABIC.test(visibleText(html))).toBe(false);
		expect(html).not.toContain('dir="rtl"');
	} else {
		expect(ARABIC.test(subject)).toBe(true);
		expect(html).not.toContain('dir="ltr" lang="en"');
		expect(html).toContain("'Noto Naskh Arabic'");
	}
	expect(text).not.toMatch(/<[a-z]/i);
}

/** Every sentence of the plain text (by line) also appears in the HTML. */
function expectTextParity({ html, text }: RenderedEmailParts) {
	const body = norm(visibleText(html));
	for (const line of text.split('\n').map((l) => l.replace(/^> ?/, '').trim())) {
		if (!line || line === '—' || /^https?:\/\//.test(line) || /:$/.test(line)) continue;
		const plain = line.replace(/: https?:\/\/\S+$/, '');
		expect(body, `HTML is missing: ${plain}`).toContain(norm(plain));
	}
}

describe('the email-code email', () => {
	const base = { code: '482913', email: 'reader@example.com', expiryMinutes: 15 };

	it('says which page asked for it', () => {
		expect(codePurposeOf('/password/register')).toBe('register');
		expect(codePurposeOf('/password/change')).toBe('reset');
		expect(renderVerificationCodeEmail({ ...base, purpose: 'register' }).subject).toMatch(/create your account/);
		expect(renderVerificationCodeEmail({ ...base, purpose: 'reset' }).subject).toMatch(/reset your password/);
	});

	for (const locale of ['en', 'ar'] as const) {
		for (const purpose of ['register', 'reset'] as const) {
			it(`${locale} ${purpose}: one language, code in the preheader, text parity`, () => {
				const email = renderVerificationCodeEmail({ ...base, locale, purpose });
				expectWellFormed(email, locale);
				expectTextParity(email);
				expect(email.text).toContain('482913');
				expect(email.html).toMatch(/display:none[^>]*>[^<]*482913/);
				// The code itself stays left to right in Arabic
				expect(email.html).toContain('dir="ltr" style="margin:0;font-family:\'SFMono-Regular\'');
				expect(email.text).toMatchSnapshot();
			});
		}
	}

	it('defaults to English', () => {
		expect(renderVerificationCodeEmail(base).html).toContain('<html lang="en" dir="ltr"');
	});
});

describe('the invite email', () => {
	const data = {
		email: 'new@example.com',
		name: 'Ali',
		link: 'https://auth.test/invite/abc?lang=ar',
		expiresAt: Date.UTC(2026, 10, 24),
		note: null as string | null,
	};

	for (const locale of ['en', 'ar'] as const) {
		it(`${locale}: one language, button, expiry date in that language, text parity`, () => {
			const email = renderInviteEmail({ ...data, locale, channels: [{ name: 'Noor Talks', action: 'created' }], note: 'Welcome' });
			expectWellFormed(email, locale);
			expectTextParity(email);
			expect(email.html).toContain('href="https://auth.test/invite/abc?lang=ar"');
			expect(email.text).toContain(locale === 'ar' ? 'نوفمبر' : '24 November 2026');
			expect(email.text).toMatchSnapshot();
		});
	}

	it('mentions a channel only when one is attached, by name', () => {
		const none = renderInviteEmail({ ...data, locale: 'en' });
		expect(none.text).toContain('creator account');
		expect(none.text).not.toMatch(/channel/i);
		expect(none.html).not.toMatch(/channel/i);
		const noneAr = renderInviteEmail({ ...data, locale: 'ar' });
		expect(noneAr.text).not.toContain('قناة');
		expect(noneAr.text).not.toContain('القناة');

		const one = renderInviteEmail({ ...data, locale: 'en', channels: [{ name: 'Noor Talks', action: 'created' }] });
		expect(one.text).toContain('It comes with the channel Noor Talks');
		expect(one.text).not.toContain('waiting');
		const two = renderInviteEmail({ ...data, locale: 'en', channels: [{ name: 'A', action: 'created' }, { name: 'B', action: 'created' }] });
		expect(two.text).toContain('the channels A and B');
		const moved = renderInviteEmail({ ...data, locale: 'ar', channels: [{ name: 'نور', action: 'transferred' }] });
		expect(moved.text).toContain('ونُقلت إليه القناة نور');
	});

	it('reads channels from the invite details and ignores junk', () => {
		expect(inviteChannels({ channels: [{ name: ' X ', action: 'created' }, { id: 1 }, null, { name: '' }] })).toEqual([{ name: 'X', action: 'created' }]);
		expect(inviteChannels({})).toEqual([]);
		expect(inviteChannels(null)).toEqual([]);
	});

	it('escapes everything the admin typed and refuses non-http links', () => {
		const email = renderInviteEmail({
			...data,
			locale: 'en',
			name: '<img src=x onerror=alert(1)>',
			note: '<script>alert(1)</script>\nline two',
			channels: [{ name: '"><b>Chan</b>', action: 'created' }],
			link: 'javascript:alert(1)',
		});
		expect(email.html).not.toContain('<script>');
		expect(email.html).not.toContain('<img src=x');
		expect(email.html).not.toContain('<b>Chan</b>');
		expect(email.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;<br>line two');
		expect(email.html).not.toContain('javascript:');
		expect(email.text).toContain('> line two');
	});
});

describe('the layout', () => {
	it('puts the preheader first and hidden, and the reason in the footer', () => {
		const email = renderEmail({ locale: 'en', subject: 'S', preheader: 'Peek', blocks: [{ kind: 'p', text: 'Body' }], reason: 'Why you got it' });
		expect(email.html.indexOf('Peek')).toBeLessThan(email.html.indexOf('Body'));
		expect(email.html).toMatch(/<div style="display:none;[^"]*">Peek/);
		expect(email.text.trim().endsWith('Visit Al Ummah Now: https://www.alummahnow.net/en')).toBe(true);
		expect(email.text).toContain('Why you got it');
		expect(email.text).not.toContain('Peek');
	});
});
