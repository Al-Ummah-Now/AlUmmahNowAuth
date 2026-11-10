/**
 * #662: the D1 account-status checks behind every token issuance.
 * - accountStateOf / readAccountState (D1 `users`)
 * - guardIssuerStorage: codes (D1 atomic store and KV) and the approved device
 *   grant of a suspended or deleted account (refresh: onRefresh, refresh-roles.test.ts)
 * - createOnSuccessHandler: password and email-code sign-ins (one handler,
 *   whatever the provider) never reach subject() for a refused account
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, createExecutionContext } from 'cloudflare:test';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { setupDatabase } from '../test-setup';
import { authStorage } from '../storage/auth-storage';
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import { guardIssuerStorage } from '../revocation/token-gate';
import { accountStateOf, isRefusedAccountState, readAccountState } from '../security/account-status';
import { createOnSuccessHandler, type UserServiceLike } from '../handlers/auth-handlers';
import type { RBACServiceImpl } from '@al-ummah-now/openauth/rbac/index';

const E = env as unknown as Env;
const ACTIVE = 'usr_guard662_active';
const SUSPENDED = 'usr_guard662_suspended';
const DELETED = 'usr_guard662_deleted';

async function putUser(id: string, status: string, deletedAt: number | null = null) {
	const ts = Date.now();
	await E.AUTH_DB.prepare(
		`INSERT OR REPLACE INTO users (id, tenant_id, email, name, metadata, status, created_at, updated_at, last_login_at, deleted_at, password_reset_required)
		 VALUES (?, 'default', ?, NULL, NULL, ?, ?, ?, NULL, ?, 0)`
	)
		.bind(id, `${id}@example.com`, status, ts, ts, deletedAt)
		.run();
}

const record = (userId: string) => ({
	properties: { id: userId, email: `${userId}@example.com` },
	clientID: 'web',
	authTime: Date.now(),
	ttl: { access: 900, refresh: 3600 },
});

describe('account state (D1)', () => {
	beforeAll(async () => {
		await setupDatabase();
		await putUser(ACTIVE, 'active');
		await putUser(SUSPENDED, 'suspended');
		await putUser(DELETED, 'deleted', Date.now());
	});

	it('maps rows: only active is allowed; any other status or a deleted_at is refused', () => {
		expect(accountStateOf({ status: 'active', deleted_at: null })).toBe('active');
		expect(accountStateOf({ status: 'suspended', deleted_at: null })).toBe('suspended');
		expect(accountStateOf({ status: 'banned', deleted_at: null })).toBe('suspended');
		expect(accountStateOf({ status: 'active', deleted_at: 1 })).toBe('deleted');
		expect(accountStateOf({ status: 'deleted', deleted_at: null })).toBe('deleted');
		expect(accountStateOf(null)).toBe('missing');
		expect(isRefusedAccountState('suspended')).toBe(true);
		expect(isRefusedAccountState('deleted')).toBe(true);
		expect(isRefusedAccountState('active')).toBe(false);
		expect(isRefusedAccountState('missing')).toBe(false);
	});

	it('reads the state from D1', async () => {
		expect(await readAccountState(E.AUTH_DB, ACTIVE)).toBe('active');
		expect(await readAccountState(E.AUTH_DB, SUSPENDED)).toBe('suspended');
		expect(await readAccountState(E.AUTH_DB, DELETED)).toBe('deleted');
		expect(await readAccountState(E.AUTH_DB, 'usr_nobody')).toBe('missing');
	});
});

describe('issuer storage guard: suspended/deleted accounts (#662)', () => {
	beforeAll(async () => {
		await setupDatabase();
		await E.AUTH_DB.prepare('CREATE TABLE IF NOT EXISTS openauth_atomic (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)').run();
		await putUser(ACTIVE, 'active');
		await putUser(SUSPENDED, 'suspended');
		await putUser(DELETED, 'deleted', Date.now());
	});

	it('refuses and deletes codes of suspended or deleted accounts (D1 atomic store)', async () => {
		const raw = authStorage(E);
		const atomic = Storage.atomic(guardIssuerStorage(raw, { db: E.AUTH_DB }));
		for (const id of [ACTIVE, SUSPENDED, DELETED]) await Storage.atomic(raw).set(['oauth:code', `c-${id}`], record(id));
		expect(await atomic.get(['oauth:code', `c-${ACTIVE}`])).toMatchObject({ clientID: 'web' });
		for (const id of [SUSPENDED, DELETED]) {
			expect(await atomic.get(['oauth:code', `c-${id}`])).toBeUndefined();
			// Deleted, so reinstating the account does not bring it back
			expect(await Storage.atomic(raw).get(['oauth:code', `c-${id}`])).toBeUndefined();
		}
	});

	it('refuses legacy KV codes too', async () => {
		const raw = CloudflarePatchedStorage({ namespace: E.AUTH_STORAGE });
		const guarded = guardIssuerStorage(raw, { db: E.AUTH_DB });
		await Storage.set(raw, ['oauth:code', 'kv-c'], record(SUSPENDED), 600);
		expect(await Storage.get(guarded, ['oauth:code', 'kv-c'])).toBeUndefined();
		expect(await Storage.get(raw, ['oauth:code', 'kv-c'])).toBeUndefined();
	});

	it('leaves refresh tokens to onRefresh (family revocation, retryable 503 on a D1 failure)', async () => {
		const raw = authStorage(E);
		await Storage.atomic(raw).set(['oauth:refresh', `user:${SUSPENDED}`, 'rt'], record(SUSPENDED));
		expect(await Storage.atomic(guardIssuerStorage(raw, { db: E.AUTH_DB })).get(['oauth:refresh', `user:${SUSPENDED}`, 'rt'])).toMatchObject({
			clientID: 'web',
		});
	});

	it('a user D1 does not have yet (legacy KV-only) is not refused', async () => {
		const raw = authStorage(E);
		await Storage.atomic(raw).set(['oauth:code', 'c-missing'], record('usr_not_in_d1'));
		expect(await Storage.atomic(guardIssuerStorage(raw, { db: E.AUTH_DB })).get(['oauth:code', 'c-missing'])).toMatchObject({
			clientID: 'web',
		});
	});

	it('an approved device grant of a suspended account is taken as denied (device_code grant → access_denied)', async () => {
		const raw = authStorage(E);
		const atomic = Storage.atomic(guardIssuerStorage(raw, { db: E.AUTH_DB }));
		const device = (userId: string) => ({
			status: 'approved',
			clientID: 'tv',
			userCode: 'BCDFGHJK',
			expiresAt: Date.now() + 60_000,
			grant: { ...record(userId), type: 'user', subject: `user:${userId}`, family: 'f1' },
		});
		await Storage.atomic(raw).set(['oauth:device', 'h-suspended'], device(SUSPENDED));
		await Storage.atomic(raw).set(['oauth:device', 'h-active'], device(ACTIVE));

		const refused = await atomic.take(['oauth:device', 'h-suspended']);
		expect(refused.status).toBe('denied');
		expect(refused.grant).toBeUndefined();
		// Taken once, as before
		expect(await atomic.take(['oauth:device', 'h-suspended'])).toBeUndefined();

		const allowed = await atomic.take(['oauth:device', 'h-active']);
		expect(allowed.status).toBe('approved');
		expect(allowed.grant.properties.id).toBe(ACTIVE);
	});

	it('a failed D1 read is an error, never a pass', async () => {
		const raw = authStorage(E);
		await Storage.atomic(raw).set(['oauth:code', 'c-dberr'], record(ACTIVE));
		const brokenDb = {
			prepare: () => ({
				bind: () => ({
					first: async () => {
						throw new Error('D1_ERROR: unavailable');
					},
				}),
			}),
		} as unknown as D1Database;
		await expect(Storage.atomic(guardIssuerStorage(raw, { db: brokenDb })).get(['oauth:code', 'c-dberr'])).rejects.toThrow('D1_ERROR');
	});
});

describe('onSuccess refuses suspended accounts for every provider (#662)', () => {
	beforeAll(async () => {
		await setupDatabase();
		await putUser(ACTIVE, 'active');
		await putUser(SUSPENDED, 'suspended');
	});

	let subject: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		subject = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://app.example/cb?code=x' } }));
	});

	function handler(user: { id: string; email: string; status?: string } | null, url = 'https://auth.example/password/authorize') {
		const userService: UserServiceLike = {
			getUserByEmail: vi.fn(async () => user),
			createUser: vi.fn(async () => {
				throw new Error('must not create');
			}),
			updateLastLogin: vi.fn(async () => {}),
		};
		const rbac = { getUserRoles: vi.fn(async () => [{ name: 'member' }]) } as unknown as RBACServiceImpl;
		const onSuccess = createOnSuccessHandler(userService, rbac, {
			request: new Request(url, { method: 'POST' }),
			env: {},
			ctx: createExecutionContext(),
			requestId: 'req-662',
			db: E.AUTH_DB,
			homeUrl: 'https://alummahnow.net/',
		});
		return { onSuccess, userService };
	}

	// "password" is the password form and also the email-code flows (register,
	// forgot password): the password provider reports all of them as "password"
	for (const provider of ['password', 'code', 'google']) {
		it(`provider "${provider}": a suspended account gets the page, not tokens`, async () => {
			const { onSuccess, userService } = handler({ id: SUSPENDED, email: `${SUSPENDED}@example.com`, status: 'suspended' });
			const res = await onSuccess({ subject }, { provider, properties: { email: `${SUSPENDED}@example.com` }, tenantId: 'default', roles: [] }, { id: 'default' });
			expect(res.status).toBe(403);
			expect(await res.text()).toContain('This account is suspended');
			expect(subject).not.toHaveBeenCalled();
			expect(userService.updateLastLogin).not.toHaveBeenCalled();
		});
	}

	it('reads D1 when the user service gives no status', async () => {
		const { onSuccess } = handler({ id: SUSPENDED, email: `${SUSPENDED}@example.com` });
		const res = await onSuccess({ subject }, { provider: 'password', properties: { email: `${SUSPENDED}@example.com` }, tenantId: 'default', roles: [] }, { id: 'default' });
		expect(res.status).toBe(403);
		expect(subject).not.toHaveBeenCalled();
	});

	it('an active account is signed in as before', async () => {
		const { onSuccess, userService } = handler({ id: ACTIVE, email: `${ACTIVE}@example.com`, status: 'active' });
		const res = await onSuccess({ subject }, { provider: 'password', properties: { email: `${ACTIVE}@example.com` }, tenantId: 'default', roles: [] }, { id: 'default' });
		expect(res.status).toBe(302);
		expect(subject).toHaveBeenCalledOnce();
		expect(userService.updateLastLogin).toHaveBeenCalledWith('default', ACTIVE);
	});
});
