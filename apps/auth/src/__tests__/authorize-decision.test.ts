/**
 * "If you are signed in, you are signed in": what /authorize does with an
 * existing browser session, pinned through the real worker (router -> the
 * openauth enterprise issuer's prompt handling), plus credentialed CORS on
 * the accounts API the apps call from the browser.
 *
 * - signed in (one or more accounts), no prompt -> silent code for the ACTIVE account
 * - after POST /session/switch -> silent code for the new active account
 * - prompt=select_account -> the account chooser (only then)
 * - prompt=login -> the sign-in form (add account)
 * - prompt=none without a session -> redirect_uri?error=login_required
 * - after /logout -> no silent code
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../index';
import { setupDatabase } from '../test-setup';
import { PROFILE, ADMIN, registerTestClients } from './helpers/clients';
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { ScryptHasher } from '@al-ummah-now/openauth/provider/password';
import { isAllowedOrigin, matchOrigin } from '../utils/cors';
import prodConfig from '../../wrangler.json';
import qaConfig from '../../wrangler.qa.json';

const ISSUER = 'http://localhost:3301';
const ALICE = { email: 'decision-alice@example.com', password: 'Decision-Alice-123!' };
const BOB = { email: 'decision-bob@example.com', password: 'Decision-Bob-123!' };

type Client = { id: string; redirect: string };

class Browser {
	jar = new Map<string, string>();
	async fetch(path: string, init: RequestInit = {}, workerEnv: Env = env as unknown as Env) {
		const headers = new Headers(init.headers);
		headers.set('host', new URL(ISSUER).host);
		headers.set('cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
		const ctx = createExecutionContext();
		const res = await worker.fetch(new Request(new URL(path, ISSUER), { ...init, headers, redirect: 'manual' }), workerEnv, ctx);
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
	/** GET /authorize for `client`; returns the redirect target. */
	async authorize(client: Client, prompt?: string) {
		const params = new URLSearchParams({
			client_id: client.id,
			response_type: 'code',
			provider: 'password',
			state: client.id,
			redirect_uri: client.redirect,
		});
		if (prompt) params.set('prompt', prompt);
		const res = await this.fetch(`/authorize?${params}`);
		expect(res.status).toBe(302);
		return new URL(res.headers.get('location')!, ISSUER);
	}
	/** Completes the password form that `login` points at. */
	async submitForm(login: URL, who: { email: string; password: string }) {
		expect(login.pathname).toBe('/password/authorize');
		const res = await this.fetch(login.pathname + login.search, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ email: who.email, password: who.password }).toString(),
		});
		expect(res.status).toBe(302);
		return new URL(res.headers.get('location')!, ISSUER);
	}
	async accounts() {
		const res = await this.fetch('/session/accounts');
		if (res.status !== 200) return { status: res.status, accounts: [] as Account[] };
		return { status: 200, accounts: ((await res.json()) as { accounts: Account[] }).accounts };
	}
}

type Account = { userId: string; isActive: boolean; email: string };

/** The signed-in user a code belongs to: exchanges it (as the apps do) and reads the access token. */
async function codeOwner(callback: URL, client: Client): Promise<string> {
	expect(callback.origin + callback.pathname).toBe(client.redirect);
	const code = callback.searchParams.get('code');
	expect(code, `expected a code, got ${callback}`).toBeTruthy();
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(`${ISSUER}/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', host: new URL(ISSUER).host },
			body: new URLSearchParams({ grant_type: 'authorization_code', code: code!, redirect_uri: client.redirect, client_id: client.id }).toString(),
		}),
		env as unknown as Env,
		ctx
	);
	await waitOnExecutionContext(ctx);
	expect(res.status).toBe(200);
	const { access_token } = (await res.json()) as { access_token: string };
	const payload = JSON.parse(atob(access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
	return payload.properties.email as string;
}

/** A browser signed in as Alice, then Bob added with prompt=login (Bob active). */
async function twoAccountBrowser() {
	const browser = new Browser();
	await browser.submitForm(await browser.authorize(PROFILE), ALICE);
	const add = await browser.authorize(PROFILE, 'login');
	await browser.submitForm(add, BOB);
	return browser;
}

describe('/authorize with an existing browser session (issuer as deployed)', () => {
	beforeAll(async () => {
		await setupDatabase();
		await registerTestClients();
		const storage = CloudflarePatchedStorage({ namespace: env.AUTH_STORAGE });
		for (const who of [ALICE, BOB]) {
			await Storage.set(storage, ['email', who.email, 'password'], await ScryptHasher().hash(who.password));
		}
	});

	it('no session -> the sign-in form', async () => {
		expect((await new Browser().authorize(ADMIN)).pathname).toBe('/password/authorize');
	});

	it('one account -> silent code for it in another app', async () => {
		const browser = new Browser();
		await browser.submitForm(await browser.authorize(PROFILE), ALICE);
		expect(await codeOwner(await browser.authorize(ADMIN), ADMIN)).toBe(ALICE.email);
	});

	it('prompt=login while signed in -> the form, and the added account becomes active', async () => {
		const browser = await twoAccountBrowser();
		const { accounts } = await browser.accounts();
		expect(accounts.map((a) => a.email).sort()).toEqual([ALICE.email, BOB.email].sort());
		expect(accounts.find((a) => a.isActive)?.email).toBe(BOB.email);
		// lastUsed is a real recent date (authenticatedAt is epoch milliseconds)
		for (const a of accounts as Array<Account & { lastUsed: string }>) {
			expect(Math.abs(Date.parse(a.lastUsed) - Date.now())).toBeLessThan(60 * 60 * 1000);
		}
	});

	it('two accounts, no prompt -> silent code for the ACTIVE account, never the chooser', async () => {
		const browser = await twoAccountBrowser();
		const target = await browser.authorize(ADMIN);
		expect(target.pathname).not.toBe('/select-account');
		expect(target.searchParams.get('prompt')).toBeNull();
		expect(await codeOwner(target, ADMIN)).toBe(BOB.email);
	});

	it('POST /session/switch -> the next silent code is for the new active account', async () => {
		const browser = await twoAccountBrowser();
		const alice = (await browser.accounts()).accounts.find((a) => a.email === ALICE.email)!;
		const res = await browser.fetch('/session/switch', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ userId: alice.userId }),
		});
		expect(res.status).toBe(200);
		expect(await codeOwner(await browser.authorize(ADMIN), ADMIN)).toBe(ALICE.email);
		expect(await codeOwner(await browser.authorize(PROFILE, 'none'), PROFILE)).toBe(ALICE.email);
	});

	it('DELETE /session/accounts/:userId of the active account -> silent code for the one left', async () => {
		const browser = await twoAccountBrowser();
		const bob = (await browser.accounts()).accounts.find((a) => a.email === BOB.email)!;
		const res = await browser.fetch(`/session/accounts/${encodeURIComponent(bob.userId)}`, { method: 'DELETE' });
		expect(res.status).toBe(200);
		const { accounts } = await browser.accounts();
		expect(accounts.map((a) => [a.email, a.isActive])).toEqual([[ALICE.email, true]]);
		expect(await codeOwner(await browser.authorize(ADMIN, 'none'), ADMIN)).toBe(ALICE.email);
	});

	it('DELETE of a non-active account keeps the active one', async () => {
		const browser = await twoAccountBrowser();
		const alice = (await browser.accounts()).accounts.find((a) => a.email === ALICE.email)!;
		expect((await browser.fetch(`/session/accounts/${encodeURIComponent(alice.userId)}`, { method: 'DELETE' })).status).toBe(200);
		expect((await browser.accounts()).accounts.map((a) => [a.email, a.isActive])).toEqual([[BOB.email, true]]);
		expect(await codeOwner(await browser.authorize(ADMIN), ADMIN)).toBe(BOB.email);
	});

	it('prompt=select_account -> the account chooser', async () => {
		const browser = await twoAccountBrowser();
		const res = await browser.fetch(
			`/authorize?${new URLSearchParams({ client_id: ADMIN.id, response_type: 'code', state: 's', redirect_uri: ADMIN.redirect, prompt: 'select_account' })}`
		);
		const location = res.headers.get('location');
		// Either the chooser page itself or a redirect to it; never a code.
		if (res.status === 302) {
			expect(new URL(location!, ISSUER).pathname).toBe('/select-account');
		} else {
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain(ALICE.email);
			expect(html).toContain(BOB.email);
		}
		expect(location ?? '').not.toContain('code=');
	});

	it('prompt=none without a session -> error=login_required, no UI', async () => {
		const target = await new Browser().authorize(ADMIN, 'none');
		expect(target.origin + target.pathname).toBe(ADMIN.redirect);
		expect(target.searchParams.get('error')).toBe('login_required');
		expect(target.searchParams.get('code')).toBeNull();
	});

	it('after /logout -> no silent code (form, and prompt=none is login_required)', async () => {
		const browser = await twoAccountBrowser();
		await browser.fetch(`/logout?return=${encodeURIComponent('http://localhost:5175/')}`);
		expect(browser.jar.has('__session')).toBe(false);
		expect((await browser.authorize(ADMIN)).pathname).toBe('/password/authorize');
		expect((await browser.authorize(PROFILE, 'none')).searchParams.get('error')).toBe('login_required');
		// Signed out: the accounts probe answers 200 with an empty list, never an error
		expect(await browser.accounts()).toEqual({ status: 200, accounts: [] });
	});
});

describe('accounts API CORS (credentialed, per env allowlist)', () => {
	const QA_ORIGINS = (qaConfig as { vars: { ALLOWED_ORIGINS: string } }).vars.ALLOWED_ORIGINS;
	const qaEnv = () => ({ ...(env as unknown as Env), ALLOWED_ORIGINS: QA_ORIGINS }) as Env;
	const VIDEOS = 'https://videos.qa.alummahnow.net';

	async function signedIn() {
		const browser = await twoAccountBrowser();
		const alice = (await browser.accounts()).accounts.find((a) => a.email === ALICE.email)!;
		return { browser, alice };
	}

	function expectCors(res: Response, origin: string) {
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
		expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
	}

	it('GET /session/accounts', async () => {
		const { browser } = await signedIn();
		const res = await browser.fetch('/session/accounts', { headers: { Origin: VIDEOS } }, qaEnv());
		expect(res.status).toBe(200);
		expectCors(res, VIDEOS);
	});

	it('POST /session/switch and its preflight', async () => {
		const { browser, alice } = await signedIn();
		const pre = await browser.fetch(
			'/session/switch',
			{ method: 'OPTIONS', headers: { Origin: VIDEOS, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } },
			qaEnv()
		);
		expect(pre.status).toBe(204);
		expectCors(pre, VIDEOS);
		expect(pre.headers.get('Access-Control-Allow-Methods')).toContain('POST');
		expect(pre.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('content-type');

		const res = await browser.fetch(
			'/session/switch',
			{ method: 'POST', headers: { Origin: VIDEOS, 'content-type': 'application/json' }, body: JSON.stringify({ userId: alice.userId }) },
			qaEnv()
		);
		expect(res.status).toBe(200);
		expectCors(res, VIDEOS);
	});

	it('DELETE /session/accounts/:userId and its preflight', async () => {
		const { browser, alice } = await signedIn();
		const path = `/session/accounts/${encodeURIComponent(alice.userId)}`;
		const pre = await browser.fetch(path, { method: 'OPTIONS', headers: { Origin: VIDEOS, 'Access-Control-Request-Method': 'DELETE' } }, qaEnv());
		expect(pre.status).toBe(204);
		expectCors(pre, VIDEOS);
		expect(pre.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');

		const res = await browser.fetch(path, { method: 'DELETE', headers: { Origin: VIDEOS } }, qaEnv());
		expect(res.status).toBe(200);
		expectCors(res, VIDEOS);
	});

	it('no browser session: 200 with an empty list (no console error for anonymous visitors), with CORS, never cached', async () => {
		const res = await new Browser().fetch('/session/accounts', { headers: { Origin: VIDEOS } }, qaEnv());
		expect(res.status).toBe(200);
		expectCors(res, VIDEOS);
		expect(res.headers.get('Content-Type')).toContain('application/json');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		// Nothing but an empty list: no error text, no other browser's sessions
		expect(await res.json()).toEqual({ accounts: [] });
	});

	it('a stale or forged __session cookie is also just an empty list', async () => {
		const browser = new Browser();
		browser.jar.set('__session', 'not-a-real-session');
		const res = await browser.fetch('/session/accounts', { headers: { Origin: VIDEOS } }, qaEnv());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ accounts: [] });
	});

	it('the other session APIs still refuse an anonymous browser (401)', async () => {
		const browser = new Browser();
		const sw = await browser.fetch(
			'/session/switch',
			{ method: 'POST', headers: { Origin: VIDEOS, 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'someone' }) },
			qaEnv()
		);
		expect(sw.status).toBe(401);
		expectCors(sw, VIDEOS);
		const del = await browser.fetch('/session/accounts/someone', { method: 'DELETE', headers: { Origin: VIDEOS } }, qaEnv());
		expect(del.status).toBe(401);
	});

	it('a foreign origin gets no CORS grant', async () => {
		const { browser } = await signedIn();
		for (const origin of ['https://evil.example', 'https://evilqa.alummahnow.net']) {
			const res = await browser.fetch('/session/accounts', { headers: { Origin: origin } }, qaEnv());
			expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
			const pre = await browser.fetch('/session/switch', { method: 'OPTIONS', headers: { Origin: origin } }, qaEnv());
			expect(pre.headers.get('Access-Control-Allow-Origin')).toBeNull();
		}
	});
});

describe('isAllowedOrigin (per env)', () => {
	const prod = (prodConfig as { env: { production: { vars: { ALLOWED_ORIGINS: string } } } }).env.production.vars;
	const stage = (prodConfig as { env: { stage: { vars: { ALLOWED_ORIGINS: string } } } }).env.stage.vars;
	const qa = (qaConfig as { vars: { ALLOWED_ORIGINS: string } }).vars;

	it('QA allows every *.qa.alummahnow.net app', () => {
		for (const host of ['videos', 'admin', 'www', 'cms', 'profile.auth', 'admin.auth']) {
			expect(isAllowedOrigin(`https://${host}.qa.alummahnow.net`, qa)).toBe(true);
		}
		expect(isAllowedOrigin('https://videos.stage.alummahnow.net', qa)).toBe(false);
		expect(isAllowedOrigin('https://videos.alummahnow.net', qa)).toBe(false);
	});

	it('stage allows *.stage.alummahnow.net only', () => {
		expect(isAllowedOrigin('https://videos.stage.alummahnow.net', stage)).toBe(true);
		expect(isAllowedOrigin('https://profile.auth.stage.alummahnow.net', stage)).toBe(true);
		expect(isAllowedOrigin('https://videos.qa.alummahnow.net', stage)).toBe(false);
		expect(isAllowedOrigin('https://videos.alummahnow.net', stage)).toBe(false);
	});

	it('prod allows *.alummahnow.net, the apex and www', () => {
		for (const origin of ['https://videos.alummahnow.net', 'https://alummahnow.net', 'https://www.alummahnow.net', 'https://profile.auth.alummahnow.net']) {
			expect(isAllowedOrigin(origin, prod)).toBe(true);
		}
	});

	it('rejects non-alummahnow origins, look-alikes, http and missing origins in every env', () => {
		for (const vars of [prod, stage, qa]) {
			for (const origin of [
				'https://evil.example',
				'https://evilalummahnow.net',
				'https://alummahnow.net.evil.example',
				'https://evilqa.alummahnow.net.example',
				'http://videos.qa.alummahnow.net',
				'http://videos.alummahnow.net',
				'null',
				'',
			]) {
				expect(isAllowedOrigin(origin, vars), `${origin} vs ${vars.ALLOWED_ORIGINS}`).toBe(false);
			}
			expect(isAllowedOrigin(null, vars)).toBe(false);
		}
	});

	it('matchOrigin: wildcard needs a dot boundary; exact entries match exactly', () => {
		expect(matchOrigin('https://a.example.com', ['*.example.com'])).toBe(true);
		expect(matchOrigin('https://example.com', ['*.example.com'])).toBe(false);
		expect(matchOrigin('https://badexample.com', ['*.example.com'])).toBe(false);
		expect(matchOrigin('https://a.example.com/path', ['*.example.com'])).toBe(false);
		expect(matchOrigin('https://app.example.com', ['https://app.example.com'])).toBe(true);
		expect(matchOrigin('https://app.example.com:8443', ['https://app.example.com'])).toBe(false);
	});
});
