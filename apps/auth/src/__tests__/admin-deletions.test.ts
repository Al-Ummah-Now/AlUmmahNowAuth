/**
 * Admin soft delete (deletions/): a delete hides the item and keeps it
 * restorable; only the cleanup (purgeDeleted) removes data, 30 days later or
 * on its next run after "delete permanently now".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { setupDatabase } from '../test-setup';
import { authStorage } from '../storage/auth-storage';
import { LEGACY_USER_KEYS } from '../services/d1-user-service';
import { DeletionError, listDeleted, requestPurge, restore, softDelete } from '../deletions/service';
import { purgeDeleted } from '../deletions/purge';
import { DeletionStore, RETENTION_MS } from '../deletions/store';
import { hideDeleted } from '../deletions/routes';
import { createRefreshCheck } from '../handlers/refresh-check';
import { D1UserService } from '../services/d1-user-service';
import { D1UserAdapter } from '@al-ummah-now/openauth';

vi.mock('../audit-emitter', () => ({ emitAuditEvent: vi.fn().mockResolvedValue(undefined) }));

const ENV = env as unknown as Env;
const db = () => ENV.AUTH_DB;
const ADMIN = { userId: 'del-admin', email: 'admin@example.com' };
const DAY = 24 * 60 * 60 * 1000;

async function addUser(id: string, email: string, status = 'active') {
	const now = Date.now();
	await db()
		.prepare(`INSERT INTO users (id, tenant_id, email, status, created_at, updated_at, password_reset_required) VALUES (?, 'default', ?, ?, ?, ?, 0)`)
		.bind(id, email, status, now, now)
		.run();
}

const userRow = (id: string) => db().prepare('SELECT id, status, deleted_at FROM users WHERE id = ?').bind(id).first<{ status: string; deleted_at: number | null }>();

async function expectError(promise: Promise<unknown>, status: number, code?: string) {
	const error = await promise.then(
		() => null,
		(e: unknown) => e
	);
	expect(error).toBeInstanceOf(DeletionError);
	expect((error as DeletionError).status).toBe(status);
	if (code) expect((error as DeletionError).code).toBe(code);
}

beforeEach(async () => {
	await setupDatabase();
	await db().prepare(`DELETE FROM users WHERE id LIKE 'del-%'`).run();
	await db().prepare(`DELETE FROM rbac_roles WHERE id LIKE 'del-%'`).run();
	await db().prepare(`DELETE FROM oauth_clients WHERE id LIKE 'del-%'`).run();
	await db().prepare(`DELETE FROM user_revocations`).run();
});

describe('users', () => {
	it('delete hides the user, signs them out and keeps everything; restore brings them back', async () => {
		await addUser('del-u1', 'del-u1@example.com', 'suspended');
		await db()
			.prepare(`INSERT INTO rbac_roles (id, name, tenant_id) VALUES ('del-r0', 'del-r0', 'default')`)
			.run();
		await db()
			.prepare(`INSERT INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) VALUES ('del-u1', 'del-r0', 'default', 1, 'x')`)
			.run();

		const view = await softDelete(ENV, 'user', 'del-u1', ADMIN, { reason: '  spam  ' });
		expect(view).toMatchObject({ kind: 'user', id: 'del-u1', label: 'del-u1@example.com', deletedBy: 'del-admin', reason: 'spam', purgeRequestedAt: null });
		expect(view.purgeAt - view.deletedAt).toBe(RETENTION_MS);

		expect(await userRow('del-u1')).toMatchObject({ status: 'deleted' });
		// Hidden: listings use deleted_at IS NULL, so do lookups by email
		const service = new D1UserService({ db: db(), adapter: new D1UserAdapter({ db: db(), usersTable: 'users' }) });
		expect(await service.getUserByEmail('default', 'del-u1@example.com')).toBeNull();
		const listed = await db().prepare(`SELECT id FROM users WHERE tenant_id = 'default' AND deleted_at IS NULL AND id = 'del-u1'`).first();
		expect(listed).toBeNull();
		// No refresh, every token issued before now is dead
		const check = createRefreshCheck(service);
		expect(await check({ tenantId: 'default', userId: 'del-u1', clientID: 'x' } as never)).toMatchObject({ revoke: true });
		expect(await db().prepare(`SELECT reason FROM user_revocations WHERE user_id = 'del-u1'`).first()).toMatchObject({ reason: 'admin_deleted' });
		// Nothing removed: role link stays (the account just can't be used)
		expect(await db().prepare(`SELECT 1 FROM rbac_user_roles WHERE user_id = 'del-u1'`).first()).not.toBeNull();

		await expectError(softDelete(ENV, 'user', 'del-u1', ADMIN), 404, 'already_deleted');

		await restore(ENV, 'user', 'del-u1', ADMIN);
		expect(await userRow('del-u1')).toMatchObject({ status: 'suspended', deleted_at: null });
		expect(await listDeleted(ENV, 'user')).toEqual([]);
	});

	it('restore is refused when another account now has the email', async () => {
		await addUser('del-u2', 'del-u2@example.com');
		await softDelete(ENV, 'user', 'del-u2', ADMIN);
		await addUser('del-u2b', 'del-u2@example.com');
		await expectError(restore(ENV, 'user', 'del-u2', ADMIN), 409, 'email_in_use');
		expect((await listDeleted(ENV, 'user')).map((d) => d.id)).toEqual(['del-u2']);
	});

	it('an admin cannot delete their own account', async () => {
		await addUser('del-admin', 'del-admin@example.com');
		await expectError(softDelete(ENV, 'user', 'del-admin', ADMIN), 409, 'cannot_delete_self');
	});
});

describe('clients and roles', () => {
	it('a deleted client is disabled and hidden from the client routes; restore re-enables it', async () => {
		const now = Date.now();
		await db().prepare(`INSERT INTO oauth_clients (id, tenant_id, name, enabled, created_at, updated_at) VALUES ('del-c1', 'default', 'Del One', 1, ?, ?)`).bind(now, now).run();
		await db().prepare(`INSERT INTO oauth_clients (id, tenant_id, name, enabled, created_at, updated_at) VALUES ('del-c2', 'default', 'Del Two', 1, ?, ?)`).bind(now, now).run();
		await softDelete(ENV, 'client', 'del-c1', ADMIN);
		expect(await db().prepare(`SELECT enabled FROM oauth_clients WHERE id = 'del-c1'`).first()).toEqual({ enabled: 0 });

		const app = new Hono<{ Bindings: Env }>();
		app.use('*', hideDeleted('client', { prefix: 'clients', listKey: 'clients' }));
		app.get('/clients', async (c) => c.json({ clients: (await c.env.AUTH_DB.prepare(`SELECT id FROM oauth_clients WHERE id LIKE 'del-%' ORDER BY id`).all()).results }));
		app.get('/clients/:id', (c) => c.json({ id: c.req.param('id') }));
		const list = await (await app.fetch(new Request('http://x/clients'), ENV)).json<{ clients: { id: string }[] }>();
		expect(list.clients.map((c) => c.id)).toEqual(['del-c2']);
		expect((await app.fetch(new Request('http://x/clients/del-c1'), ENV)).status).toBe(404);
		expect((await app.fetch(new Request('http://x/clients/del-c2'), ENV)).status).toBe(200);

		await restore(ENV, 'client', 'del-c1', ADMIN);
		expect(await db().prepare(`SELECT enabled FROM oauth_clients WHERE id = 'del-c1'`).first()).toEqual({ enabled: 1 });
	});

	it('a deleted role loses its links (kept in the snapshot) and gets them back on restore', async () => {
		await addUser('del-u3', 'del-u3@example.com');
		await db().prepare(`INSERT INTO rbac_roles (id, name, tenant_id) VALUES ('del-r1', 'del-r1', 'default')`).run();
		await db().prepare(`INSERT INTO rbac_roles (id, name, tenant_id, is_system_role) VALUES ('del-sys', 'del-sys', 'default', 1)`).run();
		await db().prepare(`INSERT INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) VALUES ('del-u3', 'del-r1', 'default', 5, 'x')`).run();
		await ENV.AUTH_STORAGE.put('permissions:del-u3', '{}');

		await softDelete(ENV, 'role', 'del-r1', ADMIN);
		expect(await db().prepare(`SELECT 1 FROM rbac_user_roles WHERE role_id = 'del-r1'`).first()).toBeNull();
		expect(await ENV.AUTH_STORAGE.get('permissions:del-u3')).toBeNull();
		await expectError(softDelete(ENV, 'role', 'del-sys', ADMIN), 403);

		await restore(ENV, 'role', 'del-r1', ADMIN);
		expect(await db().prepare(`SELECT assigned_at FROM rbac_user_roles WHERE role_id = 'del-r1' AND user_id = 'del-u3'`).first()).toEqual({ assigned_at: 5 });
	});
});

describe('cleanup', () => {
	it('purges nothing before 30 days, then everything of the user; idempotent', async () => {
		await addUser('del-u4', 'del-u4@example.com');
		await db().prepare(`INSERT INTO user_identities (id, user_id, tenant_id, provider, provider_user_id, created_at) VALUES ('del-i4', 'del-u4', 'default', 'google', 'g-4', 1)`).run();
		await db().prepare(`INSERT INTO rbac_roles (id, name, tenant_id) VALUES ('del-r4', 'del-r4', 'default')`).run();
		await db().prepare(`INSERT INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) VALUES ('del-u4', 'del-r4', 'default', 1, 'x')`).run();
		// Profile/admin sessions of the user and of someone else whose JSON merely mentions the id
		const session = (id: string, user: object) =>
			db()
				.prepare(`INSERT INTO app_sessions (id, app, user_json, access_token, expires_at, created_at, updated_at) VALUES (?, 'profile', ?, 'a', ?, 1, 1)`)
				.bind(id, JSON.stringify(user), Date.now() + DAY)
				.run();
		await session('del-s4', { id: 'del-u4', email: 'del-u4@example.com' });
		await session('del-s5', { id: 'del-u5', email: 'del-u5@example.com', note: 'del-u4' });
		const storage = authStorage(ENV);
		await Storage.set(storage, ['email', 'del-u4@example.com', 'password'], { hash: 'h' });
		await Storage.set(storage, LEGACY_USER_KEYS.user('default', 'del-u4'), { id: 'del-u4' });
		await Storage.set(storage, LEGACY_USER_KEYS.email('default', 'del-u4@example.com'), { userId: 'del-u4' });

		const t0 = Date.now();
		await softDelete(ENV, 'user', 'del-u4', ADMIN, { now: t0 });

		const early = await purgeDeleted(ENV, { now: t0 + 29 * DAY });
		expect(early.purged.user).toBe(0);
		expect(await userRow('del-u4')).not.toBeNull();

		const due = await purgeDeleted(ENV, { now: t0 + RETENTION_MS + 1 });
		expect(due.purged.user).toBe(1);
		expect(await userRow('del-u4')).toBeNull();
		expect(await db().prepare(`SELECT 1 FROM user_identities WHERE user_id = 'del-u4'`).first()).toBeNull();
		expect(await db().prepare(`SELECT 1 FROM rbac_user_roles WHERE user_id = 'del-u4'`).first()).toBeNull();
		expect((await db().prepare(`SELECT id FROM app_sessions WHERE id LIKE 'del-s%' ORDER BY id`).all()).results).toEqual([{ id: 'del-s5' }]);
		await db().prepare(`DELETE FROM app_sessions WHERE id LIKE 'del-s%'`).run();
		expect(await Storage.get(storage, ['email', 'del-u4@example.com', 'password'])).toBeUndefined();
		expect(await Storage.get(storage, LEGACY_USER_KEYS.user('default', 'del-u4'))).toBeUndefined();
		expect(await Storage.get(storage, LEGACY_USER_KEYS.email('default', 'del-u4@example.com'))).toBeUndefined();
		expect(await listDeleted(ENV)).toEqual([]);

		const again = await purgeDeleted(ENV, { now: t0 + RETENTION_MS + 2 });
		expect(again.purged.user + again.failed.user).toBe(0);
	});

	it('"delete permanently now" needs the typed label, queues the item for the next run, and can still be restored', async () => {
		await addUser('del-u5', 'del-u5@example.com');
		await addUser('del-u6', 'del-u6@example.com');
		await softDelete(ENV, 'user', 'del-u5', ADMIN);
		await softDelete(ENV, 'user', 'del-u6', ADMIN);

		await expectError(requestPurge(ENV, 'user', 'del-u5', ADMIN, 'wrong'), 400, 'confirmation_mismatch');
		const queued = await requestPurge(ENV, 'user', 'del-u5', ADMIN, 'del-u5@example.com');
		expect(queued.purgeRequestedAt).not.toBeNull();
		expect(queued.purgeRequestedBy).toBe('del-admin');
		// Nothing removed by the request itself
		expect(await userRow('del-u5')).not.toBeNull();

		await requestPurge(ENV, 'user', 'del-u6', ADMIN, 'del-u6@example.com');
		await restore(ENV, 'user', 'del-u6', ADMIN);

		const run = await purgeDeleted(ENV);
		expect(run.purged.user).toBe(1);
		expect(await userRow('del-u5')).toBeNull();
		expect(await userRow('del-u6')).toMatchObject({ status: 'active', deleted_at: null });
	});

	it('purges clients, roles and themes; a failure is recorded and retried later', async () => {
		const now = Date.now();
		await db().prepare(`INSERT INTO oauth_clients (id, tenant_id, name, enabled, created_at, updated_at) VALUES ('del-c3', 'default', 'Del Three', 1, ?, ?)`).bind(now, now).run();
		await db().prepare(`INSERT INTO rbac_roles (id, name, tenant_id) VALUES ('del-r5', 'del-r5', 'default')`).run();
		await softDelete(ENV, 'client', 'del-c3', ADMIN);
		await softDelete(ENV, 'role', 'del-r5', ADMIN);
		const store = new DeletionStore(db());
		await store.requestPurge('client', 'del-c3', 'del-admin', now);
		await store.requestPurge('role', 'del-r5', 'del-admin', now);
		// A user row the cleanup must refuse: restored behind its back (deleted_at cleared)
		await addUser('del-u7', 'del-u7@example.com');
		await softDelete(ENV, 'user', 'del-u7', ADMIN);
		await db().prepare(`UPDATE users SET deleted_at = NULL, status = 'active' WHERE id = 'del-u7'`).run();
		await store.requestPurge('user', 'del-u7', 'del-admin', now);

		const run = await purgeDeleted(ENV);
		expect(run.purged).toMatchObject({ client: 1, role: 1 });
		expect(run.failed.user).toBe(1);
		expect(await db().prepare(`SELECT 1 FROM oauth_clients WHERE id = 'del-c3'`).first()).toBeNull();
		expect(await db().prepare(`SELECT 1 FROM rbac_roles WHERE id = 'del-r5'`).first()).toBeNull();
		expect(await userRow('del-u7')).not.toBeNull();
		expect(await store.get('user', 'del-u7')).toMatchObject({ attempts: 1, last_error: 'The account is not deleted' });
	});

	it('runs at most the batch size per run', async () => {
		for (let i = 0; i < 3; i++) {
			await addUser(`del-b${i}`, `del-b${i}@example.com`);
			await softDelete(ENV, 'user', `del-b${i}`, ADMIN, { now: 1 });
		}
		expect((await purgeDeleted(ENV, { limit: 2 })).purged.user).toBe(2);
		expect((await purgeDeleted(ENV, { limit: 2 })).purged.user).toBe(1);
	});
});
