/**
 * Turnstile on the sign-in pages (security/turnstile.ts), end to end through the
 * real Worker with the official test keys: no call ever leaves the test.
 *
 * Harness copied from password-bruteforce.test.ts: AU-2 end to end through the real Worker (src/index.ts: router, OpenAuth issuer,
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
import { TURNSTILE_AFTER_FAILURES } from '../security/password-guard';
import { BYPASS_HEADER, signBypass, TEST_SECRETS, TEST_SITE_KEYS, TEST_TOKEN, TURNSTILE_FIELD } from '../security/turnstile';

const BYPASS_SECRET = 'bypass-secret-for-tests';
const points: string[][] = [];
const turnstileEnv = (extra: Record<string, unknown> = {}) =>
	testEnv({
		TURNSTILE_MODE: 'enforce',
		TURNSTILE_SITE_KEY: TEST_SITE_KEYS.pass,
		TURNSTILE_SECRET: TEST_SECRETS.pass,
		BOT_BYPASS_SECRET: BYPASS_SECRET,
		ABUSE_EVENTS: { writeDataPoint: (p: { blobs?: string[] }) => void points.push(p.blobs ?? []) },
		...extra,
	});

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

/** Every request's waitUntil work, so a test can wait for what runs after the response */
const background: Promise<unknown>[] = [];
const ctx = () =>
	({
		waitUntil: (p: Promise<unknown>) => void background.push(p.catch(() => {})),
		passThroughOnException: () => {},
	}) as unknown as ExecutionContext;

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
async function startFlow(e: Env, page: '/password/authorize' | '/password/change' | '/password/register') {
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
	points.length = 0;
});


const sinkCode = async (email: string) => {
	const raw = await env.AUTH_STORAGE.get(sinkKey(email));
	return raw ? (JSON.parse(raw) as { code: string }).code : null;
};

describe('Turnstile on sign-up', () => {
	it('the page carries the widget and the same-origin stub for the test key; CSP allows challenges.cloudflare.com', async () => {
		const e = turnstileEnv();
		const { jar, query } = await startFlow(e, '/password/register');
		const res = await call(e, `/password/register${query}`, jar, { headers: { Accept: 'text/html' } });
		const html = await res.text();
		expect(html).toContain('data-aun-turnstile');
		expect(html).toContain(`data-sitekey="${TEST_SITE_KEYS.pass}"`);
		expect(html).toContain('data-action="sign_up"');
		expect(html).toContain('"/turnstile/stub.js?onload=aunTurnstileReady&render=explicit"');
		expect(html).not.toContain('challenges.cloudflare.com/turnstile/v0/api.js');
		const csp = res.headers.get('Content-Security-Policy')!;
		expect(csp).toContain("script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com");
		expect(csp).toContain('frame-src https://challenges.cloudflare.com');
	});

	it('Arabic pages get the Arabic widget copy', async () => {
		const e = turnstileEnv();
		const { jar, query } = await startFlow(e, '/password/register');
		const html = await (await call(e, `/password/register${query}&lang=ar`, jar, { headers: { Accept: 'text/html' } })).text();
		expect(html).toContain('data-lang="ar"');
		expect(html).toContain('جارٍ التحقق من أنك لست روبوتًا');
	});

	it('without a token: refused with the en message, no code sent', async () => {
		const e = turnstileEnv();
		const email = `bot-${crypto.randomUUID().slice(0, 8)}@e2e.alummahnow.net`;
		const { jar, query } = await startFlow(e, '/password/register');
		const res = await call(e, `/password/register${query}`, jar, form({ action: 'register', email, password: 'Some-pass-123', repeat: 'Some-pass-123' }));
		expect(res.status).toBe(400);
		const html = await res.text();
		expect(html).toContain('Please confirm that you are not a robot');
		expect(await sinkCode(email)).toBeNull();
		expect(points).toContainEqual(['auth', 'auth.sign_up', 'turnstile_missing', 'development']);
	});

	it('with the test token: the code is sent', async () => {
		const e = turnstileEnv();
		const email = `human-${crypto.randomUUID().slice(0, 8)}@e2e.alummahnow.net`;
		const { jar, query } = await startFlow(e, '/password/register');
		const res = await call(e, `/password/register${query}`, jar, form({ action: 'register', email, password: 'Some-pass-123', repeat: 'Some-pass-123', [TURNSTILE_FIELD]: TEST_TOKEN }));
		expect(await res.text()).toContain('name="code"');
		expect(await sinkCode(email)).toMatch(/^\d{6}$/);
		expect(points).toContainEqual(['auth', 'auth.sign_up', 'turnstile_pass', 'development']);
	});

	it('a failing secret is refused; "monitor" lets it through and counts it', async () => {
		const email = `mon-${crypto.randomUUID().slice(0, 8)}@e2e.alummahnow.net`;
		const enforce = turnstileEnv({ TURNSTILE_SECRET: TEST_SECRETS.fail });
		let flow = await startFlow(enforce, '/password/register');
		let res = await call(enforce, `/password/register${flow.query}`, flow.jar, form({ action: 'register', email, password: 'Some-pass-123', repeat: 'Some-pass-123', [TURNSTILE_FIELD]: TEST_TOKEN }));
		expect(res.status).toBe(400);

		const monitor = turnstileEnv({ TURNSTILE_SECRET: TEST_SECRETS.fail, TURNSTILE_MODE: 'monitor' });
		flow = await startFlow(monitor, '/password/register');
		res = await call(monitor, `/password/register${flow.query}`, flow.jar, form({ action: 'register', email, password: 'Some-pass-123', repeat: 'Some-pass-123', [TURNSTILE_FIELD]: TEST_TOKEN }));
		expect(await res.text()).toContain('name="code"');
		expect(points.filter((p) => p[2] === 'turnstile_fail').length).toBe(2);
	});

	it('a signed bypass header (non-production) skips widget and check; a wrong signature does not', async () => {
		const e = turnstileEnv();
		const email = `e2e-${crypto.randomUUID().slice(0, 8)}@e2e.alummahnow.net`;
		const { jar, query } = await startFlow(e, '/password/register');
		const good = { [BYPASS_HEADER]: await signBypass(BYPASS_SECRET) };
		expect(await (await call(e, `/password/register${query}`, jar, { headers: good })).text()).not.toContain('data-aun-turnstile');
		const bad = { [BYPASS_HEADER]: await signBypass('another-secret') };
		const refused = await call(e, `/password/register${query}`, jar, { ...form({ action: 'register', email, password: 'Some-pass-123', repeat: 'Some-pass-123' }), headers: { 'content-type': 'application/x-www-form-urlencoded', ...bad } });
		expect(refused.status).toBe(400);
		const ok = await call(e, `/password/register${query}`, jar, { ...form({ action: 'register', email, password: 'Some-pass-123', repeat: 'Some-pass-123' }), headers: { 'content-type': 'application/x-www-form-urlencoded', ...good } });
		expect(await ok.text()).toContain('name="code"');
	});

	it('mode off: no widget and no check', async () => {
		const e = turnstileEnv({ TURNSTILE_MODE: 'off' });
		const { jar, query } = await startFlow(e, '/password/register');
		expect(await (await call(e, `/password/register${query}`, jar)).text()).not.toContain('data-aun-turnstile');
	});
});

describe('Turnstile on password reset (email code send)', () => {
	it('sending a code needs a token', async () => {
		const e = turnstileEnv();
		const email = `reset-${crypto.randomUUID().slice(0, 8)}@e2e.alummahnow.net`;
		await createAccount(email, 'Original-pass-123');
		const { jar, query } = await startFlow(e, '/password/change');
		const refused = await call(e, `/password/change${query}`, jar, form({ action: 'code', email }));
		expect(refused.status).toBe(400);
		expect(await sinkCode(email)).toBeNull();
		const sent = await call(e, `/password/change${query}`, jar, form({ action: 'code', email, [TURNSTILE_FIELD]: TEST_TOKEN }));
		const html = await sent.text();
		expect(html).toContain('name="code"');
		expect(html).toContain('data-action="password_reset"');
		expect(await sinkCode(email)).toMatch(/^\d{6}$/);
	});
});

describe('Turnstile on sign-in after failed attempts', () => {
	it(`no widget until ${TURNSTILE_AFTER_FAILURES} failures, then a token is required`, async () => {
		const e = turnstileEnv();
		const email = `signin-${crypto.randomUUID().slice(0, 8)}@example.com`;
		await createAccount(email, 'Right-pass-123');
		const { jar, query } = await startFlow(e, '/password/authorize');
		expect(await (await call(e, `/password/authorize${query}`, jar)).text()).not.toContain('data-aun-turnstile');

		for (let i = 1; i <= TURNSTILE_AFTER_FAILURES; i++) {
			const res = await call(e, `/password/authorize${query}`, new Map(jar), form({ email, password: 'wrong' }), '198.51.100.9', false);
			expect(res.status).toBe(401);
			expect((await res.text()).includes('data-aun-turnstile')).toBe(i >= TURNSTILE_AFTER_FAILURES);
		}
		const noToken = await call(e, `/password/authorize${query}`, new Map(jar), form({ email, password: 'Right-pass-123' }), '198.51.100.9', false);
		expect(noToken.status).toBe(400);
		const html = await noToken.text();
		expect(html).toContain('Please confirm that you are not a robot');
		expect(html).toContain('data-action="sign_in"');
		// The refused post did not use up an attempt
		const row = await env.AUTH_DB.prepare('SELECT failures FROM password_login_attempts WHERE email = ?').bind(email).first<{ failures: number }>();
		expect(row?.failures).toBe(TURNSTILE_AFTER_FAILURES);

		const withToken = await call(e, `/password/authorize${query}`, new Map(jar), form({ email, password: 'Right-pass-123', [TURNSTILE_FIELD]: TEST_TOKEN }), '198.51.100.9', false);
		expect(withToken.status).toBe(302);
	});
});

describe('scripted clients', () => {
	it('production with Turnstile enforced refuses curl on the password posts', async () => {
		const prod = turnstileEnv({ ENVIRONMENT: 'production', SESSION_SECRET: 'a'.repeat(64), TURNSTILE_SITE_KEY: '0x4AAAAAAAreal', TURNSTILE_SECRET: '0x4AAAAAAAsecret' });
		const email = `curl-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const curl = { ...form({ email, password: 'x' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'User-Agent': 'curl/8.4.0' } };
		const res = await call(prod, '/password/authorize', new Map(), curl);
		expect(res.status).toBe(403);
		// Flag off (the production default until the owner flips it): not refused
		const off = await call({ ...prod, TURNSTILE_MODE: 'off' } as Env, '/password/authorize', new Map(), curl);
		expect(off.status).not.toBe(403);
		expect(points).toContainEqual(['auth', 'auth.sign_in', 'bad_user_agent', 'production']);
	});

	it('production never serves the stub', async () => {
		const prod = testEnv({ ENVIRONMENT: 'production', SESSION_SECRET: 'a'.repeat(64) });
		expect((await call(prod, '/turnstile/stub.js', new Map())).status).toBe(404);
		expect((await call(testEnv(), '/turnstile/stub.js', new Map())).status).toBe(200);
	});
});
