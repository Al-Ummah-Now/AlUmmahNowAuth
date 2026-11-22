/**
 * Features that need an emailed code are hidden when Auth can't send email
 * (RESEND_API_KEY doesn't resolve): owner rule "if any config blocks a
 * feature, that feature is hidden" (utils/email-availability.ts).
 *
 * Through the real worker with miniflare's D1 and KV, the key present and absent:
 * - the sign-in page: "Register" and "Forgot password?" shown / left out (en + ar);
 * - /password/register and /password/change: 200 / 404, GET and POST;
 * - a staff member's first passkey (confirmed only by an emailed code): the
 *   after-sign-in card, /passkeys/setup and /passkeys/email-code shown / 404;
 *   everyone else's passkey pages are unchanged.
 * No email provider is called: with the key present no test sends a code.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { mockResend } from './helpers/mock-resend';
import worker from '../index';
import '../test-setup';
import { PROFILE, registerTestClients } from './helpers/clients';
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { ScryptHasher } from '@al-ummah-now/openauth/provider/password';
import { isEmailAvailable, isEmailOnlyPasswordRoute } from '../utils/email-availability';

const ISSUER = 'http://localhost:3301';
const PASSWORD = 'Email-Unconfigured-123!';

function testEnv(extra: Record<string, unknown> = {}): Env {
	return { ...(env as object), ENVIRONMENT: 'development', OPENAUTH_ISSUER: ISSUER, ...extra } as unknown as Env;
}
const WITH_KEY = testEnv({ RESEND_API_KEY: 're_test_unused' });
const NO_KEY = testEnv({ RESEND_API_KEY: '' });

class Browser {
	jar = new Map<string, string>();
	constructor(private e: Env) {}
	async fetch(path: string, init: RequestInit = {}) {
		const headers = new Headers(init.headers);
		headers.set('host', new URL(ISSUER).host);
		headers.set('cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
		if (!headers.has('accept')) headers.set('accept', 'text/html');
		const ctx = createExecutionContext();
		const res = await worker.fetch(new Request(new URL(path, ISSUER), { ...init, headers, redirect: 'manual' }), this.e, ctx);
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
	form(path: string, body: Record<string, string>) {
		return this.fetch(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
	}
	api(path: string, body: unknown = {}) {
		return this.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', origin: ISSUER }, body: JSON.stringify(body) });
	}
	/** /authorize → the sign-in page's path with its flow query */
	async startSignIn() {
		const start = await this.fetch(
			`/authorize?client_id=${PROFILE.id}&response_type=code&state=s&redirect_uri=${encodeURIComponent(PROFILE.redirect)}&prompt=login&provider=password`
		);
		expect(start.status).toBe(302);
		const login = new URL(start.headers.get('location')!, ISSUER);
		expect(login.pathname).toBe('/password/authorize');
		return login.pathname + login.search;
	}
	async passwordSignIn(email: string) {
		return this.form(await this.startSignIn(), { email, password: PASSWORD });
	}
}

async function makeUser(email: string) {
	await Storage.set(CloudflarePatchedStorage({ namespace: (env as unknown as Env).AUTH_STORAGE }), ['email', email, 'password'], await ScryptHasher().hash(PASSWORD));
}
const resend = mockResend();
afterAll(() => resend.restore());
const unique = () => crypto.randomUUID().slice(0, 8);

/** A staff account without a passkey (`pk-` opts the address into the card locally). */
async function makeStaff(): Promise<string> {
	const email = `pk-staff-${unique()}@example.com`;
	await makeUser(email);
	// First sign-in creates the account (non-staff: the card shows; just go on)
	const first = new Browser(WITH_KEY);
	expect((await first.passwordSignIn(email)).status).toBe(200);
	const db = (env as unknown as Env).AUTH_DB;
	const { id } = (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>())!;
	await db
		.prepare(`INSERT OR REPLACE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) VALUES (?, 'role_admin', 'default', ?, 'test')`)
		.bind(id, Date.now())
		.run();
	return email;
}

beforeAll(async () => {
	// No email provider is ever called: Resend is a mock
	resend.install();
	// No setupDatabase(): rebuilding the tables would leave other files' cached JWKS stale
	await registerTestClients();
	const now = Date.now();
	await (env as unknown as Env).AUTH_DB.prepare(`INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, created_at, updated_at) VALUES ('role_admin', 'Admin', 'default', ?, ?)`)
		.bind(now, now)
		.run();
});

describe('isEmailAvailable', () => {
	it('true only when the key resolves to a non-empty value', async () => {
		expect(await isEmailAvailable({ RESEND_API_KEY: 're_x' })).toBe(true);
		expect(await isEmailAvailable({ RESEND_API_KEY: '' })).toBe(false);
		expect(await isEmailAvailable({ RESEND_API_KEY: '   ' })).toBe(false);
		expect(await isEmailAvailable({})).toBe(false);
		// Secrets Store bindings (a resolved value is cached per isolate, so the failing ones first)
		expect(await isEmailAvailable({ RESEND_API_KEY: { get: async () => { throw new Error('no secret'); } } })).toBe(false);
		expect(await isEmailAvailable({ RESEND_API_KEY: { get: async () => '' } })).toBe(false);
		expect(await isEmailAvailable({ RESEND_API_KEY: { get: async () => 're_store' } })).toBe(true);
	});

	it('email-only password routes: register and change, not sign-in', () => {
		expect(isEmailOnlyPasswordRoute('/password/register')).toBe(true);
		expect(isEmailOnlyPasswordRoute('/password/change')).toBe(true);
		expect(isEmailOnlyPasswordRoute('/password/change/')).toBe(true);
		expect(isEmailOnlyPasswordRoute('/password/authorize')).toBe(false);
		expect(isEmailOnlyPasswordRoute('/password/registered')).toBe(false);
	});
});

describe('sign-in page links', () => {
	it.each(['en', 'ar'])('key present (%s): "Register" and "Forgot password?" are shown', async (lang) => {
		const browser = new Browser(WITH_KEY);
		const login = await browser.startSignIn();
		const html = await (await browser.fetch(`${login}&lang=${lang}`)).text();
		expect(html).toContain('<div data-component="form-footer"');
		// openauth links relative to /password/authorize
		expect(html).toMatch(/<a data-component="link" href="register\?/);
		expect(html).toMatch(/<a data-component="link" href="change\?/);
		expect(html).toContain(lang === 'ar' ? 'نسيت كلمة المرور' : 'Forgot password?');
	});

	it.each(['en', 'ar'])('key missing (%s): both links are left out, the sign-in form stays', async (lang) => {
		const browser = new Browser(NO_KEY);
		const login = await browser.startSignIn();
		const res = await browser.fetch(`${login}&lang=${lang}`);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).not.toContain('<div data-component="form-footer"');
		expect(html).not.toMatch(/href="(\.\/)?(register|change)\?/);
		expect(html).not.toContain('/password/register');
		expect(html).not.toContain('/password/change');
		expect(html).not.toMatch(/Forgot password|Don&#39;t have an account|Don't have an account|Don’t have an account|نسيت كلمة المرور|configured/i);
		expect(html).toContain('name="password"');
		expect(html).toContain('data-passkey');
	});

	it('key missing: a wrong password re-renders the page without the links too', async () => {
		const browser = new Browser(NO_KEY);
		const login = await browser.startSignIn();
		const res = await browser.form(login, { email: `nobody-${unique()}@example.com`, password: 'wrong-Pass-1' });
		const html = await res.text();
		expect(html).toContain('name="password"');
		expect(html).not.toContain('<div data-component="form-footer"');
		expect(html).not.toMatch(/href="(\.\/)?(register|change)\?/);
	});
});

describe('/password/register and /password/change', () => {
	it.each(['/password/register', '/password/change'])('key present: %s answers 200', async (path) => {
		const browser = new Browser(WITH_KEY);
		const login = await browser.startSignIn();
		const res = await browser.fetch(`${path}${new URL(login, ISSUER).search}`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('name="email"');
	});

	it.each(['/password/register', '/password/change', '/password/%72egister'])('key missing: %s answers a quiet 404 (GET and POST)', async (path) => {
		const browser = new Browser(NO_KEY);
		const query = new URL(await browser.startSignIn(), ISSUER).search;
		const get = await browser.fetch(`${path}${query}`);
		expect(get.status).toBe(404);
		expect(await get.text()).toBe('Not found');
		const post = await browser.form(`${path}${query}`, { action: 'register', email: `x-${unique()}@example.com`, password: PASSWORD, repeat: PASSWORD });
		expect(post.status).toBe(404);
		expect(await post.text()).toBe('Not found');
	});
});

describe("a staff member's first passkey (emailed code)", () => {
	it('key present: the card offers "Email me a code"; setup shows it; email-code is served', async () => {
		const email = await makeStaff();
		const browser = new Browser(WITH_KEY);
		const card = await browser.passwordSignIn(email);
		expect(card.status).toBe(200);
		const html = await card.text();
		expect(html).toContain('Your role needs a passkey');
		expect(html).toContain('>Email me a code</button>');

		const setup = await browser.fetch('/passkeys/setup?lang=ar');
		expect(setup.status).toBe(200);
		expect(await setup.text()).toContain('>أرسل لي رمزًا</button>');
	});

	it('key missing: no card (straight to the app), setup and email-code answer 404', async () => {
		const email = await makeStaff();
		const browser = new Browser(NO_KEY);
		const signIn = await browser.passwordSignIn(email);
		expect(signIn.status).toBe(302);
		expect(signIn.headers.get('location')!.startsWith(PROFILE.redirect)).toBe(true);

		for (const lang of ['en', 'ar']) {
			const setup = await browser.fetch(`/passkeys/setup?lang=${lang}`);
			expect(setup.status).toBe(404);
			expect(await setup.text()).toBe('Not found');
		}
		const code = await browser.api('/passkeys/email-code');
		expect(code.status).toBe(404);
	});

	it('key missing: a member still gets the card and the setup page (no code step)', async () => {
		const email = `pk-member-${unique()}@example.com`;
		await makeUser(email);
		const browser = new Browser(NO_KEY);
		const card = await browser.passwordSignIn(email);
		expect(card.status).toBe(200);
		const html = await card.text();
		expect(html).toContain('Sign in faster next time');
		expect(html).not.toContain('>Email me a code</button>');
		const setup = await browser.fetch('/passkeys/setup');
		expect(setup.status).toBe(200);
		expect(await setup.text()).toContain('data-action="add"');
	});
});
