/**
 * DELETE /admin/users/:userId/sessions ("terminate all sessions", also run by an
 * approved moderation request to sign a user out everywhere). It used to revoke
 * refresh tokens by a session_id column refresh_tokens does not have, so it
 * answered 500 for any user with a session.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { setupDatabase } from '../test-setup';

vi.mock('../middleware/admin-auth', () => ({
	requireAdmin: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
		c.set('adminUser', { userId: 'usr_admin', email: 'admin@example.com', roles: ['Admin'] });
		await next();
	},
	requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../middleware/rate-limit', () => ({ rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next() }));

const { default: adminSessionRoutes } = await import('./admin-session-routes');
const DB = () => (env as unknown as Env).AUTH_DB;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

describe('DELETE /admin/users/:userId/sessions', () => {
	beforeAll(async () => {
		await setupDatabase();
		const db = DB();
		const now = Date.now();
		await db.prepare(`CREATE TABLE IF NOT EXISTS browser_sessions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity INTEGER NOT NULL, user_agent TEXT, ip_address TEXT, version INTEGER NOT NULL DEFAULT 1, active_user_id TEXT)`).run();
		await db.prepare(`CREATE TABLE IF NOT EXISTS account_sessions (id TEXT PRIMARY KEY, browser_session_id TEXT NOT NULL, user_id TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 0, authenticated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, subject_type TEXT NOT NULL, subject_properties TEXT, refresh_token TEXT NOT NULL, client_id TEXT NOT NULL)`).run();
		await db.prepare(`INSERT INTO users (id, tenant_id, email, status, created_at, updated_at) VALUES ('usr_target', 'default', 't@example.com', 'active', ?, ?)`).bind(now, now).run();
		await db.prepare(`INSERT INTO browser_sessions (id, tenant_id, created_at, last_activity, active_user_id) VALUES ('bs1', 'default', ?, ?, 'usr_target')`).bind(now, now).run();
		for (const id of ['as1', 'as2']) {
			await db
				.prepare(`INSERT INTO account_sessions (id, browser_session_id, user_id, is_active, authenticated_at, expires_at, subject_type, refresh_token, client_id) VALUES (?, 'bs1', 'usr_target', 1, ?, ?, 'user', 'rt', 'c')`)
				.bind(id, now, now + 3600_000)
				.run();
		}
		await db.prepare(`INSERT INTO refresh_tokens (token_hash, user_id, client_id, expires_at) VALUES ('h1', 'usr_target', 'c', ?)`).bind(now + 3600_000).run();
	});

	it('signs the user out everywhere instead of failing', async () => {
		const res = await adminSessionRoutes.fetch(new Request('https://auth.test/admin/users/usr_target/sessions', { method: 'DELETE' }), env as unknown as Env, ctx);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ success: true, sessionsTerminated: 2, tokensRevoked: 1 });
		const left = await DB().prepare(`SELECT COUNT(*) n FROM account_sessions WHERE user_id = 'usr_target'`).first<{ n: number }>();
		expect(left!.n).toBe(0);
		const browser = await DB().prepare(`SELECT active_user_id FROM browser_sessions WHERE id = 'bs1'`).first<{ active_user_id: string | null }>();
		expect(browser!.active_user_id).toBeNull();
		const token = await DB().prepare(`SELECT revoked FROM refresh_tokens WHERE token_hash = 'h1'`).first<{ revoked: number }>();
		expect(token!.revoked).toBe(1);
	});
});

describe('DELETE /admin/users/:userId/sessions/:sessionId (#277)', () => {
	beforeAll(async () => {
		const db = DB();
		const now = Date.now();
		await db.prepare(`INSERT OR IGNORE INTO users (id, tenant_id, email, status, created_at, updated_at) VALUES ('usr_one', 'default', 'one@example.com', 'active', ?, ?)`).bind(now, now).run();
		for (const [bs, as] of [
			['bs_laptop', 'as_laptop'],
			['bs_phone', 'as_phone'],
		]) {
			await db.prepare(`INSERT INTO browser_sessions (id, tenant_id, created_at, last_activity, user_agent, active_user_id) VALUES (?, 'default', ?, ?, 'UA', 'usr_one')`).bind(bs, now, now).run();
			await db
				.prepare(`INSERT INTO account_sessions (id, browser_session_id, user_id, is_active, authenticated_at, expires_at, subject_type, refresh_token, client_id) VALUES (?, ?, 'usr_one', 1, ?, ?, 'user', 'rt', 'c')`)
				.bind(as, bs, now, now + 3600_000)
				.run();
		}
	});

	it('ends that one session (no 500) and leaves the other', async () => {
		const res = await adminSessionRoutes.fetch(new Request('https://auth.test/admin/users/usr_one/sessions/as_laptop', { method: 'DELETE' }), env as unknown as Env, ctx);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ success: true });
		const rows = await DB().prepare(`SELECT id FROM account_sessions WHERE user_id = 'usr_one' ORDER BY id`).all<{ id: string }>();
		expect(rows.results.map((r) => r.id)).toEqual(['as_phone']);
		const laptop = await DB().prepare(`SELECT active_user_id FROM browser_sessions WHERE id = 'bs_laptop'`).first<{ active_user_id: string | null }>();
		expect(laptop!.active_user_id).toBeNull();
		const phone = await DB().prepare(`SELECT active_user_id FROM browser_sessions WHERE id = 'bs_phone'`).first<{ active_user_id: string | null }>();
		expect(phone!.active_user_id).toBe('usr_one');
		const listed = await DB().prepare(`SELECT COUNT(*) n FROM scoped_revocations WHERE scope_key LIKE 's:%'`).first<{ n: number }>();
		expect(listed!.n).toBeGreaterThan(0);
	});

	it("answers 404 for another user's session", async () => {
		const res = await adminSessionRoutes.fetch(new Request('https://auth.test/admin/users/usr_target/sessions/as_phone', { method: 'DELETE' }), env as unknown as Env, ctx);
		expect(res.status).toBe(404);
	});
});

describe('POST /admin/sessions/bulk-terminate', () => {
	it('ends the matching sessions one by one (no 500)', async () => {
		const db = DB();
		const now = Date.now();
		await db.prepare(`INSERT INTO browser_sessions (id, tenant_id, created_at, last_activity, ip_address, active_user_id) VALUES ('bs_bulk', 'default', ?, ?, '203.0.113.9', 'usr_one')`).bind(now, now).run();
		await db
			.prepare(`INSERT INTO account_sessions (id, browser_session_id, user_id, is_active, authenticated_at, expires_at, subject_type, refresh_token, client_id) VALUES ('as_bulk', 'bs_bulk', 'usr_one', 1, ?, ?, 'user', 'rt', 'c')`)
			.bind(now, now + 3600_000)
			.run();
		const app = new (await import('hono')).Hono<{ Variables: { tenantId: string } }>();
		app.use('*', async (c, next) => {
			c.set('tenantId', 'default');
			await next();
		});
		app.route('/', adminSessionRoutes as never);
		const res = await app.fetch(
			new Request('https://auth.test/admin/sessions/bulk-terminate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ipAddress: '203.0.113.9' }) }),
			env as unknown as Env,
			ctx
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ success: true, sessionsTerminated: 1, remaining: false });
		expect(await db.prepare(`SELECT id FROM account_sessions WHERE id = 'as_bulk'`).first()).toBeNull();
	});
});
