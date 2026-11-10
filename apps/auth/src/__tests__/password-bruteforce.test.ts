/**
 * AU-2 end to end through the real Worker (src/index.ts: router, OpenAuth issuer,
 * PasswordProvider with the checkCode hook, sendCode with the E2E code sink),
 * with miniflare's D1 and KV.
 *
 * An attacker replays one flow's cookies with hundreds of parallel guesses:
 * - forgot password: no guess reaches the "new password" step, and after the
 *   limit even the right code is refused;
 * - password sign-in: exactly MAX_LOGIN_FAILURES guesses reach the password
 *   check, every other one gets 429, and so does the right password afterwards.
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
import { MAX_CODE_ATTEMPTS, MAX_LOGIN_FAILURES } from '../security/password-attempts';

const ORIGIN = 'http://localhost';
const SINK_SECRET = 'test-sink-secret';

type Jar = Map<string, string>;

function testEnv(extra: Record<string, unknown> = {}): Env {
	return {
		...(env as unknown as Env),
		ENVIRONMENT: 'development',
		OPENAUTH_ISSUER: ORIGIN,
		E2E_CODE_SINK_SECRET: SINK_SECRET,
		RESEND_API_KEY: 're_test_unused',
		PASSWORD_IP_LIMITER: undefined,
		PASSWORD_EMAIL_LIMITER: undefined,
		...extra,
	} as unknown as Env;
}

const ctx = () => {
	const pending: Promise<unknown>[] = [];
	return {
		waitUntil: (p: Promise<unknown>) => void pending.push(p.catch(() => {})),
		passThroughOnException: () => {},
	} as unknown as ExecutionContext;
};

function absorb(res: Response, jar: Jar) {
	for (const c of res.headers.getSetCookie()) {
		const [pair] = c.split(';');
		const i = pair.indexOf('=');
		jar.set(pair.slice(0, i), pair.slice(i + 1));
	}
}
const cookie = (jar: Jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

async function call(e: Env, path: string, jar: Jar, init: RequestInit = {}, ip = '198.51.100.1', keep = true) {
	const headers = new Headers(init.headers);
	headers.set('cookie', cookie(jar));
	headers.set('CF-Connecting-IP', ip);
	headers.set('Host', 'localhost'); // tenant resolution reads Host
	const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: 'manual' }), e, ctx());
	if (keep) absorb(res, jar);
	return res;
}

const form = (fields: Record<string, string>): RequestInit => ({
	method: 'POST',
	headers: { 'content-type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams(fields).toString(),
});

/** /authorize → the provider page; returns the jar and the provider path's query (auth_flow). */
async function startFlow(e: Env, page: '/password/authorize' | '/password/change') {
	const jar: Jar = new Map();
	const authorize = await call(
		e,
		`/authorize?client_id=${PROFILE.id}&redirect_uri=${encodeURIComponent(PROFILE.redirect)}&response_type=code&provider=password`,
		jar
	);
	expect(authorize.status).toBe(302);
	const location = new URL(authorize.headers.get('location')!, ORIGIN);
	const query = location.search;
	const res = await call(e, `${page}${query}`, jar);
	expect(res.status).toBe(200);
	return { jar, query };
}

async function createAccount(email: string, password: string) {
	const hash = await ScryptHasher().hash(password);
	await Storage.set(CloudflarePatchedStorage({ namespace: env.AUTH_STORAGE }), ['email', email, 'password'], hash);
}

beforeAll(async () => {
	await registerTestClients();
});

beforeEach(async () => {
	await env.AUTH_DB.prepare('DELETE FROM password_codes').run();
	await env.AUTH_DB.prepare('DELETE FROM password_login_attempts').run();
});

describe('forgot password: email code brute force', () => {
	it('300 parallel wrong guesses on one flow never reach the new-password step; the right code is then refused', async () => {
		const e = testEnv();
		const email = `victim-${crypto.randomUUID().slice(0, 8)}@e2e.alummahnow.net`;
		await createAccount(email, 'Original-pass-123');
		const { jar, query } = await startFlow(e, '/password/change');

		const sent = await call(e, `/password/change${query}`, jar, form({ action: 'code', email }));
		expect(await sent.text()).toContain('name="code"');
		const { code } = JSON.parse((await env.AUTH_STORAGE.get(sinkKey(email)))!);
		const wrong = code === '000000' ? '000001' : '000000';

		const pages = await Promise.all(
			Array.from({ length: 300 }, () =>
				call(e, `/password/change${query}`, new Map(jar), form({ action: 'verify', code: wrong }), '198.51.100.1', false).then(
					(r) => r.text()
				)
			)
		);
		expect(pages.filter((html) => html.includes('name="repeat"')).length).toBe(0);
		const row = await env.AUTH_DB.prepare('SELECT attempts FROM password_codes WHERE email = ?').bind(email).first<{ attempts: number }>();
		expect(row?.attempts).toBe(MAX_CODE_ATTEMPTS);

		const right = await call(e, `/password/change${query}`, new Map(jar), form({ action: 'verify', code }));
		const html = await right.text();
		expect(html).not.toContain('name="repeat"');
		expect(html).toContain('Request a new code');
	}, 30_000); // 300 requests through the whole Worker: 2-6s locally, over the 5s default

	it('an email without an account answers a guess like an account does (no enumeration)', async () => {
		const e = testEnv();
		const known = `known-${crypto.randomUUID().slice(0, 8)}@e2e.alummahnow.net`;
		const unknown = `unknown-${crypto.randomUUID().slice(0, 8)}@e2e.alummahnow.net`;
		await createAccount(known, 'Original-pass-123');
		const pages: string[] = [];
		for (const email of [known, unknown]) {
			const { jar, query } = await startFlow(e, '/password/change');
			await call(e, `/password/change${query}`, jar, form({ action: 'code', email }));
			const res = await call(e, `/password/change${query}`, jar, form({ action: 'verify', code: '999999' }));
			pages.push((await res.text()).replaceAll(email, 'EMAIL'));
		}
		expect(pages[0]).not.toContain('Request a new code');
		expect(pages[1]).not.toContain('Request a new code');
	});

	it('the right code within the limit still reaches the new-password step', async () => {
		const e = testEnv();
		const email = `user-${crypto.randomUUID().slice(0, 8)}@e2e.alummahnow.net`;
		await createAccount(email, 'Original-pass-123');
		const { jar, query } = await startFlow(e, '/password/change');
		await call(e, `/password/change${query}`, jar, form({ action: 'code', email }));
		const { code } = JSON.parse((await env.AUTH_STORAGE.get(sinkKey(email)))!);
		await call(e, `/password/change${query}`, jar, form({ action: 'verify', code: code === '000000' ? '000001' : '000000' }));
		const res = await call(e, `/password/change${query}`, jar, form({ action: 'verify', code }));
		expect(await res.text()).toContain('name="repeat"');
	});
});

describe('password sign-in brute force', () => {
	it(`200 parallel wrong passwords: exactly ${MAX_LOGIN_FAILURES} are checked, the rest get 429, then the right one too`, async () => {
		const e = testEnv();
		const email = `stuffed-${crypto.randomUUID().slice(0, 8)}@example.com`;
		await createAccount(email, 'Right-pass-123');
		const { jar, query } = await startFlow(e, '/password/authorize');

		const statuses = await Promise.all(
			Array.from({ length: 200 }, () =>
				call(e, `/password/authorize${query}`, new Map(jar), form({ email, password: 'wrong-guess' }), '198.51.100.1', false).then(
					(r) => r.status
				)
			)
		);
		expect(statuses.filter((s) => s === 401).length).toBe(MAX_LOGIN_FAILURES);
		expect(statuses.filter((s) => s === 429).length).toBe(200 - MAX_LOGIN_FAILURES);

		const right = await call(e, `/password/authorize${query}`, new Map(jar), form({ email, password: 'Right-pass-123' }));
		expect(right.status).toBe(429);
		expect(right.headers.get('Retry-After')).toBe('60');
		const html = await right.text();
		expect(html).toContain('Too many attempts');
		expect(html).toContain(email); // the form keeps the email
	});

	it('a percent-encoded path (Hono decodes it to the login route) is limited too', async () => {
		const e = testEnv();
		const email = `enc-${crypto.randomUUID().slice(0, 8)}@example.com`;
		await createAccount(email, 'Right-pass-123');
		const { jar, query } = await startFlow(e, '/password/authorize');
		const statuses: number[] = [];
		for (let i = 0; i < MAX_LOGIN_FAILURES + 2; i++) {
			statuses.push((await call(e, `/password/%61uthorize${query}`, new Map(jar), form({ email, password: 'wrong' }), '198.51.100.1', false)).status);
		}
		expect(statuses.filter((s) => s === 401).length).toBe(MAX_LOGIN_FAILURES);
		expect(statuses.slice(-2)).toEqual([429, 429]);
	});

	it('the right password signs in and does not use up a slot', async () => {
		const e = testEnv();
		const email = `fine-${crypto.randomUUID().slice(0, 8)}@example.com`;
		await createAccount(email, 'Right-pass-123');
		const { jar, query } = await startFlow(e, '/password/authorize');
		const res = await call(e, `/password/authorize${query}`, jar, form({ email, password: 'Right-pass-123' }));
		expect(res.status).toBeGreaterThanOrEqual(300);
		expect(res.status).toBeLessThan(400);
		const row = await env.AUTH_DB.prepare('SELECT failures FROM password_login_attempts WHERE email = ?').bind(email).first<{
			failures: number;
		}>();
		expect(row?.failures).toBe(0);
	});

	it('Arabic pages get the Arabic message', async () => {
		const e = testEnv();
		const email = `ar-${crypto.randomUUID().slice(0, 8)}@example.com`;
		for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
			await env.AUTH_DB.prepare(
				`INSERT INTO password_login_attempts (email, window_start, failures) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET failures = excluded.failures`
			)
				.bind(email, Math.floor(Date.now() / 1000), MAX_LOGIN_FAILURES)
				.run();
		}
		const { jar, query } = await startFlow(e, '/password/authorize');
		const res = await call(e, `/password/authorize${query}&lang=ar`, jar, form({ email, password: 'x' }));
		expect(res.status).toBe(429);
		expect(await res.text()).toContain('محاولات كثيرة جدًا');
	});
});

describe('throttled register resend', () => {
	it('a throttled "send again" on the code screen sends no code', async () => {
		const e = testEnv();
		const email = `resend-${crypto.randomUUID().slice(0, 8)}@e2e.alummahnow.net`;
		const jar: Jar = new Map();
		const authorize = await call(
			e,
			`/authorize?client_id=${PROFILE.id}&redirect_uri=${encodeURIComponent(PROFILE.redirect)}&response_type=code&provider=password`,
			jar
		);
		const query = new URL(authorize.headers.get('location')!, ORIGIN).search;
		await call(e, `/password/register${query}`, jar);
		const fields = { action: 'register', email, password: 'Sup3r-secret-pw', repeat: 'Sup3r-secret-pw' };
		expect(await (await call(e, `/password/register${query}`, jar, form(fields))).text()).toContain('name="code"');
		await env.AUTH_STORAGE.delete(sinkKey(email));

		// Now every POST is over the IP limit
		const throttled = testEnv({ PASSWORD_IP_LIMITER: { limit: async () => ({ success: false }) } });
		const res = await call(throttled, `/password/register${query}`, jar, form({ action: 'register' }));
		expect(res.status).toBe(429);
		const html = await res.text();
		expect(html).toContain('name="code"'); // still on the code screen
		expect(html).toContain('Too many attempts');
		expect(await env.AUTH_STORAGE.get(sinkKey(email))).toBeNull(); // nothing sent
	});
});

describe('Workers Rate Limiting on /password/* POSTs', () => {
	function fakeLimiter(limit: number) {
		const counts = new Map<string, number>();
		return {
			keys: counts,
			async limit({ key }: { key: string }) {
				const n = (counts.get(key) ?? 0) + 1;
				counts.set(key, n);
				return { success: n <= limit };
			},
		};
	}

	it('per IP: over the limit the POST is refused before the password is checked', async () => {
		const ip = fakeLimiter(3);
		const e = testEnv({ PASSWORD_IP_LIMITER: ip, PASSWORD_EMAIL_LIMITER: fakeLimiter(100) });
		const email = `ip-${crypto.randomUUID().slice(0, 8)}@example.com`;
		await createAccount(email, 'Right-pass-123');
		const { jar, query } = await startFlow(e, '/password/authorize');
		const statuses: number[] = [];
		for (let i = 0; i < 5; i++) {
			statuses.push((await call(e, `/password/authorize${query}`, new Map(jar), form({ email, password: 'nope' }), '203.0.113.9', false)).status);
		}
		expect(statuses).toEqual([401, 401, 401, 429, 429]);
		expect([...ip.keys.keys()]).toEqual(['ip:203.0.113.9']);
	});

	it('per email: keyed by the lower-cased email', async () => {
		const byEmail = fakeLimiter(2);
		const e = testEnv({ PASSWORD_IP_LIMITER: fakeLimiter(100), PASSWORD_EMAIL_LIMITER: byEmail });
		const email = `em-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const { jar, query } = await startFlow(e, '/password/authorize');
		const statuses: number[] = [];
		for (const variant of [email, email.toUpperCase(), email]) {
			statuses.push((await call(e, `/password/authorize${query}`, new Map(jar), form({ email: variant, password: 'nope' }), '203.0.113.10', false)).status);
		}
		expect(statuses).toEqual([401, 401, 429]);
		expect([...byEmail.keys.keys()]).toEqual([`email:${email}`]);
	});
});
