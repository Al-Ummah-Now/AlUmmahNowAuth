/**
 * A suspended (or deleted) account gets no tokens by any way in (#662).
 *
 * Suspending writes a revocation entry that only covers sign-ins made BEFORE
 * it, so before this a new password sign-in or silent sign-on minted fresh
 * tokens. Runs the real worker: password sign-in, silent single sign-on
 * (with and without prompt=none), redeeming a code minted before the
 * suspension, and the refresh grant. Status is read from D1.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../index';
import { setupDatabase } from '../test-setup';
import { PROFILE, ADMIN, registerTestClients } from './helpers/clients';
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { ScryptHasher } from '@al-ummah-now/openauth/provider/password';

const ISSUER = 'http://localhost:3301';
const EMAIL = 'suspension-test@example.com';
const PASSWORD = 'Suspension-Test-123!';
const db = () => (env as unknown as Env).AUTH_DB;

type Client = { id: string; redirect: string };

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkcePair() {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
	return { verifier, challenge };
}

class Browser {
	jar = new Map<string, string>();
	verifier = '';
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
	async authorize(client: Client, extra = '') {
		const { verifier, challenge } = await pkcePair();
		this.verifier = verifier;
		return this.fetch(
			`/authorize?client_id=${client.id}&response_type=code&provider=password&state=st-${client.id}` +
				`&redirect_uri=${encodeURIComponent(client.redirect)}&code_challenge=${challenge}&code_challenge_method=S256${extra}`
		);
	}
	/** Password sign-in; returns the form POST's response. */
	async signIn(client: Client, lang = '') {
		const start = await this.authorize(client);
		expect(start.status).toBe(302);
		const login = new URL(start.headers.get('location')!, ISSUER);
		expect(login.pathname).toBe('/password/authorize');
		if (lang) login.searchParams.set('lang', lang);
		return this.fetch(login.pathname + login.search, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ email: EMAIL, password: PASSWORD }).toString(),
		});
	}
	async exchange(client: Client, code: string) {
		return this.fetch('/token', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				client_id: client.id,
				redirect_uri: client.redirect,
				code_verifier: this.verifier,
			}).toString(),
		});
	}
}

async function refresh(client: Client, refreshToken: string) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(`${ISSUER}/token`, {
			method: 'POST',
			headers: { host: new URL(ISSUER).host, 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.id }).toString(),
		}),
		env as unknown as Env,
		ctx
	);
	await waitOnExecutionContext(ctx);
	return res;
}

const codeOf = (res: Response) => new URL(res.headers.get('location')!).searchParams.get('code');

async function userId(): Promise<string> {
	const row = await db().prepare('SELECT id FROM users WHERE email = ?').bind(EMAIL).first<{ id: string }>();
	return row!.id;
}

/** Suspends in D1 only: no revocation entry and no session cleanup (e.g. a direct DB change or a missed hook). */
async function setStatus(status: 'active' | 'suspended') {
	await db().prepare('UPDATE users SET status = ? WHERE email = ? AND deleted_at IS NULL').bind(status, EMAIL).run();
}

async function signedInTokens(browser: Browser) {
	const res = await browser.signIn(PROFILE);
	expect(res.status).toBe(302);
	const tokenRes = await browser.exchange(PROFILE, codeOf(res)!);
	expect(tokenRes.status).toBe(200);
	return (await tokenRes.json()) as { access_token: string; refresh_token: string };
}

describe('suspended accounts get no tokens (#662)', () => {
	beforeAll(async () => {
		await setupDatabase();
		await registerTestClients();
		const storage = CloudflarePatchedStorage({ namespace: env.AUTH_STORAGE });
		await Storage.set(storage, ['email', EMAIL, 'password'], await ScryptHasher().hash(PASSWORD));
		// First sign-in creates the D1 user
		const first = await new Browser().signIn(PROFILE);
		expect(first.status).toBe(302);
	});

	beforeEach(async () => {
		await setStatus('active');
	});

	it('password sign-in shows the "account suspended" page and issues no code', async () => {
		await setStatus('suspended');
		const browser = new Browser();
		const res = await browser.signIn(PROFILE);
		expect(res.status).toBe(403);
		expect(res.headers.get('location')).toBeNull();
		const html = await res.text();
		expect(html).toContain('This account is suspended');
		expect(html).toMatch(/<html[^>]* lang="en"[^>]* dir="ltr"/);
		expect(html).not.toMatch(/server_error|stack|Error:/);
		// The themed sign-in Layout (same frame as the sign-in pages), not escaped markup
		expect(html).toContain('data-page="account-suspended"');
		expect(html).toContain('data-component="button"');
		expect(html).toMatch(/data-theme="[^"]+"/);
		expect(html).not.toContain('&lt;div');
		// No account was added to the browser session
		const sessions = await db().prepare('SELECT COUNT(*) AS n FROM account_sessions WHERE user_id = ?').bind(await userId()).first<{ n: number }>();
		expect(sessions?.n).toBe(0);
	});

	it('the page is Arabic and right-to-left for ?lang=ar', async () => {
		await setStatus('suspended');
		const res = await new Browser().signIn(PROFILE, 'ar');
		expect(res.status).toBe(403);
		const html = await res.text();
		expect(html).toMatch(/<html[^>]* lang="ar"[^>]* dir="rtl"/);
		expect(html).toContain('هذا الحساب موقوف');
	});

	it('a reinstated account signs in again', async () => {
		await setStatus('suspended');
		expect((await new Browser().signIn(PROFILE)).status).toBe(403);
		await setStatus('active');
		const res = await new Browser().signIn(PROFILE);
		expect(res.status).toBe(302);
		expect(codeOf(res)).toBeTruthy();
	});

	it('silent single sign-on is refused and the browser sign-in is ended', async () => {
		const browser = new Browser();
		expect((await browser.signIn(PROFILE)).status).toBe(302);
		await setStatus('suspended');

		const res = await browser.authorize(ADMIN);
		expect(res.status).toBe(403);
		expect(await res.text()).toContain('This account is suspended');
		const sessions = await db().prepare('SELECT COUNT(*) AS n FROM account_sessions WHERE user_id = ?').bind(await userId()).first<{ n: number }>();
		expect(sessions?.n).toBe(0);
	});

	it('silent sign-on with prompt=none answers the app with login_required, no code', async () => {
		const browser = new Browser();
		expect((await browser.signIn(PROFILE)).status).toBe(302);
		await setStatus('suspended');

		const res = await browser.authorize(ADMIN, '&prompt=none');
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get('location')!);
		expect(location.origin + location.pathname).toBe(ADMIN.redirect);
		expect(location.searchParams.get('error')).toBe('login_required');
		expect(location.searchParams.get('state')).toBe(`st-${ADMIN.id}`);
		expect(location.searchParams.get('code')).toBeNull();
	});

	it('a code minted before the suspension cannot be redeemed', async () => {
		const browser = new Browser();
		const res = await browser.signIn(PROFILE);
		const code = codeOf(res)!;
		await setStatus('suspended');

		const tokenRes = await browser.exchange(PROFILE, code);
		expect(tokenRes.status).toBe(400);
		expect(((await tokenRes.json()) as { error: string }).error).toBe('invalid_grant');

		// Reinstating does not bring the code back
		await setStatus('active');
		expect((await browser.exchange(PROFILE, code)).status).toBe(400);
	});

	it('the refresh grant is refused, and stays refused after reinstatement', async () => {
		const tokens = await signedInTokens(new Browser());
		await setStatus('suspended');

		const res = await refresh(PROFILE, tokens.refresh_token);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');

		await setStatus('active');
		expect((await refresh(PROFILE, tokens.refresh_token)).status).toBe(400);
	});

	it('an active account refreshes as before', async () => {
		const tokens = await signedInTokens(new Browser());
		const res = await refresh(PROFILE, tokens.refresh_token);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { access_token?: string }).access_token).toBeTruthy();
	});

	it('silent sign-on of a deleted account is refused, not re-created as a new user', async () => {
		const browser = new Browser();
		expect((await browser.signIn(PROFILE)).status).toBe(302);
		const id = await userId();
		await db().prepare(`UPDATE users SET status = 'deleted', deleted_at = ? WHERE id = ?`).bind(Date.now(), id).run();
		try {
			const res = await browser.authorize(ADMIN);
			expect(res.status).toBe(403);
			const count = await db().prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').bind(EMAIL).first<{ n: number }>();
			expect(count?.n).toBe(1);
		} finally {
			await db().prepare(`UPDATE users SET status = 'active', deleted_at = NULL WHERE id = ?`).bind(id).run();
		}
	});
});
