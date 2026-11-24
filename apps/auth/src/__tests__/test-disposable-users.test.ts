/**
 * QA's cleanup of old test accounts (routes/test-disposable-users.ts, #312): who is deleted, who
 * never is, and that it cannot run anywhere but on QA's own database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import prodConfig from '../../wrangler.json';
import qaConfig from '../../wrangler.qa.json';
import qaIdentitySql from '../../migrations-qa/0047_database_identity.sql?raw';
import { setupDatabase, sqlStatements } from '../test-setup';
import { routeTestEndpoints } from '../routes/test-routes';
import { DELETE_PER_CALL, DISPOSABLE_SQL, MARK_DELETED_SQL, QA_DATABASE, disposable, type AccountRow } from '../routes/test-disposable-users';
import { RUN_USERS_FLAG } from '../utils/e2e-sink';
import { fakeLimiter } from './helpers/fake-limiter';
import { emitAuditEvent } from '../audit-emitter';

vi.mock('../audit-emitter', () => ({ emitAuditEvent: vi.fn().mockResolvedValue(undefined) }));

const SINK = 'e2e-secret-for-tests';
const PROMOTE = 'promote-secret-for-tests-0123456789';
const ENV = env as unknown as Env;
const ctx = { waitUntil: vi.fn() };
const HOUR = 60 * 60 * 1000;
const OLD = Date.now() - 20 * 24 * HOUR;
const HOST = 'auth.qa.alummahnow.net';

type TestEnv = Record<string, unknown>;
const secrets = () => ({ E2E_CODE_SINK_SECRET: { get: async () => SINK }, TEST_PROMOTE_SECRET: PROMOTE, ADMIN_LIMITER: fakeLimiter(100) as unknown as RateLimit });
const qaEnv = (over: TestEnv = {}): TestEnv => ({
	...ENV,
	ENVIRONMENT: 'qa',
	OPENAUTH_ISSUER: `https://${HOST}`,
	E2E_RUN_USERS: RUN_USERS_FLAG,
	E2E_DISPOSABLE_DELETE: 'enabled',
	...secrets(),
	...over,
});
const varsOf = (config: unknown, name?: string): TestEnv => {
	const c = config as { vars?: TestEnv; env?: Record<string, { vars?: TestEnv }> };
	return { ...((name ? c.env?.[name]?.vars : c.vars) ?? {}) };
};

async function call(query = '', opts: { env?: TestEnv; host?: string; testSecret?: string; method?: string; isProduction?: boolean } = {}) {
	const request = new Request(`https://${opts.host ?? HOST}/test/run-users/disposable${query}`, {
		method: opts.method ?? 'POST',
		headers: { 'X-E2E-Secret': SINK, 'X-Test-Secret': opts.testSecret ?? PROMOTE, 'CF-Connecting-IP': '203.0.113.9' },
	});
	return routeTestEndpoints(request, (opts.env ?? qaEnv()) as never, ctx, opts.isProduction ?? false);
}
const body = async (res: Response | null | undefined) => (await res!.json()) as Record<string, number> & { next: string | null; dryRun: boolean; recentPrefixes: Record<string, number> };

async function addUser(id: string, email: string, over: { created?: number; login?: number | null; marked?: boolean; admin?: boolean; deleted?: boolean } = {}) {
	await ENV.AUTH_DB.prepare(
		`INSERT INTO users (id, tenant_id, email, metadata, status, created_at, updated_at, last_login_at, deleted_at, password_reset_required) VALUES (?, 'default', ?, ?, 'active', ?, ?, ?, ?, 0)`
	)
		.bind(id, email, over.marked ? '{"e2eRun":{"via":"x"}}' : null, over.created ?? OLD, OLD, over.login === undefined ? OLD : over.login, over.deleted ? OLD : null)
		.run();
	if (over.admin) {
		await ENV.AUTH_DB.prepare(`INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id) VALUES ('role_admin', 'Admin', 'default')`).run();
		await ENV.AUTH_DB.prepare(`INSERT INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) VALUES (?, 'role_admin', 'default', 1, 'test')`).bind(id).run();
	}
}
const exists = async (id: string) => (await ENV.AUTH_DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(id).first()) !== null;
const DISPOSABLE = (n: number | string) => `multi-${n}-1794461009517-1b6pqu@e2e.alummahnow.net`;

beforeEach(async () => {
	await setupDatabase();
	await ENV.AUTH_DB.prepare('DELETE FROM users').run();
	await ENV.AUTH_DB.prepare('DROP TABLE IF EXISTS database_identity').run();
	for (const sql of sqlStatements(qaIdentitySql)) await ENV.AUTH_DB.prepare(sql).run();
	vi.mocked(emitAuditEvent).mockClear();
});

describe('who is deleted', () => {
	it('only old test accounts that nobody used lately; admins are counted apart', async () => {
		await addUser('d1', DISPOSABLE(1));
		await addUser('d2-admin', DISPOSABLE(2), { admin: true });
		await addUser('d3-soft-deleted', DISPOSABLE(3), { deleted: true });
		await addUser('d4-never-signed-in', DISPOSABLE(4), { login: null });
		await addUser('k1-new', DISPOSABLE(5), { created: Date.now() - 23 * HOUR, login: null });
		await addUser('k2-active', DISPOSABLE(6), { login: Date.now() - 47 * HOUR });
		await addUser('k3-marked', DISPOSABLE(7), { marked: true });
		await addUser('k4-run', 'e2e+1-1-single@e2e.alummahnow.net');
		await addUser('k5-seed', 'qa-admin@e2e.alummahnow.net', { admin: true });
		await addUser('k6-pinned', 'test-single-1795000000001@e2e.alummahnow.net');
		await addUser('k7-other', 'moderator@e2e.alummahnow.net');
		await addUser('k8-person', 'someone@example.com');
		await addUser('k9-lookalike', 'multi-1-1794461009517-1b6pqu@example.com');
		await ENV.AUTH_DB.prepare(`INSERT INTO account_sessions (id, browser_session_id, user_id, is_active, authenticated_at, expires_at, subject_type, refresh_token, client_id) VALUES ('as1', 'bs1', 'd1', 1, 1, 1, 'user', 'x', 'c')`)
			.run()
			.catch(() => undefined);

		const dry = await body(await call());
		expect(dry).toMatchObject({ dryRun: true, scanned: 13, eligible: 4, eligibleAdmins: 1, deleted: 0, next: null });
		expect(dry.recentPrefixes).toEqual({ 'multi-5': 1 });
		expect(await exists('d1')).toBe(true);

		const res = await call('?dryRun=0');
		const text = await res!.clone().text();
		expect(text).not.toContain('@');
		expect(await body(res)).toMatchObject({ dryRun: false, deleted: 4, deletedAdmins: 1, skipped: 0, failed: 0, next: null });
		const { results } = await ENV.AUTH_DB.prepare('SELECT id, status FROM users ORDER BY id').all<{ id: string; status: string }>();
		expect(results.map((r) => r.id)).toEqual(['k1-new', 'k2-active', 'k3-marked', 'k4-run', 'k5-seed', 'k6-pinned', 'k7-other', 'k8-person', 'k9-lookalike']);
		expect(results.every((r) => r.status === 'active')).toBe(true);
		expect(await ENV.AUTH_DB.prepare(`SELECT 1 FROM rbac_user_roles WHERE user_id = 'd2-admin'`).first()).toBeNull();
		expect(await ENV.AUTH_DB.prepare(`SELECT 1 FROM account_sessions WHERE user_id = 'd1'`).first()).toBeNull();
		// One event for the call, with counts and no address
		expect(emitAuditEvent).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(vi.mocked(emitAuditEvent).mock.calls)).not.toContain('e2e.alummahnow.net');
	});

	it.each([
		['exactly 24 hours old', { created_at: -24 * HOUR }],
		['signed in exactly 48 hours ago', { last_login_at: -48 * HOUR }],
	])('the limits are strict: %s is kept', (_name, over) => {
		const now = Date.now();
		const row: AccountRow = { id: 'x', email: DISPOSABLE(1), tenant_id: 'default', created_at: OLD, deleted_at: null, last_login_at: OLD, marked: 0, admin: 0 };
		expect(disposable(row, now)).toBe(true);
		const shifted = Object.fromEntries(Object.entries(over).map(([k, v]) => [k, now + v]));
		expect(disposable({ ...row, ...shifted }, now)).toBe(false);
	});

	it('an account used, marked or renamed after it was read is left alone', async () => {
		const now = Date.now();
		const bind = (id: string) => ENV.AUTH_DB.prepare(MARK_DELETED_SQL).bind(id, now, DISPOSABLE(id), now - 24 * HOUR, now - 48 * HOUR).run();
		await addUser('used', DISPOSABLE('used'), { login: now - HOUR });
		await addUser('marked', DISPOSABLE('marked'), { marked: true });
		await addUser('renamed', 'now-a-person@example.com');
		await addUser('gone', DISPOSABLE('gone'));
		for (const id of ['used', 'marked', 'renamed']) expect((await bind(id)).meta.changes).toBe(0);
		expect((await bind('gone')).meta.changes).toBe(1);
	});
});

describe('bounded and resumable', () => {
	it(`deletes at most ${DELETE_PER_CALL} per call and goes on from where it stopped`, async () => {
		for (let i = 0; i < DELETE_PER_CALL + 5; i++) await addUser(`u${String(i).padStart(2, '0')}`, DISPOSABLE(i));
		const first = await body(await call('?dryRun=0'));
		expect(first).toMatchObject({ deleted: DELETE_PER_CALL, next: 'u09' });
		const second = await body(await call(`?dryRun=0&after=${first.next}`));
		expect(second).toMatchObject({ deleted: 5, next: null });
	});

	it('takes a smaller limit, never a larger one, and refuses nonsense', async () => {
		for (let i = 0; i < DELETE_PER_CALL + 5; i++) await addUser(`u${String(i).padStart(2, '0')}`, DISPOSABLE(i));
		for (const bad of ['0', '-1', '1.5', 'x', 'NaN']) expect((await call(`?dryRun=0&limit=${bad}`))?.status).toBe(400);
		expect(await body(await call('?dryRun=0&limit=3'))).toMatchObject({ deleted: 3, next: 'u02' });
		expect(await body(await call('?dryRun=0&limit=9999'))).toMatchObject({ deleted: DELETE_PER_CALL });
	});

	it('an account whose metadata cannot be read is kept, and stops nothing', async () => {
		await addUser('a-broken', DISPOSABLE(1));
		await ENV.AUTH_DB.prepare(`UPDATE users SET metadata = '{not json' WHERE id = 'a-broken'`).run();
		await addUser('b-fine', DISPOSABLE(2));
		expect(await body(await call('?dryRun=0'))).toMatchObject({ eligible: 1, deleted: 1, failed: 0 });
		expect(await exists('a-broken')).toBe(true);
	});

	it('starting again after an interruption finishes a half-deleted account', async () => {
		await addUser('half', DISPOSABLE(1), { deleted: true });
		await ENV.AUTH_DB.prepare(`UPDATE users SET status = 'deleted' WHERE id = 'half'`).run();
		expect(await body(await call('?dryRun=0'))).toMatchObject({ deleted: 1 });
		expect(await exists('half')).toBe(false);
	});

	it.each([
		['the walk', DISPOSABLE_SQL, ['', 1]],
		['the mark', MARK_DELETED_SQL, ['x', 1, 'y', 1, 1]],
	])('%s searches the primary key', async (_name, sql, binds) => {
		const { results } = await ENV.AUTH_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
			.bind(...binds)
			.all<{ detail: string }>();
		const plan = results.map((r) => r.detail).join(' ');
		expect(plan).toContain('sqlite_autoindex_users_1');
		expect(plan).not.toMatch(/\bSCAN users/);
	});
});

describe('nowhere but QA', () => {
	const stage = () => ({ ...ENV, ...varsOf(prodConfig, 'stage'), E2E_DISPOSABLE_DELETE: 'enabled', ...secrets() });
	const production = () => ({ ...ENV, ...varsOf(prodConfig, 'production'), E2E_RUN_USERS: RUN_USERS_FLAG, E2E_DISPOSABLE_DELETE: 'enabled', ...secrets() });

	it.each([
		['stage, even with the flag', stage, 'auth.stage.alummahnow.net'],
		['production, even with every flag and secret', production, 'auth.alummahnow.net'],
		['QA vars on another host', () => qaEnv(), 'auth.stage.alummahnow.net'],
		['a local worker', () => qaEnv({ ENVIRONMENT: 'development', OPENAUTH_ISSUER: 'http://localhost:3301' }), 'localhost'],
		['stage environment with the QA issuer', () => qaEnv({ ENVIRONMENT: 'stage' }), HOST],
		['QA environment with the production issuer', () => qaEnv({ OPENAUTH_ISSUER: 'https://auth.alummahnow.net' }), HOST],
		['QA without the flag', () => qaEnv({ E2E_DISPOSABLE_DELETE: undefined }), HOST],
	])('%s: no route, nothing deleted', async (_name, makeEnv, host) => {
		await addUser('d1', DISPOSABLE(1));
		const res = await call('?dryRun=0', { env: makeEnv(), host });
		expect(res === null || res === undefined || res.status === 404).toBe(true);
		expect(await exists('d1')).toBe(true);
	});

	it.each([
		['no identity table (stage, production)', 'DROP TABLE database_identity'],
		['another database', `UPDATE database_identity SET name = 'al-ummah-now-d1'`],
		['two names', `INSERT INTO database_identity (name) VALUES ('al-ummah-now-d1-stage')`],
		['no name', 'DELETE FROM database_identity'],
	])('the right vars with the wrong database: %s', async (_name, sql) => {
		await addUser('d1', DISPOSABLE(1));
		await ENV.AUTH_DB.prepare(sql).run();
		const res = await call('?dryRun=0');
		expect(res === null || res === undefined || res.status === 404).toBe(true);
		expect(await exists('d1')).toBe(true);
	});

	it('is never routed in production, needs both secrets, and only POST deletes', async () => {
		await addUser('d1', DISPOSABLE(1));
		expect(await call('?dryRun=0', { env: production(), host: 'auth.alummahnow.net', isProduction: true })).toBeNull();
		expect((await call('?dryRun=0', { testSecret: 'wrong' }))?.status).toBe(401);
		const get = await call('?dryRun=0', { method: 'GET' });
		expect(get === null || get === undefined || get.status === 404).toBe(true);
		for (const q of ['', '?dryRun=1', '?dryRun=', '?dryRun=false', '?dryRun=no']) expect((await body(await call(q))).dryRun).toBe(true);
		expect(await exists('d1')).toBe(true);
	});

	it('the configs and migrations agree: QA has the flag, the name and the table; nobody else does', () => {
		const qa = qaConfig as unknown as { d1_databases: { binding: string; database_name: string }[] };
		expect(qa.d1_databases.find((d) => d.binding === 'AUTH_DB')?.database_name).toBe(QA_DATABASE);
		expect(varsOf(qaConfig).E2E_DISPOSABLE_DELETE).toBe('enabled');
		const other = prodConfig as unknown as { env: Record<string, { d1_databases: { binding: string; database_name: string }[] }> };
		for (const name of ['stage', 'production']) {
			expect(varsOf(prodConfig, name).E2E_DISPOSABLE_DELETE).toBeUndefined();
			expect(other.env[name].d1_databases.find((d) => d.binding === 'AUTH_DB')?.database_name).not.toBe(QA_DATABASE);
		}
		const shared = import.meta.glob('../../migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
		expect(Object.keys(shared).length).toBeGreaterThan(20);
		for (const [file, sql] of Object.entries(shared)) expect({ file, mentions: sql.includes('database_identity') }).toEqual({ file, mentions: false });
	});
});
