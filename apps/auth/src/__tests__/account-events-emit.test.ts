/**
 * What emits account events (AlUmmahNowAuth#507 C1b): an account deleted by its
 * owner, an admin or a revoked invite, restored, and purged. One event per change,
 * in its batch; none when another request got there first.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import worker from '../index';
import { setupDatabase } from '../test-setup';
import { softDelete, restore, requestPurge } from '../deletions/service';
import { purgeDeleted, purgeItem } from '../deletions/purge';
import { DISPOSABLE_CLEANUP_ACTOR } from '../deletions/kinds';
import { DeletionStore, RETENTION_MS } from '../deletions/store';
import { createActionRunner } from '../moderation/actions';
import { InviteService, purgeRevokedInvites } from '../invites/service';
import { recordAccountEvent } from '../account-events/record';
import { clearJWKSCache, SIGNING_KEY_KV_KEY } from '../utils/jwks-cache';

const E = env as unknown as Env;
const db = () => E.AUTH_DB;
const ADMIN = { userId: 'aee-admin', email: 'aee-admin@example.com' };
const queued: string[] = [];
const queue = { sendBatch: vi.fn(async (m: { body: { jti: string } }[]) => void queued.push(...m.map((x) => x.body.jti))) };
const on = (over: Partial<Env> = {}) => ({ ...E, ACCOUNT_EVENTS: 'on', ACCOUNT_EVENTS_QUEUE: queue as unknown as Queue, ...over }) as Env;

const events = async (userId: string) =>
	(await db().prepare('SELECT type, reason FROM account_events WHERE user_id = ? ORDER BY seq').bind(userId).all<{ type: string; reason: string | null }>()).results.map((e) => (e.reason ? `${e.type}:${e.reason}` : e.type));
const deliveries = async (userId: string) => (await db().prepare('SELECT jti FROM account_event_deliveries WHERE user_id = ? ORDER BY seq').bind(userId).all<{ jti: string }>()).results.map((d) => d.jti);
const state = (id: string) => db().prepare('SELECT status, deleted_at FROM users WHERE id = ?').bind(id).first<{ status: string; deleted_at: number | null }>();

async function addUser(id: string, status = 'active') {
	await db().prepare(`INSERT OR REPLACE INTO users (id, tenant_id, email, status, created_at, updated_at, password_reset_required) VALUES (?1, 'default', ?1 || '@example.com', ?2, 1, 1, 0)`).bind(id, status).run();
}

beforeAll(async () => {
	await setupDatabase();
});
beforeEach(async () => {
	for (const t of ['account_event_deliveries', 'account_events', 'user_invites', 'admin_deletions']) await db().prepare(`DELETE FROM ${t}`).run();
	await db().prepare(`DELETE FROM users WHERE id LIKE 'aee-%' OR id LIKE 'usr_aee%' OR email LIKE 'aee-%'`).run();
	await db()
		.prepare(
			`INSERT OR REPLACE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
			 VALUES ('aee-receiver', 'default', 'aee-receiver', 'hash', '["client_credentials"]', '["account-events:receive"]', '[]', ?1, 1, 1, 1)`
		)
		.bind(JSON.stringify({ events: { uri: 'https://receiver.example.com/events', types: ['account-disabled', 'account-enabled', 'account-purged'] } }))
		.run();
	queued.length = 0;
	queue.sendBatch.mockClear();
});
afterAll(async () => {
	await db().prepare(`DELETE FROM oauth_clients WHERE id = 'aee-receiver'`).run();
	await db().prepare(`DELETE FROM users WHERE id LIKE 'aee-%' OR id LIKE 'usr_aee%' OR email LIKE 'aee-%'`).run();
	for (const t of ['account_event_deliveries', 'account_events', 'user_invites', 'admin_deletions']) await db().prepare(`DELETE FROM ${t}`).run();
});

describe('an admin', () => {
	it('deletes, restores, deletes and the cleanup purges: hide, show, hide, erase', async () => {
		await addUser('aee-u');
		await softDelete(on(), 'user', 'aee-u', ADMIN);
		expect(await events('aee-u')).toEqual(['account-disabled:deleted']);
		await restore(on(), 'user', 'aee-u', ADMIN);
		await softDelete(on(), 'user', 'aee-u', ADMIN);
		await requestPurge(on(), 'user', 'aee-u', ADMIN, 'aee-u@example.com');
		// asked for, and still restorable: nothing is erased yet
		expect(await events('aee-u')).toEqual(['account-disabled:deleted', 'account-enabled', 'account-disabled:deleted']);
		expect((await purgeDeleted(on())).purged.user).toBe(1);
		expect(await state('aee-u')).toBeNull();
		expect(await events('aee-u')).toEqual(['account-disabled:deleted', 'account-enabled', 'account-disabled:deleted', 'account-purged']);
		// each one queued for its subscriber
		expect(queued).toEqual(await deliveries('aee-u'));
		expect(queued).toHaveLength(4);
	});
	it('a suspended account is hidden and shown the same way', async () => {
		await addUser('aee-s', 'suspended');
		await softDelete(on(), 'user', 'aee-s', ADMIN);
		await restore(on(), 'user', 'aee-s', ADMIN);
		expect(await state('aee-s')).toMatchObject({ status: 'suspended' });
		expect(await events('aee-s')).toEqual(['account-disabled:deleted', 'account-enabled']);
	});
	it('the 30 days pass: purged, once, also when the cleanup is retried', async () => {
		await addUser('aee-r');
		const long = Date.now() - RETENTION_MS - 1000;
		await softDelete(on(), 'user', 'aee-r', ADMIN, { now: long });
		const row = await db().prepare(`SELECT * FROM admin_deletions WHERE item_id = 'aee-r'`).first();
		await purgeDeleted(on());
		// the last step failed and the row in Recently deleted is still there
		await db()
			.prepare(`INSERT INTO admin_deletions (kind, item_id, tenant_id, label, deleted_at, deleted_by) VALUES ('user', 'aee-r', 'default', ?1, ?2, 'x')`)
			.bind((row as { label: string }).label, long)
			.run();
		await purgeDeleted(on());
		expect(await events('aee-r')).toEqual(['account-disabled:deleted', 'account-purged']);
	});
	it('refused deletes and restores send nothing', async () => {
		await addUser('aee-x');
		await softDelete(on(), 'user', 'aee-x', ADMIN);
		await expect(softDelete(on(), 'user', 'aee-x', ADMIN)).rejects.toThrow();
		await expect(softDelete(on(), 'user', 'aee-none', ADMIN)).rejects.toThrow();
		await expect(restore(on(), 'user', 'aee-none', ADMIN)).rejects.toThrow();
		await db().prepare(`UPDATE users SET email = 'aee-taken@example.com' WHERE id = 'aee-x'`).run();
		await addUser('aee-taken');
		await expect(restore(on(), 'user', 'aee-x', ADMIN)).rejects.toThrow(/Another account/);
		expect(await events('aee-x')).toEqual(['account-disabled:deleted']);
		expect(await events('aee-none')).toEqual([]);
	});
	it('an account restored behind the cleanup is not purged, and nobody is told it was', async () => {
		await addUser('aee-live');
		await softDelete(on(), 'user', 'aee-live', ADMIN);
		await db().prepare(`UPDATE users SET status = 'active', deleted_at = NULL WHERE id = 'aee-live'`).run();
		await expect(purgeItem(on(), 'user', 'aee-live')).rejects.toThrow(/not deleted/);
		expect(await events('aee-live')).toEqual(['account-disabled:deleted']);
	});
	it('the state is read in the batch: a change another request made first sends nothing', async () => {
		await addUser('aee-race');
		const purge = await recordAccountEvent(on(), { type: 'account-purged', userId: 'aee-race' }, { onlyIf: 'deleted' });
		const enable = await recordAccountEvent(on(), { type: 'account-enabled', userId: 'aee-race' }, { onlyIf: 'deleted' });
		const invited = await recordAccountEvent(on(), { type: 'account-disabled', userId: 'aee-race', reason: 'deleted' }, { onlyIf: 'invited' });
		const unused = await recordAccountEvent(on(), { type: 'account-purged', userId: 'aee-race' }, { onlyIf: 'untrackedUnused' });
		await db().batch([...purge.statements, ...enable.statements, ...invited.statements, ...unused.statements]);
		expect(await events('aee-race')).toEqual([]);
		expect(await deliveries('aee-race')).toEqual([]);
		const gone = await recordAccountEvent(on(), { type: 'account-disabled', userId: 'aee-nobody', reason: 'deleted' }, { onlyIf: 'live' });
		await db().batch(gone.statements);
		expect(await events('aee-nobody')).toEqual([]);
	});
	it('a moderation deletion is one too', async () => {
		await addUser('aee-mod');
		expect(await createActionRunner(on())('delete_account', 'aee-mod', 'default')).toMatchObject({ ok: true });
		expect(await events('aee-mod')).toEqual(['account-disabled:deleted']);
	});
	it('deleting a client, a role or a theme is no account event', async () => {
		await db().prepare(`INSERT OR REPLACE INTO rbac_roles (id, name, tenant_id) VALUES ('aee-role', 'aee-role', 'default')`).run();
		await softDelete(on(), 'role', 'aee-role', ADMIN);
		await restore(on(), 'role', 'aee-role', ADMIN);
		await db().prepare(`DELETE FROM rbac_roles WHERE id = 'aee-role'`).run();
		expect((await db().prepare('SELECT COUNT(*) AS n FROM account_events').first<{ n: number }>())!.n).toBe(0);
	});
	it('off: deletes and restores as before, and records nothing', async () => {
		await addUser('aee-off');
		await softDelete(E, 'user', 'aee-off', ADMIN);
		await restore(E, 'user', 'aee-off', ADMIN);
		await softDelete(E, 'user', 'aee-off', ADMIN);
		expect(await purgeItem(E, 'user', 'aee-off')).toBe(true);
		expect(await state('aee-off')).toBeNull();
		expect(await events('aee-off')).toEqual([]);
	});
	it('a queue that is down changes nothing for the admin', async () => {
		await addUser('aee-q');
		queue.sendBatch.mockRejectedValue(new Error('queue down'));
		await softDelete(on(), 'user', 'aee-q', ADMIN);
		queue.sendBatch.mockImplementation(async (m: { body: { jti: string } }[]) => void queued.push(...m.map((x) => x.body.jti)));
		expect(await state('aee-q')).toMatchObject({ status: 'deleted' });
		expect(await deliveries('aee-q')).toHaveLength(1);
	});
});

describe('the owner, DELETE /account', () => {
	const ISSUER = 'http://localhost:3301';
	let key: CryptoKey;
	let previous: string | null;
	beforeAll(async () => {
		const pair = await generateKeyPair('ES256', { extractable: true });
		key = pair.privateKey as CryptoKey;
		previous = await E.AUTH_STORAGE.get(SIGNING_KEY_KV_KEY);
		await E.AUTH_STORAGE.put(SIGNING_KEY_KV_KEY, JSON.stringify({ id: 'aee-kid', alg: 'ES256', publicKey: await exportSPKI(pair.publicKey), privateKey: '', created: Date.now() }));
		clearJWKSCache();
	});
	afterAll(async () => {
		if (previous) await E.AUTH_STORAGE.put(SIGNING_KEY_KV_KEY, previous);
		else await E.AUTH_STORAGE.delete(SIGNING_KEY_KV_KEY);
		clearJWKSCache();
	});
	async function del(id: string, e: Env, answered?: (status: number) => void) {
		const token = await new SignJWT({ mode: 'access', type: 'user', aud: 'viewer', properties: { id, email: `${id}@example.com`, roles: [] }, auth_time: Math.floor(Date.now() / 1000) - 60 })
			.setProtectedHeader({ alg: 'ES256', kid: 'aee-kid' })
			.setIssuer(ISSUER)
			.setSubject('user:aee')
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(key);
		const ctx = createExecutionContext();
		const res = await worker.fetch(new Request(`${ISSUER}/account`, { method: 'DELETE', headers: { host: 'localhost:3301', Authorization: `Bearer ${token}` } }), e, ctx);
		answered?.(res.status);
		await waitOnExecutionContext(ctx);
		return res;
	}

	it('hides at once, once; it is listed, restorable, and purged with the rest', async () => {
		await addUser('usr_aee1');
		expect((await del('usr_aee1', on())).status).toBe(200);
		expect((await del('usr_aee1', on())).status).toBe(200);
		expect(await state('usr_aee1')).toMatchObject({ status: 'deleted' });
		expect(await events('usr_aee1')).toEqual(['account-disabled:deleted']);
		expect(queued).toEqual(await deliveries('usr_aee1'));
		expect(await db().prepare(`SELECT deleted_by FROM admin_deletions WHERE kind = 'user' AND item_id = 'usr_aee1'`).first()).toEqual({ deleted_by: 'self' });
		await restore(on(), 'user', 'usr_aee1', ADMIN);
		expect(await events('usr_aee1')).toEqual(['account-disabled:deleted', 'account-enabled']);
	});
	it('answers while the queue hangs, and with events off', async () => {
		await addUser('usr_aee2');
		let release!: () => void;
		queue.sendBatch.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
		const answered = vi.fn();
		const done = del('usr_aee2', on(), answered);
		// answered, deleted, and the queue still hanging
		await vi.waitFor(() => expect(answered).toHaveBeenCalledWith(200), { timeout: 5000 });
		expect(await state('usr_aee2')).toMatchObject({ status: 'deleted' });
		expect(release).toBeTypeOf('function');
		release();
		expect((await done).status).toBe(200);
		await addUser('usr_aee3');
		expect((await del('usr_aee3', E)).status).toBe(200);
		expect(await state('usr_aee3')).toMatchObject({ status: 'deleted' });
		expect(await events('usr_aee3')).toEqual([]);
	});
});

it('cron suppresses account events when resuming a QA disposable purge', async () => {
	const userId = 'aee-disposable-resume';
	await addUser(userId, 'deleted');
	await db().prepare('UPDATE users SET deleted_at = 1 WHERE id = ?').bind(userId).run();
	await new DeletionStore(db()).insertStatement({
		kind: 'user',
		itemId: userId,
		tenantId: 'default',
		label: `${userId}@example.com`,
		deletedBy: DISPOSABLE_CLEANUP_ACTOR,
		snapshot: { erased_audit_id: 'erased:00000000000000000000000000000000' },
		now: 1,
	}).run();
	expect((await purgeDeleted(on())).purged.user).toBe(1);
	expect(await state(userId)).toBeNull();
	expect(await events(userId)).toEqual([]);
});

describe('invites', () => {
	const hex = () => crypto.randomUUID().replace(/-/g, '');
	const actor = { userId: 'usr_x', email: 'x@example.com', clientId: 'videos' };
	async function invite(events?: Env) {
		const service = new InviteService(db(), events ? { events } : {});
		const id = `inv_${hex()}`;
		const userId = `usr_${hex()}`;
		await service.create({ inviteId: id, userId, email: `aee-${hex().slice(0, 8)}@example.com` } as never, actor as never);
		return { service, id, userId };
	}
	it('revoke hides, restore shows, the cleanup erases', async () => {
		const { service, id, userId } = await invite(on());
		expect(await events(userId)).toEqual([]);
		await service.revoke(id, actor as never);
		await service.revoke(id, actor as never);
		expect(await events(userId)).toEqual(['account-disabled:deleted']);
		await service.restore(id);
		await service.revoke(id, actor as never);
		await db().prepare('UPDATE admin_deletions SET deleted_at = ? WHERE item_id = ?').bind(Date.now() - RETENTION_MS - 1000, userId).run();
		expect((await purgeDeleted(on())).purged.user).toBe(1);
		expect(await events(userId)).toEqual(['account-disabled:deleted', 'account-enabled', 'account-disabled:deleted', 'account-purged']);
		expect(queued).toEqual(await deliveries(userId));
	});
	const old = () => Date.now() - RETENTION_MS - 1000;
	const purged = async (userId: string) => (await events(userId)).filter((e) => e === 'account-purged').length;
	it('the account cleanup first, then the invites cleanup: told once', async () => {
		const { service, id, userId } = await invite(on());
		await service.revoke(id, actor as never);
		const row = (await db().prepare('SELECT * FROM user_invites WHERE id = ?').bind(id).first<Record<string, unknown>>())!;
		expect(await purgeItem(on(), 'user', userId)).toBe(true);
		expect(await purged(userId)).toBe(1);
		// the invites cleanup read its row before that and runs its batch after: the row is there again
		const left = { ...row, deleted_at: old() };
		const columns = Object.keys(left);
		await db()
			.prepare(`INSERT INTO user_invites (${columns.join(', ')}) VALUES (${columns.map((_, n) => `?${n + 1}`).join(', ')})`)
			.bind(...Object.values(left))
			.run();
		expect(await purgeRevokedInvites(db(), undefined, undefined, on())).toEqual({ purged: 1, failed: 0 });
		expect(await purged(userId)).toBe(1);
	});
	it('leaves tracked accounts to the account purge and refuses invite restore once claimed', async () => {
		const { service, id, userId } = await invite(on());
		await service.revoke(id, actor as never);
		await db().prepare('UPDATE user_invites SET deleted_at = ? WHERE id = ?').bind(old(), id).run();
		await db().prepare('UPDATE admin_deletions SET deleted_at = ? WHERE item_id = ?').bind(old(), userId).run();
		await db().prepare(`INSERT INTO audit_events (timestamp, event_type, severity, user_id, success)
			VALUES ('2026-11-26T00:00:00Z', 'login_success', 'info', ?1, 1), ('2026-11-26T00:01:00Z', 'login_success', 'info', ?1, 1)`).bind(userId).run();
		expect((await purgeDeleted(on(), { auditRedaction: { batchSize: 1, maxBatches: 1 } })).purged.user).toBe(0);
		expect(await purgeRevokedInvites(db(), undefined, undefined, on())).toEqual({ purged: 0, failed: 0 });
		await expect(service.restore(id)).rejects.toMatchObject({ status: 409, code: 'purge_in_progress' });
		expect(await events(userId)).toEqual(['account-disabled:deleted']);
		expect((await purgeDeleted(on())).purged.user).toBe(1);
		expect([await state(userId), await purged(userId)]).toEqual([null, 1]);
	});

	it('an account that signed in is kept, and not announced as purged', async () => {
		const { service, id, userId } = await invite(on());
		await service.revoke(id, actor as never);
		await db().prepare('UPDATE users SET last_login_at = 5 WHERE id = ?').bind(userId).run();
		await db().prepare('UPDATE user_invites SET deleted_at = ? WHERE id = ?').bind(Date.now() - RETENTION_MS - 1000, id).run();
		await purgeRevokedInvites(db(), undefined, undefined, on());
		expect(await state(userId)).not.toBeNull();
		expect(await events(userId)).toEqual(['account-disabled:deleted']);
	});
	it('off: as before', async () => {
		const { service, id, userId } = await invite(E);
		await service.revoke(id, actor as never);
		await service.restore(id);
		expect(await events(userId)).toEqual([]);
	});
});
