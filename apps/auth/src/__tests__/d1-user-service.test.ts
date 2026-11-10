/**
 * AU-3: D1 is the source of truth for users. Runs against the real (miniflare)
 * D1 with the production unique indexes and the real KV namespace for the
 * legacy copy. The concurrency tests fire many writers at once and check that
 * no change is lost and no constraint is broken.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { D1UserAdapter, UserError } from '@al-ummah-now/openauth';
import '../test-setup';
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import { D1UserService, LEGACY_USER_KEYS } from '../services/d1-user-service';

const T = 'default';
const storage = () => CloudflarePatchedStorage({ namespace: env.AUTH_STORAGE });
const service = (db: D1Database = env.AUTH_DB, kv = storage()) =>
	new D1UserService({ db, adapter: new D1UserAdapter({ db, usersTable: 'users' }), legacy: kv });

/** KV as another location sees it: reads of `key` return an older value (KV is ~60 s eventually consistent). */
function laggingStorage(key: string[], stale: unknown): ReturnType<typeof storage> {
	const real = storage();
	return {
		...real,
		get: async (k: string[]) => (k.join('/') === key.join('/') ? (stale as Record<string, unknown>) : real.get(k)),
	} as ReturnType<typeof storage>;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return 'ok';
	} catch (error) {
		return error instanceof UserError ? error.code : `unexpected: ${String(error)}`;
	}
}

/** A user the old UserServiceImpl wrote to KV only (its D1 insert never landed). */
async function seedKvOnly(id: string, email: string, extra: Record<string, unknown> = {}) {
	const now = Date.now();
	const user = {
		id,
		tenant_id: T,
		email,
		name: 'Legacy',
		metadata: { plan: 'old' },
		status: 'active',
		created_at: now - 86_400_000,
		updated_at: now - 86_400_000,
		last_login_at: null,
		deleted_at: null,
		password_reset_required: false,
		...extra,
	};
	await storage().set(LEGACY_USER_KEYS.user(T, id), user);
	await storage().set(LEGACY_USER_KEYS.email(T, email), { userId: id });
	return user;
}

const d1Row = (id: string) => env.AUTH_DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first<Record<string, unknown>>();

beforeEach(async () => {
	await env.AUTH_DB.prepare('DELETE FROM user_identities').run();
	await env.AUTH_DB.prepare('DELETE FROM users').run();
});

describe('D1 is the source of truth', () => {
	it('never writes a KV copy', async () => {
		const s = service();
		const user = await s.createUser(T, { email: 'New@Example.com', name: ' New ' });
		await s.updateUser(T, user.id, { name: 'Renamed' });
		await s.suspendUser(T, user.id);
		await s.updateLastLogin(T, user.id);
		expect(user.email).toBe('new@example.com');
		expect(user.name).toBe('New');
		expect(await storage().get(LEGACY_USER_KEYS.user(T, user.id))).toBeUndefined();
		expect(await storage().get(LEGACY_USER_KEYS.email(T, user.email))).toBeUndefined();
		expect((await d1Row(user.id))?.name).toBe('Renamed');
	});

	it('a stale KV copy no longer overrides an admin change (the AU-3 bug)', async () => {
		const here = service();
		const user = await here.createUser(T, { email: 'stale@example.com' });
		await storage().set(LEGACY_USER_KEYS.user(T, user.id), user);
		await here.suspendUser(T, user.id);
		// A sign-in in another location, whose KV still serves the record from before the suspension
		const elsewhere = service(env.AUTH_DB, laggingStorage(LEGACY_USER_KEYS.user(T, user.id), { ...user, status: 'active' }));
		await elsewhere.updateLastLogin(T, user.id);
		for (const s of [here, elsewhere]) {
			const after = await s.getUser(T, user.id);
			expect(after?.status).toBe('suspended');
			expect(after?.last_login_at).not.toBeNull();
		}
	});

	it('concurrent admin actions and sign-ins all land; none overwrites another', async () => {
		const s = service();
		const user = await s.createUser(T, { email: 'busy@example.com' });
		await Promise.all([
			s.suspendUser(T, user.id),
			s.forcePasswordReset(T, user.id),
			s.updateUser(T, user.id, { name: 'Concurrent', metadata: { k: 1 } }),
			...Array.from({ length: 100 }, () => s.updateLastLogin(T, user.id)),
		]);
		const after = await s.getUser(T, user.id);
		expect(after).toMatchObject({ status: 'suspended', password_reset_required: true, name: 'Concurrent', metadata: { k: 1 } });
		expect(after?.last_login_at).not.toBeNull();
	});

	it('updateLastLogin is one SQL statement', async () => {
		const user = await service().createUser(T, { email: 'one@example.com' });
		const statements: string[] = [];
		const counting = new Proxy(env.AUTH_DB, {
			get(target, prop) {
				if (prop === 'prepare') return (sql: string) => (statements.push(sql), target.prepare(sql));
				const value = Reflect.get(target, prop);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		await service(counting).updateLastLogin(T, user.id);
		expect(statements).toHaveLength(1);
		expect(statements[0]).toMatch(/^UPDATE users SET last_login_at/);
	});

	it('200 parallel sign-ups for one address: exactly one account', async () => {
		const s = service();
		const codes = await Promise.all(Array.from({ length: 200 }, () => codeOf(s.createUser(T, { email: 'race@example.com' }))));
		expect(codes.filter((c) => c === 'ok')).toHaveLength(1);
		expect(codes.filter((c) => c === 'email_already_exists')).toHaveLength(199);
		const { results } = await env.AUTH_DB.prepare("SELECT id FROM users WHERE email = 'race@example.com'").all();
		expect(results).toHaveLength(1);
	});

	it('changing to a taken email is refused, also when both change at once', async () => {
		const s = service();
		const a = await s.createUser(T, { email: 'a@example.com' });
		const b = await s.createUser(T, { email: 'b@example.com' });
		expect(await codeOf(s.updateUser(T, b.id, { email: 'A@example.com' }))).toBe('email_already_exists');
		const codes = await Promise.all([
			codeOf(s.updateUser(T, a.id, { email: 'same@example.com' })),
			codeOf(s.updateUser(T, b.id, { email: 'same@example.com' })),
		]);
		expect(codes.sort()).toEqual(['email_already_exists', 'ok']);
	});
});

describe('existing users only in KV keep working', () => {
	it('found by email and by id, and copied into D1 on first read', async () => {
		const legacy = await seedKvOnly('usr_legacy1', 'legacy@example.com');
		const s = service();
		const byEmail = await s.getUserByEmail(T, 'Legacy@Example.com');
		expect(byEmail).toMatchObject({ id: legacy.id, email: legacy.email, name: 'Legacy', metadata: { plan: 'old' }, status: 'active' });
		expect(await d1Row(legacy.id)).toMatchObject({ email: legacy.email, created_at: legacy.created_at });
		expect(await s.getUser(T, legacy.id)).toMatchObject({ id: legacy.id });
	});

	it('100 parallel first reads of a KV-only user make one D1 row and all agree', async () => {
		await seedKvOnly('usr_legacy2', 'legacy2@example.com');
		const s = service();
		const users = await Promise.all(Array.from({ length: 100 }, () => s.getUser(T, 'usr_legacy2')));
		expect(users.every((u) => u?.id === 'usr_legacy2')).toBe(true);
		const { results } = await env.AUTH_DB.prepare("SELECT id FROM users WHERE id = 'usr_legacy2'").all();
		expect(results).toHaveLength(1);
	});

	it('admin mutations on a KV-only user go to D1, not to the KV copy', async () => {
		const legacy = await seedKvOnly('usr_legacy3', 'legacy3@example.com');
		const s = service();
		await s.suspendUser(T, legacy.id);
		expect((await d1Row(legacy.id))?.status).toBe('suspended');
		expect((await storage().get(LEGACY_USER_KEYS.user(T, legacy.id)))?.status).toBe('active');
		expect((await s.getUser(T, legacy.id))?.status).toBe('suspended');
	});

	it('a sign-up cannot take the address of a KV-only account', async () => {
		await seedKvOnly('usr_legacy4', 'legacy4@example.com');
		expect(await codeOf(service().createUser(T, { email: 'legacy4@example.com' }))).toBe('email_already_exists');
	});

	it('a deleted KV-only user stays deleted', async () => {
		await seedKvOnly('usr_legacy5', 'legacy5@example.com', { status: 'deleted', deleted_at: Date.now() - 1000 });
		const s = service();
		expect(await s.getUser(T, 'usr_legacy5')).toBeNull();
		expect(await codeOf(s.suspendUser(T, 'usr_legacy5'))).toBe('user_not_found');
	});

	it('ignores a stale KV email index whose user has since changed address in D1', async () => {
		const s = service();
		const legacy = await seedKvOnly('usr_legacy6', 'old@example.com');
		await s.updateUser(T, legacy.id, { email: 'new@example.com' });
		expect(await s.getUserByEmail(T, 'old@example.com')).toBeNull();
		expect((await s.getUserByEmail(T, 'new@example.com'))?.id).toBe(legacy.id);
	});

	it('a KV ghost whose address belongs to a D1 user is not brought back', async () => {
		const s = service();
		const real = await s.createUser(T, { email: 'owner@example.com' });
		await seedKvOnly('usr_ghost', 'owner@example.com');
		expect(await s.getUser(T, 'usr_ghost')).toBeNull();
		expect((await s.getUserByEmail(T, 'owner@example.com'))?.id).toBe(real.id);
		expect(await d1Row('usr_ghost')).toBeNull();
	});
});

describe('delete', () => {
	it('soft-deletes in D1, removes the old KV copy, and frees the address', async () => {
		const legacy = await seedKvOnly('usr_legacy7', 'gone@example.com');
		const s = service();
		await s.deleteUser(T, legacy.id);
		expect(await d1Row(legacy.id)).toMatchObject({ status: 'deleted' });
		expect(await storage().get(LEGACY_USER_KEYS.user(T, legacy.id))).toBeUndefined();
		expect(await storage().get(LEGACY_USER_KEYS.email(T, 'gone@example.com'))).toBeUndefined();
		expect(await s.getUser(T, legacy.id)).toBeNull();
		expect(await s.getUserByEmail(T, 'gone@example.com')).toBeNull();
		const again = await s.createUser(T, { email: 'gone@example.com' });
		expect(again.id).not.toBe(legacy.id);
	});

	it('a second delete answers user_not_found, as before', async () => {
		const s = service();
		const user = await s.createUser(T, { email: 'twice@example.com' });
		await s.deleteUser(T, user.id);
		expect(await codeOf(s.deleteUser(T, user.id))).toBe('user_not_found');
	});
});

describe('same answers as UserServiceImpl', () => {
	it('error codes', async () => {
		const s = service();
		expect(await codeOf(s.updateUser(T, 'usr_missing', { name: 'x' }))).toBe('user_not_found');
		expect(await codeOf(s.suspendUser(T, 'usr_missing'))).toBe('user_not_found');
		expect(await codeOf(s.revokeUserSessions(T, 'usr_missing'))).toBe('user_not_found');
		const user = await s.createUser(T, { email: 'codes@example.com' });
		expect(await codeOf(s.unsuspendUser(T, user.id))).toBe('user_not_found');
		const first = await s.suspendUser(T, user.id);
		expect(first.user.status).toBe('suspended');
		const second = await s.suspendUser(T, user.id);
		expect(second).toMatchObject({ user: { status: 'suspended' }, revoked_sessions: 0 });
		expect((await s.unsuspendUser(T, user.id)).status).toBe('active');
		expect(await codeOf(s.unlinkIdentity(T, user.id, 'idt_missing'))).toBe('identity_not_found');
	});

	it('50 parallel links of one provider account: exactly one', async () => {
		const s = service();
		const user = await s.createUser(T, { email: 'link@example.com' });
		const codes = await Promise.all(
			Array.from({ length: 50 }, () => codeOf(s.linkIdentity(T, user.id, { provider: 'google', provider_user_id: 'g-1', provider_data: null })))
		);
		expect(codes.filter((c) => c === 'ok')).toHaveLength(1);
		expect(codes.filter((c) => c === 'identity_already_linked')).toHaveLength(49);
		const [identity] = await s.getUserIdentities(T, user.id);
		await s.unlinkIdentity(T, user.id, identity.id);
		expect(await s.getUserIdentities(T, user.id)).toEqual([]);
	});

	it('password reset flag round trip', async () => {
		const s = service();
		const user = await s.createUser(T, { email: 'reset@example.com' });
		expect((await s.forcePasswordReset(T, user.id)).password_reset_required).toBe(true);
		expect((await s.clearPasswordResetRequired(T, user.id)).password_reset_required).toBe(false);
	});
});
