/**
 * Sign-in flows that can't be resumed must never show OpenAuth's raw
 * "The browser was in an unknown state" error (text/plain or JSON
 * invalid_state). They render a friendly en/ar "Start sign-in again" page.
 * Concurrent sign-ins in one browser (web + profile + admin) must each
 * complete to their own client.
 *
 * Runs the real worker (enterprise issuer + password provider) in workerd.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../index';
import { setupDatabase } from '../test-setup';
import { signInFallbackUrl } from '../utils/sign-in-restart';
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { ScryptHasher } from '@al-ummah-now/openauth/provider/password';

const ISSUER = 'http://localhost:3301';
const EMAIL = 'restart-test@example.com';
const PASSWORD = 'Restart-Test-123!';
const RAW_ERROR = 'The browser was in an unknown state';
const PROFILE = { id: '109a1087-6626-40f7-8a7f-7f42f83f4f30', redirect: 'http://localhost:3302/callback' };
const ADMIN = { id: '1448ed27-39a6-417d-b4c8-07f881e81269', redirect: 'http://localhost:5175/callback' };

class Browser {
	jar = new Map<string, string>();
	private take(res: Response) {
		for (const c of res.headers.getSetCookie()) {
			const [pair] = c.split(';');
			const i = pair.indexOf('=');
			const value = pair.slice(i + 1);
			if (!value || /max-age=0/i.test(c)) this.jar.delete(pair.slice(0, i));
			else this.jar.set(pair.slice(0, i), value);
		}
	}
	async fetch(path: string, init: RequestInit = {}) {
		const headers = new Headers(init.headers);
		headers.set('host', new URL(ISSUER).host);
		headers.set('cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
		const ctx = createExecutionContext();
		const res = await worker.fetch(new Request(new URL(path, ISSUER), { ...init, headers, redirect: 'manual' }), env as unknown as Env, ctx);
		await waitOnExecutionContext(ctx);
		this.take(res);
		return res;
	}
	signIn(path: string, headers: Record<string, string> = {}) {
		return this.fetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
			body: new URLSearchParams({ email: EMAIL, password: PASSWORD }).toString(),
		});
	}
	async authorize(client: { id: string; redirect: string }) {
		const res = await this.fetch(
			`/authorize?client_id=${client.id}&response_type=code&provider=password&state=${client.id}&redirect_uri=${encodeURIComponent(client.redirect)}`
		);
		expect(res.status).toBe(302);
		return res.headers.get('location')!;
	}
}

async function expectRestartPage(res: Response, href: string) {
	expect(res.status).toBe(400);
	expect(res.headers.get('content-type')).toContain('text/html');
	const html = await res.text();
	expect(html).not.toContain(RAW_ERROR);
	expect(html).not.toContain('invalid_state');
	expect(html).toContain('data-page="restart"');
	expect(html).toContain(`href="${href}"`);
	return html;
}

describe('signInFallbackUrl', () => {
	it('uses SIGN_IN_FALLBACK_URL', () => {
		expect(signInFallbackUrl({ SIGN_IN_FALLBACK_URL: 'https://videos.alummahnow.net/', PROFILE_APP_URL: 'https://p/' })).toBe(
			'https://videos.alummahnow.net/'
		);
	});
	it('falls back to PROFILE_APP_URL when unset or invalid', () => {
		expect(signInFallbackUrl({ PROFILE_APP_URL: 'https://profile.auth.alummahnow.net/' })).toBe('https://profile.auth.alummahnow.net/');
		expect(signInFallbackUrl({ SIGN_IN_FALLBACK_URL: 'javascript:alert(1)', PROFILE_APP_URL: 'https://p.example/' })).toBe(
			'https://p.example/'
		);
	});
	it('falls back to the auth root as a last resort', () => {
		expect(signInFallbackUrl({ PROFILE_APP_URL: '' })).toBe('/');
	});
});

describe('unrecoverable sign-in state (worker)', () => {
	beforeAll(async () => {
		await setupDatabase();
		const storage = CloudflarePatchedStorage({ namespace: env.AUTH_STORAGE });
		await Storage.set(storage, ['email', EMAIL, 'password'], await ScryptHasher().hash(PASSWORD));
	});

	it('direct /password/authorize + sign in: friendly page to the configured web app', async () => {
		const res = await new Browser().signIn('/password/authorize');
		await expectRestartPage(res, signInFallbackUrl(env as unknown as Env));
	});

	it('is Arabic for ?lang=ar', async () => {
		const html = await expectRestartPage(await new Browser().signIn('/password/authorize?lang=ar'), signInFallbackUrl(env as unknown as Env));
		expect(html).toContain('dir="rtl"');
		expect(html).toContain('ابدأ تسجيل الدخول من جديد');
	});

	it('back button after a sign-in sends the user back to the app', async () => {
		const browser = new Browser();
		const login = await browser.authorize(PROFILE);
		expect(login).toContain('auth_flow=');
		const first = await browser.signIn(login);
		expect(first.status).toBe(302);
		expect(first.headers.get('location')).toMatch(/^http:\/\/localhost:3302\/callback\?code=/);
		const again = await browser.signIn(login);
		expect(again.status).toBe(302);
		expect(again.headers.get('location')).toBe('http://localhost:3302/');
	});

	it('profile and admin sign-ins in one browser complete to their own clients', async () => {
		const browser = new Browser();
		const profileTab = await browser.authorize(PROFILE);
		const adminTab = await browser.authorize(ADMIN);
		const profile = await browser.signIn(profileTab);
		const admin = await browser.signIn(adminTab);
		const toProfile = new URL(profile.headers.get('location')!);
		const toAdmin = new URL(admin.headers.get('location')!);
		expect(toProfile.origin + toProfile.pathname).toBe(PROFILE.redirect);
		expect(toProfile.searchParams.get('state')).toBe(PROFILE.id);
		expect(toAdmin.origin + toAdmin.pathname).toBe(ADMIN.redirect);
		expect(toAdmin.searchParams.get('state')).toBe(ADMIN.id);
	});

	it('a stale register form restarts instead of erroring', async () => {
		const res = await new Browser().fetch('/password/register', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'action=verify&code=123456',
		});
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).not.toContain(RAW_ERROR);
		expect(html).toContain('value="register"');
	});
});
