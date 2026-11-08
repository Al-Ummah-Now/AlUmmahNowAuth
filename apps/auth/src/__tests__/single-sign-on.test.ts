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
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { ScryptHasher } from '@al-ummah-now/openauth/provider/password';
import { frontChannelLogoutUrls, logoutReturnUrl } from '../handlers/logout-handler';

const ISSUER = 'http://localhost:3301';
const EMAIL = 'sso-test@example.com';
const PASSWORD = 'Sso-Test-123!';
const PROFILE = { id: '109a1087-6626-40f7-8a7f-7f42f83f4f30', redirect: 'http://localhost:3302/callback' };
const ADMIN = { id: '1448ed27-39a6-417d-b4c8-07f881e81269', redirect: 'http://localhost:5175/callback' };

class Browser {
	jar = new Map<string, string>();
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
