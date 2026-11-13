/**
 * Single sign-on and single sign-out across web, profile and admin.
 *
 * Before: every app showed the sign-in form again (the issuer only reused the
 * browser session for prompt=none), and /logout left the shared browser
 * session alive. Runs the real worker in workerd.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../index';
import { setupDatabase } from '../test-setup';
import { PROFILE, ADMIN, registerTestClients } from './helpers/clients';
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { ScryptHasher } from '@al-ummah-now/openauth/provider/password';
import { frontChannelLogoutUrls, logoutReturnUrl } from '../handlers/logout-handler';

const ISSUER = 'http://localhost:3301';
const EMAIL = 'sso-test@example.com';
const PASSWORD = 'Sso-Test-123!';

class Browser {
	jar = new Map<string, string>();
	/** The last Set-Cookie header seen for each cookie name, attributes included. */
	setCookies = new Map<string, string>();
	async fetch(path: string, init: RequestInit = {}) {
		const headers = new Headers(init.headers);
		headers.set('host', new URL(ISSUER).host);
		headers.set('cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
		const ctx = createExecutionContext();
		const res = await worker.fetch(new Request(new URL(path, ISSUER), { ...init, headers, redirect: 'manual' }), env as unknown as Env, ctx);
		await waitOnExecutionContext(ctx);
		for (const c of res.headers.getSetCookie()) {
			const [pair] = c.split(';');
			const i = pair.indexOf('=');
			const value = pair.slice(i + 1);
			this.setCookies.set(pair.slice(0, i), c);
			if (!value || /max-age=0/i.test(c)) this.jar.delete(pair.slice(0, i));
			else this.jar.set(pair.slice(0, i), value);
		}
		return res;
	}
	async authorize(client: { id: string; redirect: string }) {
		const res = await this.fetch(
			`/authorize?client_id=${client.id}&response_type=code&provider=password&state=${client.id}&redirect_uri=${encodeURIComponent(client.redirect)}`
		);
		expect(res.status).toBe(302);
		return res.headers.get('location')!;
	}
	async signIn(client: { id: string; redirect: string }) {
		const login = await this.authorize(client);
		expect(login).toContain('/password/authorize');
		const res = await this.fetch(login, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ email: EMAIL, password: PASSWORD }).toString(),
		});
		expect(res.status).toBe(302);
		return res.headers.get('location')!;
	}
}

async function browserSessionCount() {
	const row = await (env as unknown as Env).AUTH_DB.prepare('SELECT COUNT(*) AS n FROM browser_sessions').first<{ n: number }>();
	return row?.n ?? 0;
}

describe('single sign-on (worker)', () => {
	beforeAll(async () => {
		await setupDatabase();
		await registerTestClients();
		const storage = CloudflarePatchedStorage({ namespace: env.AUTH_STORAGE });
		await Storage.set(storage, ['email', EMAIL, 'password'], await ScryptHasher().hash(PASSWORD));
	});

	it('signing in to profile signs in to admin without the form', async () => {
		const browser = new Browser();
		expect(await browser.signIn(PROFILE)).toMatch(/^http:\/\/localhost:3302\/callback\?code=/);
		expect(browser.jar.has('__session')).toBe(true);

		const toAdmin = new URL(await browser.authorize(ADMIN));
		expect(toAdmin.origin + toAdmin.pathname).toBe(ADMIN.redirect);
		expect(toAdmin.searchParams.get('code')).toBeTruthy();
		expect(toAdmin.searchParams.get('state')).toBe(ADMIN.id);
	});

	it('on a localhost issuer the SSO cookie is set and cleared without Secure (WebKit drops Secure cookies over http, #1093)', async () => {
		const browser = new Browser();
		await browser.signIn(PROFILE);
		expect(browser.setCookies.get('__session')).toMatch(/HttpOnly/i);
		expect(browser.setCookies.get('__session')).not.toMatch(/;\s*Secure/i);
		await browser.fetch(`/logout?return=${encodeURIComponent('http://localhost:5175/')}`);
		expect(browser.setCookies.get('__session')).toMatch(/max-age=0/i);
		expect(browser.setCookies.get('__session')).not.toMatch(/;\s*Secure/i);
	});

	it('logout ends the shared sign-in, walks every app, and the apps need a sign-in again', async () => {
		const browser = new Browser();
		await browser.signIn(PROFILE);
		const stolen = browser.jar.get('__session')!;
		const before = await browserSessionCount();

		const res = await browser.fetch(`/logout?return=${encodeURIComponent('http://localhost:5175/')}`);
		expect(res.status).toBe(302);
		expect(res.headers.getSetCookie().some((c) => c.startsWith('__session=;'))).toBe(true);
		expect(browser.jar.has('__session')).toBe(false);
		expect(await browserSessionCount()).toBe(before - 1);

		// Front-channel chain: profile, then admin, then back to `return`
		const first = new URL(res.headers.get('location')!);
		expect(first.origin + first.pathname).toBe('http://localhost:3302/logout');
		const step1 = new URL(first.searchParams.get('next')!);
		expect(step1.origin + step1.pathname).toBe(`${ISSUER}/logout`);
		const second = new URL((await browser.fetch(step1.pathname + step1.search)).headers.get('location')!);
		expect(second.origin + second.pathname).toBe('http://localhost:5175/logout');
		const step2 = new URL(second.searchParams.get('next')!);
		const last = await browser.fetch(step2.pathname + step2.search);
		expect(last.headers.get('location')).toBe('http://localhost:5175/');

		// Every app now gets the sign-in form
		expect(await browser.authorize(ADMIN)).toContain('/password/authorize');
		expect(await browser.authorize(PROFILE)).toContain('/password/authorize');

		// A copied cookie from before the logout is dead too
		browser.jar.set('__session', stolen);
		expect(await browser.authorize(ADMIN)).toContain('/password/authorize');
	});

	/** The account most recently signed in (each test signs in a fresh browser). */
	async function newestAccount() {
		const row = await (env as unknown as Env).AUTH_DB.prepare(
			'SELECT user_id, browser_session_id FROM account_sessions ORDER BY authenticated_at DESC, rowid DESC LIMIT 1'
		).first<{ user_id: string; browser_session_id: string }>();
		return row!;
	}

	/** POSTs the picker's "Sign out" form for the browser's newest account, as the picker renders it. */
	async function pickerSignOut(browser: Browser, client: { id: string; redirect: string }) {
		const row = await newestAccount();
		const res = await browser.fetch('/account-picker/remove', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				user_id: row.user_id,
				client_id: client.id,
				redirect_uri: client.redirect,
				response_type: 'code',
				state: 'picker',
			}).toString(),
		});
		expect(res.status).toBe(302);
		return new URL(res.headers.get('location')!);
	}

	it('picker "Sign out" of the last account is single sign-out (#219)', async () => {
		const browser = new Browser();
		await browser.signIn(PROFILE);
		const before = await browserSessionCount();

		// Before: back to /authorize?prompt=select_account with every app still signed in
		const location = await pickerSignOut(browser, ADMIN);
		expect(location.origin + location.pathname).toBe(`${ISSUER}/logout`);
		expect(location.searchParams.get('return')).toBe('http://localhost:5175/');

		// The /logout chain ends the browser session and walks every app
		const chain = await browser.fetch(location.pathname + location.search);
		expect(new URL(chain.headers.get('location')!).origin).toBe('http://localhost:3302');
		expect(browser.jar.has('__session')).toBe(false);
		expect(await browserSessionCount()).toBe(before - 1);
		expect(await browser.authorize(ADMIN)).toContain('/password/authorize');
		expect(await browser.authorize(PROFILE)).toContain('/password/authorize');
	});

	it('picker "Sign out" with other accounts left only removes that one', async () => {
		const browser = new Browser();
		await browser.signIn(PROFILE);
		const row = await newestAccount();
		// A second, older account in the same browser session
		await (env as unknown as Env).AUTH_DB.prepare(
			`INSERT INTO account_sessions (id, browser_session_id, user_id, is_active, authenticated_at, expires_at, subject_type, subject_properties, refresh_token, client_id)
			 SELECT ?, browser_session_id, ?, 0, authenticated_at - 1000, expires_at, subject_type, subject_properties, refresh_token, client_id
			 FROM account_sessions WHERE browser_session_id = ? AND user_id = ?`
		)
			.bind(crypto.randomUUID(), 'usr_other_account', row.browser_session_id, row.user_id)
			.run();

		const location = await pickerSignOut(browser, ADMIN);
		expect(location.pathname).toBe('/authorize');
		expect(location.searchParams.get('prompt')).toBe('select_account');
		expect(browser.jar.has('__session')).toBe(true);
	});

	it('logout CSRF: another site cannot sign the browser out; it gets the "Sign out?" page', async () => {
		const browser = new Browser();
		await browser.signIn(PROFILE);
		const back = encodeURIComponent('http://localhost:5175/');
		for (const headers of [
			{ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' },
			{ 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Mode': 'no-cors' },
			{ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate' },
		]) {
			const res = await browser.fetch(`/logout?return=${back}`, { headers });
			expect(res.status).toBe(200);
			expect(res.headers.getSetCookie()).toEqual([]);
			const page = await res.text();
			expect(page).toContain('data-page="sign-out-confirm"');
			expect(page).toContain('method="post"');
			expect(page).toContain('value="http://localhost:5175/"');
			expect(browser.jar.has('__session')).toBe(true);
		}
		// Still signed in: the next app gets a code silently
		expect(await browser.authorize(ADMIN)).not.toContain('/password/authorize');

		// A cross-origin POST is refused
		const forged = await browser.fetch('/logout', {
			method: 'POST',
			headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
			body: 'return=https%3A%2F%2Fevil.example%2F',
		});
		expect(forged.status).toBe(403);
		expect(browser.jar.has('__session')).toBe(true);

		// The page's own (same-origin) form signs out and walks the apps as before
		const confirmed = await browser.fetch('/logout', {
			method: 'POST',
			headers: { origin: ISSUER, 'content-type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' },
			body: new URLSearchParams({ return: 'http://localhost:5175/' }).toString(),
		});
		expect(confirmed.status).toBe(302);
		expect(browser.jar.has('__session')).toBe(false);
		expect(new URL(confirmed.headers.get('location')!).pathname).toBe('/logout');
		expect(await browser.authorize(ADMIN)).toContain('/password/authorize');
	});

	it('the "Sign out?" page follows ?lang= (Arabic) and never trusts a foreign return', async () => {
		const res = await new Browser().fetch(`/logout?lang=ar&return=${encodeURIComponent('https://evil.example/')}`, {
			headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'document' },
		});
		const page = await res.text();
		expect(page).toContain('dir="rtl"');
		expect(page).toContain('تسجيل الخروج');
		expect(page).not.toContain('evil.example');
	});

	it('our own apps (same-site navigations) and browsers without Fetch Metadata sign out directly', async () => {
		const browser = new Browser();
		await browser.signIn(PROFILE);
		const res = await browser.fetch(`/logout?return=${encodeURIComponent('http://localhost:5175/')}`, {
			headers: { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' },
		});
		expect(res.status).toBe(302);
		expect(browser.jar.has('__session')).toBe(false);
	});

	it('/authorize without client parameters starts a real sign-in through the profile app', async () => {
		const res = await new Browser().fetch('/authorize');
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('http://localhost:3302/login');
		const ar = await new Browser().fetch('/authorize?lang=ar');
		expect(ar.headers.get('location')).toBe('http://localhost:3302/login?lang=ar');
	});

	it('logout never redirects to a foreign site', async () => {
		const res = await new Browser().fetch(`/logout?step=99&return=${encodeURIComponent('https://evil.example/')}`);
		expect(res.headers.get('location')).toBe(logoutReturnUrl(env as unknown as Env, null, ISSUER));
		expect(res.headers.get('location')).not.toContain('evil');
	});
});

describe('logout helpers', () => {
	it('parses FRONTCHANNEL_LOGOUT_URLS, skipping invalid entries', () => {
		expect(
			frontChannelLogoutUrls({ FRONTCHANNEL_LOGOUT_URLS: ' https://a.example/logout, javascript:alert(1) ,,https://b.example/x' }).map(String)
		).toEqual(['https://a.example/logout', 'https://b.example/x']);
		expect(frontChannelLogoutUrls({})).toEqual([]);
	});

	it('only returns to our own apps', () => {
		const e = {
			AUTH_STORAGE: undefined as unknown as KVNamespace,
			FRONTCHANNEL_LOGOUT_URLS: 'https://profile.example/logout',
			SIGN_IN_FALLBACK_URL: 'https://videos.example/',
		};
		expect(logoutReturnUrl(e, 'https://profile.example/', 'https://auth.example')).toBe('https://profile.example/');
		expect(logoutReturnUrl(e, 'https://videos.example/watch', 'https://auth.example')).toBe('https://videos.example/watch');
		expect(logoutReturnUrl(e, 'https://evil.example/', 'https://auth.example')).toBe('https://videos.example/');
		expect(logoutReturnUrl(e, '//evil.example/', 'https://auth.example')).toBe('https://videos.example/');
	});
});
