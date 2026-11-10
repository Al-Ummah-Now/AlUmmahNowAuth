/**
 * Sign-in pages through the real Worker (router, enterprise issuer, PasswordProvider):
 *
 * - English on every page unless the link says ?lang=ar, whatever the browser's
 *   Accept-Language (Auth #261, openauth 1.0.30);
 * - concurrent English and Arabic requests each keep their own lang/dir
 *   (the theme/locale used to live in a global shared by the isolate);
 * - a completed "forgot password" reset ends the user's browser sign-ins and
 *   revokes their tokens (Auth #265), wired through the provider's hook.
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
import { readRevocation } from '../revocation/revocation-list';

const ORIGIN = 'http://localhost';
const ARABIC_BROWSER = { 'accept-language': 'ar-SA,ar;q=0.9,en;q=0.1' };
const PAGES = ['/password/authorize', '/password/register', '/password/change'] as const;

type Jar = Map<string, string>;

const E = (): Env =>
	({
		...(env as unknown as Env),
		ENVIRONMENT: 'development',
		OPENAUTH_ISSUER: ORIGIN,
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

const form = (fields: Record<string, string>, headers: Record<string, string> = {}): RequestInit => ({
	method: 'POST',
	headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
	body: new URLSearchParams(fields).toString(),
});

/** Starts a profile sign-in; returns its cookies and the provider pages' query (auth_flow). */
async function startFlow(): Promise<{ jar: Jar; query: string }> {
	const jar: Jar = new Map();
	const res = await call(
		`/authorize?client_id=${PROFILE.id}&redirect_uri=${encodeURIComponent(PROFILE.redirect)}&response_type=code&provider=password`,
		jar
	);
	expect(res.status).toBe(302);
	return { jar, query: new URL(res.headers.get('location')!, ORIGIN).search };
}

async function page(path: string, headers: Record<string, string> = {}, lang?: string) {
	const { jar, query } = await startFlow();
	const res = await call(`${path}${query}${lang ? `&lang=${lang}` : ''}`, jar, { headers });
	expect(res.status).toBe(200);
	return res.text();
}

function expectEnglish(html: string) {
	expect(html).toContain('lang="en"');
	expect(html).toContain('dir="ltr"');
	expect(html).toContain('Continue');
	expect(html).not.toContain('متابعة');
}

function expectArabic(html: string) {
	expect(html).toContain('lang="ar"');
	expect(html).toContain('dir="rtl"');
	expect(html).toContain('متابعة');
	expect(html).not.toContain('>Continue<');
}

async function createAccount(email: string, password: string) {
	await Storage.set(CloudflarePatchedStorage({ namespace: env.AUTH_STORAGE }), ['email', email, 'password'], await ScryptHasher().hash(password));
}

beforeAll(async () => {
	await registerTestClients();
});

beforeEach(async () => {
	await env.AUTH_DB.prepare('DELETE FROM password_codes').run();
});

describe('sign-in pages are English unless the link asks for Arabic', () => {
	for (const path of PAGES) {
		it(`${path}: English for an Arabic browser with no ?lang`, async () => {
			expectEnglish(await page(path, ARABIC_BROWSER));
		});

		it(`${path}: English for an unsupported ?lang`, async () => {
			expectEnglish(await page(path, ARABIC_BROWSER, 'fr'));
		});

		it(`${path}: Arabic, right to left, for ?lang=ar`, async () => {
			expectArabic(await page(path, {}, 'ar'));
		});
	}

	it('the code screen: English by default, Arabic (with the Arabic code label) for ?lang=ar', async () => {
		const email = `lang-${crypto.randomUUID().slice(0, 8)}@e2e.alummahnow.net`;
		await createAccount(email, 'Original-pass-123');

		const en = await startFlow();
		const enHtml = await (await call(`/password/change${en.query}`, en.jar, form({ action: 'code', email }, ARABIC_BROWSER))).text();
		expect(enHtml).toContain('name="code"');
		expectEnglish(enHtml);
		expect(enHtml).toContain('Code (check your inbox)');

		const ar = await startFlow();
		const arHtml = await (await call(`/password/change${ar.query}&lang=ar`, ar.jar, form({ action: 'code', email }))).text();
		expect(arHtml).toContain('name="code"');
		expectArabic(arHtml);
		expect(arHtml).not.toContain('Code (check your inbox)');
		expect(arHtml).toContain('الرمز');
	});
});

describe('concurrent English and Arabic sign-ins', () => {
	it('40 interleaved requests each render their own language and direction', async () => {
		const flows = await Promise.all(Array.from({ length: 40 }, () => startFlow()));
		const pages = await Promise.all(
			flows.map(({ jar, query }, i) =>
				call(`${PAGES[i % PAGES.length]}${query}${i % 2 ? '&lang=ar' : ''}`, jar, { headers: ARABIC_BROWSER }).then((r) => r.text())
			)
		);
		pages.forEach((html, i) => (i % 2 ? expectArabic(html) : expectEnglish(html)));
	}, 30_000);
});

describe('a completed password reset ends the browser sign-ins (#265)', () => {
	it('deletes every account session of that user, clears it as the active account and revokes its tokens', async () => {
		const email = `reset-${crypto.randomUUID().slice(0, 8)}@e2e.alummahnow.net`;
		const userId = `usr_${crypto.randomUUID().replace(/-/g, '')}`;
		const otherId = `usr_${crypto.randomUUID().replace(/-/g, '')}`;
		const ts = Date.now();
		await createAccount(email, 'Original-pass-123');
		await env.AUTH_DB.prepare(`INSERT INTO users (id, tenant_id, email, status, created_at, updated_at) VALUES (?, 'default', ?, 'active', ?, ?)`)
			.bind(userId, email, ts, ts)
			.run();
		// Two browsers signed in as the user, one as somebody else
		for (const [browser, user] of [
			[`bs_${userId}_1`, userId],
			[`bs_${userId}_2`, userId],
			[`bs_${otherId}`, otherId],
		]) {
			await env.AUTH_DB.prepare(
				`INSERT INTO browser_sessions (id, tenant_id, created_at, last_activity, active_user_id) VALUES (?, 'default', ?, ?, ?)`
			)
				.bind(browser, ts, ts, user)
				.run();
			await env.AUTH_DB.prepare(
				`INSERT INTO account_sessions (id, browser_session_id, user_id, is_active, authenticated_at, expires_at, subject_type, refresh_token, client_id) VALUES (?, ?, ?, 1, ?, ?, 'user', 'rt', 'web')`
			)
				.bind(`as_${browser}`, browser, user, ts, ts + 86_400_000)
				.run();
		}
		const sessions = async (id: string) =>
			(await env.AUTH_DB.prepare('SELECT COUNT(*) AS n FROM account_sessions WHERE user_id = ?').bind(id).first<{ n: number }>())!.n;
		const active = async (browser: string) =>
			(await env.AUTH_DB.prepare('SELECT active_user_id AS u FROM browser_sessions WHERE id = ?').bind(browser).first<{ u: string | null }>())
				?.u ?? null;
		expect(await sessions(userId)).toBe(2);

		const { jar, query } = await startFlow();
		await call(`/password/change${query}`, jar, form({ action: 'code', email }));
		const { code } = JSON.parse((await env.AUTH_STORAGE.get(sinkKey(email)))!);
		expect(await (await call(`/password/change${query}`, jar, form({ action: 'verify', code }))).text()).toContain('name="repeat"');
		await call(`/password/change${query}`, jar, form({ action: 'update', password: 'Changed-pass-456', repeat: 'Changed-pass-456' }));

		expect(await sessions(userId)).toBe(0);
		expect(await active(`bs_${userId}_1`)).toBeNull();
		expect(await active(`bs_${userId}_2`)).toBeNull();
		expect((await readRevocation((env as unknown as Env).TOKEN_REVOCATIONS, userId))?.reason).toBe('password_changed');
		// Nobody else is signed out
		expect(await sessions(otherId)).toBe(1);
		expect(await active(`bs_${otherId}`)).toBe(otherId);
	});

	it('a reset that stops before the new password ends nothing', async () => {
		const email = `half-reset-${crypto.randomUUID().slice(0, 8)}@e2e.alummahnow.net`;
		const userId = `usr_${crypto.randomUUID().replace(/-/g, '')}`;
		const ts = Date.now();
		await createAccount(email, 'Original-pass-123');
		await env.AUTH_DB.prepare(`INSERT INTO users (id, tenant_id, email, status, created_at, updated_at) VALUES (?, 'default', ?, 'active', ?, ?)`)
			.bind(userId, email, ts, ts)
			.run();
		await env.AUTH_DB.prepare(`INSERT INTO browser_sessions (id, tenant_id, created_at, last_activity, active_user_id) VALUES (?, 'default', ?, ?, ?)`)
			.bind(`bs_${userId}`, ts, ts, userId)
			.run();
		await env.AUTH_DB.prepare(
			`INSERT INTO account_sessions (id, browser_session_id, user_id, is_active, authenticated_at, expires_at, subject_type, refresh_token, client_id) VALUES (?, ?, ?, 1, ?, ?, 'user', 'rt', 'web')`
		)
			.bind(`as_${userId}`, `bs_${userId}`, userId, ts, ts + 86_400_000)
			.run();

		const { jar, query } = await startFlow();
		await call(`/password/change${query}`, jar, form({ action: 'code', email }));
		const { code } = JSON.parse((await env.AUTH_STORAGE.get(sinkKey(email)))!);
		await call(`/password/change${query}`, jar, form({ action: 'verify', code }));

		expect((await env.AUTH_DB.prepare('SELECT COUNT(*) AS n FROM account_sessions WHERE user_id = ?').bind(userId).first<{ n: number }>())!.n).toBe(1);
		expect(await readRevocation((env as unknown as Env).TOKEN_REVOCATIONS, userId)).toBeNull();
	});
});
