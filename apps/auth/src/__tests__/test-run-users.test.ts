/**
 * E2E run accounts (routes/test-run-users.ts, utils/e2e-sink.ts markRunUser):
 * a run's teardown deletes its own marked accounts through soft delete +
 * immediate purge. Production must never serve the routes, whatever is bound.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import prodConfig from '../../wrangler.json';
import qaConfig from '../../wrangler.qa.json';
import { setupDatabase } from '../test-setup';
import { routeTestEndpoints } from '../routes/test-routes';
import { isRunUserEmail, markRunUser, runUsersEnabled, RUN_USERS_FLAG } from '../utils/e2e-sink';
import { fakeLimiter } from './helpers/fake-limiter';
import { emitAuditEvent } from '../audit-emitter';

vi.mock('../audit-emitter', () => ({ emitAuditEvent: vi.fn().mockResolvedValue(undefined) }));

const SINK = 'e2e-secret-for-tests';
const PROMOTE = 'promote-secret-for-tests-0123456789';
const RUN_EMAIL = 'e2e+42887909300-1-web-chromium-single@e2e.alummahnow.net';
const ctx = { waitUntil: vi.fn() };
const ENV = env as unknown as Env;

type TestEnv = Record<string, unknown>;

function qaEnv(overrides: TestEnv = {}): TestEnv {
	return {
		...ENV,
		ENVIRONMENT: 'qa',
		OPENAUTH_ISSUER: 'https://auth.qa.alummahnow.net',
		E2E_RUN_USERS: RUN_USERS_FLAG,
		E2E_CODE_SINK_SECRET: { get: async () => SINK },
		TEST_PROMOTE_SECRET: PROMOTE,
		ADMIN_LIMITER: fakeLimiter(100) as unknown as RateLimit,
		...overrides,
	};
}

const req = (path: string, opts: { method?: string; host?: string; testSecret?: string } = {}) =>
	new Request(`https://${opts.host ?? 'auth.qa.alummahnow.net'}${path}`, {
		method: opts.method ?? 'POST',
		headers: { 'X-E2E-Secret': SINK, 'X-Test-Secret': opts.testSecret ?? PROMOTE, 'CF-Connecting-IP': '203.0.113.9' },
	});

const del = (email: string, opts: { env?: TestEnv; isProduction?: boolean; host?: string; testSecret?: string } = {}) =>
	routeTestEndpoints(
		req(`/test/run-users/delete/${encodeURIComponent(email)}`, opts),
		(opts.env ?? qaEnv()) as never,
		ctx,
		opts.isProduction ?? false
	);

const stale = (query: string, opts: { env?: TestEnv; isProduction?: boolean; testSecret?: string } = {}) =>
	routeTestEndpoints(req(`/test/run-users/stale${query}`, { ...opts, method: 'GET' }), (opts.env ?? qaEnv()) as never, ctx, opts.isProduction ?? false);

async function addUser(id: string, email: string, opts: { marked?: boolean; createdAt?: number } = {}) {
	const now = opts.createdAt ?? Date.now();
	await ENV.AUTH_DB.prepare(
		`INSERT INTO users (id, tenant_id, email, status, created_at, updated_at, password_reset_required) VALUES (?, 'default', ?, 'active', ?, ?, 0)`
	)
		.bind(id, email, now, now)
		.run();
	if (opts.marked ?? true) expect(await markRunUser(qaEnv() as never, ENV.AUTH_DB, { id, email })).toBe(true);
}

const userCount = (email: string) =>
	ENV.AUTH_DB.prepare('SELECT COUNT(*) AS n FROM users WHERE lower(email) = ?')
		.bind(email)
		.first<{ n: number }>()
		.then((r) => r?.n ?? 0);

/** The vars a deployed worker gets from a wrangler config (top level, or one env block). */
function varsOf(config: unknown, envName?: string): TestEnv {
	const c = config as { vars?: TestEnv; env?: Record<string, { vars?: TestEnv }> };
	return { ...((envName ? c.env?.[envName]?.vars : c.vars) ?? {}) };
}

beforeEach(async () => {
	await setupDatabase();
	await ENV.AUTH_DB.prepare(`DELETE FROM users WHERE email LIKE '%@e2e.alummahnow.net'`).run();
	await ENV.AUTH_DB.prepare(`DELETE FROM admin_deletions`).run();
	vi.mocked(emitAuditEvent).mockClear();
});

describe('isRunUserEmail', () => {
	it.each([
		[RUN_EMAIL, true],
		['e2e+1-2-admin@e2e.alummahnow.net', true],
		['e2e-1-2-admin@e2e.alummahnow.net', false],
		['qa-admin@e2e.alummahnow.net', false],
		['test-single-1795000000001@e2e.alummahnow.net', false],
		['e2e+1-2-x@e2e.alummahnow.net.evil.com', false],
		['e2e+1-2-x@alummahnow.net', false],
		['e2e+x-2-y@e2e.alummahnow.net', false],
		['E2E+1-2-X@E2E.ALUMMAHNOW.NET', false],
	])('%s → %s', (email, expected) => expect(isRunUserEmail(email)).toBe(expected));
});

describe('provisioning marker', () => {
	it('is set only for run addresses on a deployment with run-account support', async () => {
		await addUser('run-m1', RUN_EMAIL, { marked: false });
		expect(await markRunUser(qaEnv({ E2E_RUN_USERS: undefined }) as never, ENV.AUTH_DB, { id: 'run-m1', email: RUN_EMAIL })).toBe(false);
		expect(await markRunUser(qaEnv() as never, ENV.AUTH_DB, { id: 'run-m1', email: 'qa-admin@e2e.alummahnow.net' })).toBe(false);
		expect(await markRunUser(qaEnv() as never, ENV.AUTH_DB, { id: 'run-m1', email: RUN_EMAIL })).toBe(true);
		const row = await ENV.AUTH_DB.prepare('SELECT metadata FROM users WHERE id = ?').bind('run-m1').first<{ metadata: string }>();
		expect(JSON.parse(row!.metadata).e2eRun).toMatchObject({ via: 'e2e-sink-registration' });
	});
});

describe('POST /test/run-users/delete/:email', () => {
	it('soft-deletes, then purges the run account at once (audit-logged)', async () => {
		await addUser('run-u1', RUN_EMAIL);
		const res = await del(RUN_EMAIL);
		expect(res?.status).toBe(200);
		expect(await res!.json()).toMatchObject({ success: true, found: 1, purged: 1 });
		expect(await userCount(RUN_EMAIL)).toBe(0);
		expect(await ENV.AUTH_DB.prepare(`SELECT COUNT(*) AS n FROM admin_deletions`).first<{ n: number }>()).toMatchObject({ n: 0 });
		const events = vi.mocked(emitAuditEvent).mock.calls.map(([e]) => (e as { eventType: string }).eventType);
		expect(events).toEqual(['admin.item.deleted', 'admin.item.purge_requested', 'admin.item.purged']);
		expect(vi.mocked(emitAuditEvent).mock.calls[0][0]).toMatchObject({ userId: 'e2e-teardown', ipAddress: '203.0.113.9' });
	});

	it('also drops the invite link the E2E sink kept for the address', async () => {
		await addUser('run-u9', RUN_EMAIL);
		await ENV.AUTH_STORAGE.put(`test:invite:${RUN_EMAIL}`, JSON.stringify({ link: 'https://auth.test/invite/x', at: 1 }));
		expect((await del(RUN_EMAIL))?.status).toBe(200);
		expect(await ENV.AUTH_STORAGE.get(`test:invite:${RUN_EMAIL}`)).toBeNull();
	});

	it('is idempotent: an unknown or already removed run account is a 200 with nothing found', async () => {
		const res = await del(RUN_EMAIL);
		expect(res?.status).toBe(200);
		expect(await res!.json()).toMatchObject({ found: 0, purged: 0 });
	});

	it('refuses any address that is not a run account (seed accounts stay)', async () => {
		await addUser('run-seed', 'qa-admin@e2e.alummahnow.net', { marked: false });
		expect((await del('qa-admin@e2e.alummahnow.net'))?.status).toBe(400);
		expect(await userCount('qa-admin@e2e.alummahnow.net')).toBe(1);
	});

	it('refuses a run address that the provisioning path did not create', async () => {
		await addUser('run-unmarked', RUN_EMAIL, { marked: false });
		const res = await del(RUN_EMAIL);
		expect(res?.status).toBe(403);
		expect(await userCount(RUN_EMAIL)).toBe(1);
	});

	it('needs the CI secret as well as the sink secret', async () => {
		await addUser('run-u2', RUN_EMAIL);
		expect((await del(RUN_EMAIL, { testSecret: 'wrong' }))?.status).toBe(401);
		expect((await del(RUN_EMAIL, { testSecret: '' }))?.status).toBe(401);
		expect(await userCount(RUN_EMAIL)).toBe(1);
	});

	it('does not exist without the flag or the CI secret binding', async () => {
		await addUser('run-u3', RUN_EMAIL);
		// Not routed here: the worker's router answers 404 for an unknown path
		expect(await del(RUN_EMAIL, { env: qaEnv({ E2E_RUN_USERS: undefined }) })).toBeNull();
		expect(await del(RUN_EMAIL, { env: qaEnv({ E2E_RUN_USERS: 'true' }) })).toBeNull();
		expect(await del(RUN_EMAIL, { env: qaEnv({ TEST_PROMOTE_SECRET: undefined }) })).toBeNull();
		expect(await userCount(RUN_EMAIL)).toBe(1);
	});

	it('is rate-limited per client IP', async () => {
		const e = qaEnv({ ADMIN_LIMITER: fakeLimiter(2) as unknown as RateLimit });
		expect((await del(RUN_EMAIL, { env: e }))?.status).toBe(200);
		expect((await del(RUN_EMAIL, { env: e }))?.status).toBe(200);
		const limited = await del(RUN_EMAIL, { env: e });
		expect(limited?.status).toBe(429);
		expect(limited?.headers.get('Retry-After')).toBe('60');
	});

	it('never logs the secrets', async () => {
		const spy = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')];
		await addUser('run-u4', RUN_EMAIL);
		await del(RUN_EMAIL, { testSecret: 'wrong-secret-value' });
		await del(RUN_EMAIL);
		const logged = spy.flatMap((s) => s.mock.calls.flat().map(String)).join('\n');
		expect(logged).not.toContain(PROMOTE);
		expect(logged).not.toContain(SINK);
		expect(logged).not.toContain('wrong-secret-value');
		spy.forEach((s) => s.mockRestore());
	});
});

describe('GET /test/run-users/stale', () => {
	it('lists only marked run accounts older than the cutoff', async () => {
		const old = Date.now() - 30 * 60 * 60 * 1000;
		await addUser('run-old', 'e2e+1-1-single@e2e.alummahnow.net', { createdAt: old });
		await addUser('run-old-unmarked', 'e2e+3-1-single@e2e.alummahnow.net', { createdAt: old, marked: false });
		await addUser('run-new', 'e2e+2-1-single@e2e.alummahnow.net');
		await addUser('run-seed', 'qa-admin@e2e.alummahnow.net', { createdAt: old, marked: false });
		const res = await stale('?hours=24', {});
		expect(res?.status).toBe(200);
		expect(await res!.json()).toMatchObject({ emails: ['e2e+1-1-single@e2e.alummahnow.net'] });
	});

	it('validates hours and needs the CI secret', async () => {
		expect((await stale('?hours=0'))?.status).toBe(400);
		expect((await stale('', { testSecret: 'nope' }))?.status).toBe(401);
	});
});

describe('production configuration', () => {
	it('the production config has neither the flag nor a test secret binding', () => {
		const prod = (prodConfig as { env: { production: Record<string, unknown> } }).env.production;
		expect(varsOf(prodConfig, 'production').E2E_RUN_USERS).toBeUndefined();
		const bindings = JSON.stringify([prod.secrets_store_secrets ?? [], prod.vars ?? {}]);
		expect(bindings).not.toContain('E2E_CODE_SINK_SECRET');
		expect(bindings).not.toContain('TEST_PROMOTE_SECRET');
		expect(bindings).not.toContain('E2E_RUN_USERS');
		// QA has the flag (so the test above is not vacuous)
		expect(varsOf(qaConfig).E2E_RUN_USERS).toBe(RUN_USERS_FLAG);
		expect(varsOf(prodConfig, 'stage').E2E_RUN_USERS).toBe(RUN_USERS_FLAG);
	});

	it('production config yields a 404 on both routes, even with both secrets bound by mistake', async () => {
		await addUser('run-p1', RUN_EMAIL);
		// The production vars exactly as deployed, plus every secret a mistake could add
		const prod = { ...ENV, ...varsOf(prodConfig, 'production'), E2E_CODE_SINK_SECRET: { get: async () => SINK }, TEST_PROMOTE_SECRET: PROMOTE };
		expect(await runUsersEnabled(prod as never)).toBe(false);
		const host = 'auth.alummahnow.net';
		// As the worker runs it in production: not routed at all (the router's 404)
		expect(await del(RUN_EMAIL, { env: prod, isProduction: true, host })).toBeNull();
		expect(await stale('', { env: prod, isProduction: true })).toBeNull();
		// Even if the production flag were wrong: the test-route gate answers 404
		expect((await del(RUN_EMAIL, { env: prod, host }))?.status).toBe(404);
		expect((await stale('', { env: prod }))?.status).toBe(404);
		// And with the run flag added to production vars by mistake: still 404
		expect((await del(RUN_EMAIL, { env: { ...prod, E2E_RUN_USERS: RUN_USERS_FLAG }, host }))?.status).toBe(404);
		expect(await userCount(RUN_EMAIL)).toBe(1);
	});
});
