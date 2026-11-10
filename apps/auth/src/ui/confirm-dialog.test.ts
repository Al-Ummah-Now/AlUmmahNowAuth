import { describe, expect, it } from 'vitest';
import { CONFIRM_COPY, CONFIRM_DIALOG_ID, confirmAttributes, renderConfirmDialog, uiLocale } from './confirm-dialog';
import { renderSessionList, type DeviceSession } from './session-list';
import { renderAccountSwitcher } from './account-switcher';
import { renderAccountSelector } from './select-account';

const BROWSER_PROMPT = /(?<![\w$.])(?:window\.)?(?:confirm|alert|prompt)\s*\(|beforeunload/;

function session(overrides: Partial<DeviceSession>): DeviceSession {
	return {
		id: 'as_1',
		browserSessionId: 'bs_1',
		deviceType: 'desktop',
		deviceName: 'Laptop',
		ipAddress: '203.0.113.1',
		lastActivity: new Date().toISOString(),
		createdAt: new Date().toISOString(),
		isCurrentSession: false,
		...overrides,
	};
}

describe('confirm dialog markup', () => {
	it('is a labelled, described alert dialog whose initial focus is Cancel', () => {
		const html = renderConfirmDialog('en');
		expect(html).toContain(`<dialog id="${CONFIRM_DIALOG_ID}"`);
		expect(html).toContain('role="alertdialog"');
		expect(html).toContain(`aria-labelledby="${CONFIRM_DIALOG_ID}-title"`);
		expect(html).toContain(`aria-describedby="${CONFIRM_DIALOG_ID}-message"`);
		expect(html).toContain(`id="${CONFIRM_DIALOG_ID}-title"`);
		expect(html).toContain(`id="${CONFIRM_DIALOG_ID}-message"`);
		expect(html).toMatch(/value="cancel" class="aun-confirm__cancel" autofocus>Cancel</);
		expect(html).toContain('showModal()');
		expect(html).toContain('lang="en" dir="ltr"');
		expect(html).not.toMatch(BROWSER_PROMPT);
	});

	it('is Arabic and right-to-left for Arabic pages', () => {
		const html = renderConfirmDialog('ar');
		expect(html).toContain('lang="ar" dir="rtl"');
		expect(html).toContain(`>${CONFIRM_COPY.ar.cancel}<`);
	});

	it('has every string in English and Arabic', () => {
		expect(Object.keys(CONFIRM_COPY.ar).sort()).toEqual(Object.keys(CONFIRM_COPY.en).sort());
		for (const value of Object.values(CONFIRM_COPY.ar)) expect(value).not.toBe('');
	});

	it('escapes the texts it puts on a form', () => {
		const attrs = confirmAttributes({ title: 'a"b', message: "<x>'", action: '&' });
		expect(attrs).toBe('data-confirm-title="a&quot;b" data-confirm-message="&lt;x&gt;&#039;" data-confirm-action="&amp;"');
	});

	it('is English unless the link asks for Arabic', () => {
		expect(uiLocale(new Request('https://auth.test/settings/sessions'))).toBe('en');
		expect(uiLocale(new Request('https://auth.test/settings/sessions?lang=ar'))).toBe('ar');
		expect(uiLocale(new Request('https://auth.test/settings/sessions?lang=fr'))).toBe('en');
	});
});

describe('session list sign-outs', () => {
	it('confirm in the page dialog, never a browser prompt', () => {
		const html = renderSessionList({
			sessions: [session({ id: 'as_current', isCurrentSession: true }), session({ id: 'as_other' })],
		});
		expect(html).not.toMatch(BROWSER_PROMPT);
		expect(html).not.toContain('onclick');
		expect(html).toContain(`<dialog id="${CONFIRM_DIALOG_ID}"`);
		expect(html).toMatch(/action="\/session\/devices\/revoke-all"[^>]*data-confirm-title="Sign out all other devices\?"/);
		expect(html).toMatch(/action="\/session\/devices\/as_other"[^>]*data-confirm-title="Sign out this device\?"/);
	});

	it('asks in Arabic for ?lang=ar', () => {
		const html = renderSessionList({ sessions: [session({})], locale: 'ar' });
		expect(html).toContain(`data-confirm-title="${CONFIRM_COPY.ar.signOutAllOtherTitle}"`);
		expect(html).toContain('dir="rtl"');
	});
});

describe('account switcher sign-outs', () => {
	const accounts = [
		{ userId: 'u1', email: 'active@example.com', lastUsed: new Date().toISOString(), isActive: true },
		{ userId: 'u2', email: "o'brien@example.com", lastUsed: new Date().toISOString(), isActive: false },
	];

	it('confirm in the page dialog, with the email as text only', () => {
		const html = renderAccountSwitcher({ accounts });
		expect(html).not.toMatch(BROWSER_PROMPT);
		expect(html).not.toContain('onclick');
		expect(html).toContain('data-confirm-message="o&#039;brien@example.com is signed out of this browser."');
		expect(html).toMatch(/action="\/session\/signout-all"[^>]*data-confirm-title="Sign out of all accounts\?"/);
		expect(html).toContain(`<dialog id="${CONFIRM_DIALOG_ID}"`);
	});
});

describe('account selector', () => {
	const props = {
		accounts: [{ userId: 'u1', email: 'a@example.com', lastUsed: new Date().toISOString(), isActive: true }],
		clientId: 'c1',
		clientName: 'App',
		redirectUri: 'https://app.test/callback',
		allowAddAccount: true,
	};

	it('shows a failed switch in the page, never an alert box', () => {
		const html = renderAccountSelector(props);
		expect(html).not.toMatch(BROWSER_PROMPT);
		expect(html).toMatch(/<p id="switch-error" class="switch-error" role="alert" hidden data-message="Couldn&#039;t switch account"/);
		expect(html).toContain('<html lang="en" dir="ltr">');
	});

	it('is Arabic and right-to-left when asked', () => {
		const html = renderAccountSelector({ ...props, locale: 'ar' });
		expect(html).toContain('<html lang="ar" dir="rtl">');
		expect(html).toContain('اختر حسابًا');
		expect(html).toContain(`data-message="${CONFIRM_COPY.ar.switchFailed}"`);
	});
});
