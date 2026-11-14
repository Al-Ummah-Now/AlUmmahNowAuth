/**
 * Forgot password `/password/change?redirect_uri=` is not an open redirect (#206):
 * after the new password is saved, the browser goes to a same-origin path or to a
 * registered redirect_uri of the named enabled client; anything else goes to the
 * sign-in fallback (the Profile app). Through the real Worker and PasswordProvider.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import '../test-setup';
import worker from '../index';
import { registerTestClients, PROFILE } from './helpers/clients';
import { sinkKey } from '../utils/e2e-sink';
import { ScryptHasher } from '@al-ummah-now/openauth/provider/password';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import { isSameOriginPath, safePasswordChangeRequest } from '../security/password-change-redirect';

const ORIGIN = 'http://localhost';
const FALLBACK = 'https://profile.example.test/';
type Jar = Map<string, string>;

const E = (): Env =>
	({
		...(env as unknown as Env),
		ENVIRONMENT: 'development',
		OPENAUTH_ISSUER: ORIGIN,
		SIGN_IN_FALLBACK_URL: FALLBACK,
		E2E_CODE_SINK_SECRET: 'test-sink-secret',
		RESEND_API_KEY: 're_test_unused',
		PASSWORD_IP_LIMITER: undefined,
		PASSWORD_EMAIL_LIMITER: undefined,
	}) as unknown as Env;

const ctx = () =>
	({ waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException: () => {} }) as unknown as ExecutionContext;

async function call(path: string, jar: Jar, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
	headers.set('Host', 'localhost');
	const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: 'manual' }), E(), ctx());
	for (const c of res.headers.getSetCookie()) {
		const [pair] = c.split(';');
		const i = pair.indexOf('=');
		jar.set(pair.slice(0, i), pair.slice(i + 1));
	}
	return res;
}

const form = (fields: Record<string, string>): RequestInit => ({
	method: 'POST',
	headers: { 'content-type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams(fields).toString(),
});

/** Runs a whole forgot-password reset opened with `query`; returns where the browser is sent at the end. */
async function resetAndFollow(query: string): Promise<string | null> {
	const email = `redir-${crypto.randomUUID().slice(0, 8)}@e2e.alummahnow.net`;
	await Storage.set(CloudflarePatchedStorage({ namespace: env.AUTH_STORAGE }), ['email', email, 'password'], await ScryptHasher().hash('Original-pass-123'));
	const jar: Jar = new Map();
	expect((await call(`/password/change?${query}`, jar)).status).toBe(200);
	await call('/password/change', jar, form({ action: 'code', email }));
	const { code } = JSON.parse((await env.AUTH_STORAGE.get(sinkKey(email)))!);
	await call('/password/change', jar, form({ action: 'verify', code }));
	const done = await call('/password/change', jar, form({ action: 'update', password: 'Changed-pass-456', repeat: 'Changed-pass-456' }));
	expect(done.status).toBe(302);
	return done.headers.get('location');
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

beforeAll(async () => {
	await registerTestClients();
});

beforeEach(async () => {
	await env.AUTH_DB.prepare('DELETE FROM password_codes').run();
});

describe('/password/change redirect_uri (#206)', () => {
	it('a foreign URL is replaced with the sign-in fallback', async () => {
		expect(await resetAndFollow(q({ redirect_uri: 'https://evil.example/steal' }))).toBe(FALLBACK);
	});

	it('a foreign URL is refused even with a real client_id', async () => {
		expect(await resetAndFollow(q({ client_id: PROFILE.id, redirect_uri: 'https://evil.example/steal' }))).toBe(FALLBACK);
	});

	it('a protocol-relative or backslash path is refused', async () => {
		expect(await resetAndFollow(q({ redirect_uri: '//evil.example/x' }))).toBe(FALLBACK);
		expect(await resetAndFollow(q({ redirect_uri: '/\\evil.example/x' }))).toBe(FALLBACK);
	});

	it("the client's registered redirect_uri is kept (exact match)", async () => {
		expect(await resetAndFollow(q({ client_id: PROFILE.id, redirect_uri: PROFILE.redirect }))).toBe(PROFILE.redirect);
	});

	it('a same-origin path is kept', async () => {
		// The issuer keeps the page's theme on same-origin redirects
		expect(await resetAndFollow(q({ redirect_uri: '/password/authorize?lang=ar' }))).toMatch(/^\/password\/authorize\?lang=ar(&theme=[a-z-]+)?$/);
	});
});

describe('safePasswordChangeRequest', () => {
	const db = env.AUTH_DB as unknown as D1Database;
	const fix = (path: string, method = 'GET') =>
		safePasswordChangeRequest(new Request(`${ORIGIN}${path}`, { method }), { AUTH_DB: db, SIGN_IN_FALLBACK_URL: FALLBACK });

	it('leaves other paths, POSTs and requests without redirect_uri alone', async () => {
		const evil = encodeURIComponent('https://evil.example');
		expect((await fix(`/password/authorize?redirect_uri=${evil}`)).url).toContain(evil);
		expect((await fix(`/password/change?redirect_uri=${evil}`, 'POST')).url).toContain(evil);
		expect((await fix('/password/change?lang=ar')).url).toBe(`${ORIGIN}/password/change?lang=ar`);
	});

	it('keeps the other query parameters when it swaps redirect_uri', async () => {
		const out = new URL((await fix(`/password/change?lang=ar&redirect_uri=${encodeURIComponent('https://evil.example')}`)).url);
		expect(out.searchParams.get('lang')).toBe('ar');
		expect(out.searchParams.get('redirect_uri')).toBe(FALLBACK);
	});

	it.each(['/', '/a?b=c', '/password/authorize'])('same-origin path %s', (p) => expect(isSameOriginPath(p)).toBe(true));
	it.each(['//evil', '/\\evil', '/\tevil', 'https://evil', 'evil', ''])('not a same-origin path: %j', (p) => expect(isSameOriginPath(p)).toBe(false));
});
