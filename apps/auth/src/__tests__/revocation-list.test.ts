/**
 * #437: the token revocation list, the refresh-token gate in front of the
 * issuer, POST /token/revoke and POST /account/sign-out-all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { Hono } from 'hono';
import worker from '../index';
import { setupDatabase } from '../test-setup';
import { clearJWKSCache, SIGNING_KEY_KV_KEY } from '../utils/jwks-cache';
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import { authStorage } from '../storage/auth-storage';
import { loadRefreshToken } from '@al-ummah-now/openauth/refresh-token';
import {
	REVOCATION_TTL_SECONDS,
	isRevoked,
	readRevocation,
	readRevocationForRefresh,
	revocationKey,
	revokeUser,
	type RevocationEntry,
} from '../revocation/revocation-list';
import { guardIssuerStorage, parseAccessTtl } from '../revocation/token-gate';
import { adminUserActionReason, endBrowserSignIns, revokeOnAdminUserAction, revokeOnPasswordChange } from '../revocation/lifecycle';

const ISSUER = 'http://localhost:3301';
const E = env as unknown as Env;
const KV = () => E.TOKEN_REVOCATIONS!;
const nowS = () => Math.floor(Date.now() / 1000);

/** One browser signed in to `userId` (browser_sessions + an active account_sessions row). */
async function signInBrowser(browserId: string, userId: string) {
	const ts = Date.now();
	await E.AUTH_DB.prepare(
		`INSERT OR REPLACE INTO browser_sessions (id, tenant_id, created_at, last_activity, active_user_id) VALUES (?, 'default', ?, ?, ?)`,
	)
		.bind(browserId, ts, ts, userId)
		.run();
	await E.AUTH_DB.prepare(
		`INSERT OR REPLACE INTO account_sessions (id, browser_session_id, user_id, is_active, authenticated_at, expires_at, subject_type, refresh_token, client_id) VALUES (?, ?, ?, 1, ?, ?, 'user', 'rt', 'web')`,
	)
		.bind(`as_${browserId}`, browserId, userId, ts, ts + 86_400_000)
		.run();
}
const accountSessions = async (userId: string) =>
	(await E.AUTH_DB.prepare('SELECT COUNT(*) AS n FROM account_sessions WHERE user_id = ?').bind(userId).first<{ n: number }>())!.n;
const activeUser = async (browserId: string) =>
	(await E.AUTH_DB.prepare('SELECT active_user_id AS u FROM browser_sessions WHERE id = ?').bind(browserId).first<{ u: string | null }>())?.u ?? null;

/** In-memory KV that records put options. */
function memoryKv() {
	const data = new Map<string, string>();
	const puts: Array<{ key: string; ttl?: number }> = [];
	return {
		data,
		puts,
		kv: {
			async get(key: string, type?: string) {
				const v = data.get(key);
				return v === undefined ? null : type === 'json' ? JSON.parse(v) : v;
			},
			async put(key: string, value: string, opts?: { expirationTtl?: number }) {
				data.set(key, value);
				puts.push({ key, ttl: opts?.expirationTtl });
			},
		} as unknown as KVNamespace,
	};
}

describe('revocation list', () => {
	it('revokeUser covers this second, keeps the later of two revocations and outlives refresh tokens', async () => {
		const { kv, puts } = memoryKv();
		const t = Date.UTC(2026, 10, 8, 12, 0, 0);
		const first = await revokeUser({ kv }, 'usr_a', 'sign_out_all', t);
		expect(first!.before).toBe(t / 1000 + 1);
		expect(puts[0]).toEqual({ key: 'u:usr_a', ttl: REVOCATION_TTL_SECONDS });
		expect(REVOCATION_TTL_SECONDS).toBeGreaterThan(365 * 86400);
		// A clock behind the first write never moves `before` back
		const second = await revokeUser({ kv }, 'usr_a', 'password_changed', t - 60_000);
		expect(second!.before).toBe(first!.before);
		expect(second!.reason).toBe('password_changed');
	});

	it('isRevoked: sign-in time decides, iat stands in', () => {
		const entry: RevocationEntry = { v: 1, before: 1000, updatedAt: 0 };
		expect(isRevoked(null, { iat: 1 })).toBe(false);
		expect(isRevoked(entry, { authTime: 999, iat: 2000 })).toBe(true); // refreshed after, signed in before
		expect(isRevoked(entry, { authTime: 1000, iat: 1000 })).toBe(false);
		expect(isRevoked(entry, { iat: 999 })).toBe(true);
		expect(isRevoked(entry, { iat: 1001 })).toBe(false);
		expect(isRevoked(entry, {})).toBe(true);
	});

	it('does nothing without any revocation store', async () => {
		expect(await revokeUser({}, 'usr_a', 'sign_out_all')).toBeNull();
		expect(await readRevocation(undefined, 'usr_a')).toBeNull();
	});

	it('parseAccessTtl accepts whole seconds >= 60 only', () => {
		expect(parseAccessTtl('900')).toBe(900);
		expect(parseAccessTtl(900)).toBe(900);
		for (const bad of [undefined, '', 'abc', '30', '90.5', '-900']) expect(parseAccessTtl(bad)).toBeUndefined();
	});

	it('maps admin user actions to revocations (paths as the admin user app sees them, and full paths)', () => {
		expect(adminUserActionReason('POST', '/usr_x/suspend')).toEqual({ userId: 'usr_x', reason: 'admin_suspended' });
		expect(adminUserActionReason('DELETE', '/usr_x')).toEqual({ userId: 'usr_x', reason: 'admin_deleted' });
		expect(adminUserActionReason('POST', '/admin/users/usr_x/suspend')).toEqual({ userId: 'usr_x', reason: 'admin_suspended' });
		expect(adminUserActionReason('DELETE', '/admin/users/usr_x')).toEqual({ userId: 'usr_x', reason: 'admin_deleted' });
		expect(adminUserActionReason('POST', '/admin/users/usr_x/force-password-reset')).toMatchObject({ reason: 'admin_password_reset' });
		expect(adminUserActionReason('POST', '/admin/users/usr_x/unsuspend')).toBeNull();
		expect(adminUserActionReason('GET', '/admin/users/usr_x')).toBeNull();
		expect(adminUserActionReason('PATCH', '/admin/users/usr_x')).toBeNull();
	});

	it('the admin middleware revokes after a successful action under the production mount (router strips /admin/users)', async () => {
		const { kv, data } = memoryKv();
		const app = new Hono();
		app.use('*', revokeOnAdminUserAction(kv));
		app.post('/:id/suspend', (c) => c.json({ ok: true }));
		app.delete('/:id', (c) => (c.req.param('id') === 'usr_missing' ? c.json({}, 404) : c.json({ ok: true })));
		expect((await app.request('http://auth/usr_s/suspend', { method: 'POST' })).status).toBe(200);
		expect(JSON.parse(data.get('u:usr_s')!).reason).toBe('admin_suspended');
		await app.request('http://auth/usr_d', { method: 'DELETE' });
		expect(JSON.parse(data.get('u:usr_d')!).reason).toBe('admin_deleted');
		await app.request('http://auth/usr_missing', { method: 'DELETE' });
		expect(data.has('u:usr_missing')).toBe(false);
	});
});

describe('issuer storage guard', () => {
	const refreshKey = (token: string) => ['oauth:refresh', 'user:abc', token];
	const record = (authTimeS: number, access = 2_592_000) => ({
		type: 'user',
		properties: { id: 'usr_guard' },
		subject: 'user:abc',
		clientID: 'web',
		authTime: authTimeS * 1000,
		ttl: { access, refresh: 31_536_000 },
	});

	it('refuses and deletes refresh tokens of a revoked sign-in, keeps newer ones', async () => {
		const raw = CloudflarePatchedStorage({ namespace: E.AUTH_STORAGE });
		const { kv } = memoryKv();
		const guarded = guardIssuerStorage(raw, { revocations: kv });
		await Storage.set(raw, refreshKey('old'), record(nowS() - 3600), 3600);
		await revokeUser({ kv }, 'usr_guard', 'sign_out_all');
		await Storage.set(raw, refreshKey('new'), record(nowS() + 5), 3600);

		expect(await Storage.get(guarded, refreshKey('old'))).toBeUndefined();
		expect(await Storage.get(raw, refreshKey('old'))).toBeUndefined();
		expect(await Storage.get(guarded, refreshKey('new'))).toMatchObject({ clientID: 'web' });
	});

	it('caps the access lifetime carried by old refresh tokens and codes, leaves other keys alone', async () => {
		const raw = CloudflarePatchedStorage({ namespace: E.AUTH_STORAGE });
		const guarded = guardIssuerStorage(raw, { accessTtl: 900 });
		await Storage.set(raw, refreshKey('legacy'), record(nowS()), 3600);
		await Storage.set(raw, ['oauth:code', 'c1'], record(nowS()), 600);
		await Storage.set(raw, ['other', 'k'], { ttl: { access: 2_592_000 } }, 600);
		expect(((await Storage.get(guarded, refreshKey('legacy'))) as any).ttl).toEqual({ access: 900, refresh: 31_536_000 });
		expect(((await Storage.get(guarded, ['oauth:code', 'c1'])) as any).ttl.access).toBe(900);
		expect(((await Storage.get(guarded, ['other', 'k'])) as any).ttl.access).toBe(2_592_000);
		// Shorter lifetimes are never raised
		await Storage.set(raw, refreshKey('short'), record(nowS(), 300), 3600);
		expect(((await Storage.get(guarded, refreshKey('short'))) as any).ttl.access).toBe(300);
	});

	it('guards refresh tokens and codes in the D1 atomic store the same way (openauth OA-1/OA-2)', async () => {
		await E.AUTH_DB.prepare('CREATE TABLE IF NOT EXISTS openauth_atomic (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)').run();
		const raw = authStorage(E);
		const { kv } = memoryKv();
		const guarded = guardIssuerStorage(raw, { revocations: kv, accessTtl: 900 });
		const atomic = Storage.atomic(guarded);
		await Storage.atomic(raw).set(refreshKey('d1-old'), record(nowS() - 3600));
		await Storage.atomic(raw).set(['oauth:code', 'd1c'], record(nowS()));
		await revokeUser({ kv }, 'usr_guard', 'sign_out_all');
		await Storage.atomic(raw).set(refreshKey('d1-new'), record(nowS() + 5));

		// A revoked sign-in reads as missing and is deleted from D1
		expect(await atomic.get(refreshKey('d1-old'))).toBeUndefined();
		expect(await Storage.atomic(raw).get(refreshKey('d1-old'))).toBeUndefined();
		// The TTL cap applies, and a compare-and-set against the capped copy still succeeds
		const seen = await atomic.get(refreshKey('d1-new'));
		expect(seen.ttl.access).toBe(900);
		expect(await atomic.replace(refreshKey('d1-new'), seen, { ...seen, timeUsed: 1 })).toBe(true);
		expect((await atomic.get(['oauth:code', 'd1c'])).ttl.access).toBe(900);
	});

	it('AU-4: a revocation only in D1 refuses a refresh token read from the atomic store', async () => {
		await E.AUTH_DB.prepare('CREATE TABLE IF NOT EXISTS openauth_atomic (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)').run();
		await E.AUTH_DB.prepare('DELETE FROM user_revocations').run();
		const raw = authStorage(E);
		const { kv } = memoryKv(); // a location whose KV has not seen the revocation
		const guarded = guardIssuerStorage(raw, { revocations: kv, revocationsDb: E.AUTH_DB, accessTtl: 900 });
		await Storage.atomic(raw).set(refreshKey('au4-old'), record(nowS() - 3600));
		await revokeUser({ db: E.AUTH_DB }, 'usr_guard', 'sign_out_all');
		await Storage.atomic(raw).set(refreshKey('au4-new'), record(nowS() + 5));
		expect(await Storage.atomic(guarded).get(refreshKey('au4-old'))).toBeUndefined();
		expect(await Storage.atomic(raw).get(refreshKey('au4-old'))).toBeUndefined();
		expect(await Storage.atomic(guarded).get(refreshKey('au4-new'))).toMatchObject({ clientID: 'web' });
	});

	it('is the plain storage when nothing is configured', () => {
		const raw = CloudflarePatchedStorage({ namespace: E.AUTH_STORAGE });
		expect(guardIssuerStorage(raw, {})).toBe(raw);
	});
});

describe('AU-4: the refresh path reads revocations from D1', () => {
	const refreshKey = (token: string) => ['oauth:refresh', 'user:au4', token];
	const record = (authTimeS: number) => ({
		type: 'user',
		properties: { id: 'usr_au4' },
		subject: 'user:au4',
		clientID: 'web',
		authTime: authTimeS * 1000,
		ttl: { access: 900, refresh: 31_536_000 },
	});

	beforeEach(async () => {
		await E.AUTH_DB.prepare('DELETE FROM user_revocations').run();
	});

	it("a location whose KV has not seen the revocation yet still refuses the refresh", async () => {
		const raw = CloudflarePatchedStorage({ namespace: E.AUTH_STORAGE });
		const here = memoryKv();
		const elsewhere = memoryKv(); // KV in another location: no entry yet (or a cached miss)
		await Storage.set(raw, refreshKey('stolen'), record(nowS() - 60), 3600);
		await revokeUser({ kv: here.kv, db: E.AUTH_DB }, 'usr_au4', 'password_changed');
		const guardedElsewhere = guardIssuerStorage(raw, { revocations: elsewhere.kv, revocationsDb: E.AUTH_DB });
		expect(await Storage.get(guardedElsewhere, refreshKey('stolen'))).toBeUndefined();
		expect(elsewhere.data.size).toBe(0);
		// The KV contract for the resource servers is still written
		expect(JSON.parse(here.data.get('u:usr_au4')!).reason).toBe('password_changed');
	});

	it('100 concurrent revocations with skewed clocks keep the latest time (one upsert, MAX)', async () => {
		const t = Date.UTC(2026, 10, 9, 12, 0, 0);
		await Promise.all(Array.from({ length: 100 }, (_, i) => revokeUser({ db: E.AUTH_DB }, 'usr_au4', 'sign_out_all', t - i * 1000)));
		const row = await E.AUTH_DB.prepare('SELECT revoked_before FROM user_revocations WHERE user_id = ?').bind('usr_au4').first<{ revoked_before: number }>();
		expect(row!.revoked_before).toBe(t / 1000 + 1);
		// A later write with an earlier clock never shortens it
		await revokeUser({ db: E.AUTH_DB }, 'usr_au4', 'sign_out_all', t - 3_600_000);
		expect((await readRevocationForRefresh({ db: E.AUTH_DB }, 'usr_au4'))!.before).toBe(t / 1000 + 1);
	});

	it('revocations written to KV before D1 had them still count, and the later of the two wins', async () => {
		const { kv } = memoryKv();
		const t = Date.UTC(2026, 10, 9, 12, 0, 0);
		await revokeUser({ kv }, 'usr_au4', 'sign_out_all', t); // old code path: KV only
		expect((await readRevocationForRefresh({ kv, db: E.AUTH_DB }, 'usr_au4'))!.before).toBe(t / 1000 + 1);
		await revokeUser({ db: E.AUTH_DB }, 'usr_au4', 'password_changed', t + 60_000);
		expect(await readRevocationForRefresh({ kv, db: E.AUTH_DB }, 'usr_au4')).toMatchObject({ before: t / 1000 + 61, reason: 'password_changed' });
		expect(await readRevocationForRefresh({ db: E.AUTH_DB }, 'usr_nobody')).toBeNull();
	});
});

describe('revocation through the worker', () => {
	let privateKey: CryptoKey;
	let previousKey: string | null;

	async function call(path: string, init: RequestInit = {}) {
		const ctx = createExecutionContext();
		const res = await worker.fetch(
			new Request(`${ISSUER}${path}`, { ...init, headers: { host: 'localhost:3301', ...(init.headers as Record<string, string>) } }),
			E,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		return res;
	}

	const userToken = (id: string, claims: Record<string, unknown> = {}) =>
		new SignJWT({ mode: 'access', type: 'user', aud: 'web', properties: { id, email: `${id}@example.com` }, jti: crypto.randomUUID(), auth_time: nowS() - 60, ...claims })
			.setProtectedHeader({ alg: 'ES256', kid: 'rev-kid' })
			.setIssuer(ISSUER)
			.setSubject('user:abc')
			.setIssuedAt()
			.setExpirationTime('15m')
			.sign(privateKey);

	const form = (fields: Record<string, string>) => ({
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(fields).toString(),
	});

	beforeAll(async () => {
		await setupDatabase();
		const pair = await generateKeyPair('ES256', { extractable: true });
		privateKey = pair.privateKey as CryptoKey;
		previousKey = await E.AUTH_STORAGE.get(SIGNING_KEY_KV_KEY);
		await E.AUTH_STORAGE.put(
			SIGNING_KEY_KV_KEY,
			JSON.stringify({ id: 'rev-kid', alg: 'ES256', publicKey: await exportSPKI(pair.publicKey), privateKey: '', created: Date.now() }),
		);
		clearJWKSCache();
	});

	afterAll(async () => {
		if (previousKey) await E.AUTH_STORAGE.put(SIGNING_KEY_KV_KEY, previousKey);
		else await E.AUTH_STORAGE.delete(SIGNING_KEY_KV_KEY);
		clearJWKSCache();
	});

	beforeEach(async () => {
		for (const id of ['usr_rev', 'usr_other']) await KV().delete(revocationKey(id));
	});

	it('a refresh grant of a revoked sign-in gets invalid_grant and the token is gone', async () => {
		const raw = CloudflarePatchedStorage({ namespace: E.AUTH_STORAGE });
		const key = ['oauth:refresh', 'user:rev1', 'tok1'];
		await Storage.set(raw, key, { type: 'user', subject: 'user:rev1', clientID: 'web', properties: { id: 'usr_rev' }, authTime: Date.now() - 3600_000, ttl: { access: 900, refresh: 3600 } }, 3600);
		await revokeUser({ kv: KV(), db: E.AUTH_DB }, 'usr_rev', 'sign_out_all');
		const res = await call('/token', form({ grant_type: 'refresh_token', refresh_token: 'user:rev1:tok1', client_id: 'web' }));
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).error).toBe('invalid_grant');
		expect(await Storage.get(raw, key)).toBeUndefined();
	});

	it('POST /account/sign-out-all revokes every sign-in of the caller only', async () => {
		const t = await userToken('usr_rev');
		const res = await call('/account/sign-out-all', { method: 'POST', headers: { Authorization: `Bearer ${t}` } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.signedOut).toBe(true);
		const entry = await readRevocation(KV(), 'usr_rev');
		expect(entry).toMatchObject({ reason: 'sign_out_all', before: body.revokedBefore });
		expect(isRevoked(entry, { authTime: nowS() - 60 })).toBe(true);
		expect(await readRevocation(KV(), 'usr_other')).toBeNull();
		expect((await call('/account/sign-out-all', { method: 'POST' })).status).toBe(401);
		expect((await call('/account/sign-out-all', { method: 'GET', headers: { Authorization: `Bearer ${t}` } })).status).toBe(405);
	});

	it('POST /token/revoke accepts an access token (200) without listing it: it expires within ACCESS_TOKEN_TTL', async () => {
		const t = await userToken('usr_rev');
		expect((await call('/token/revoke', form({ token: t }))).status).toBe(200);
		expect(await readRevocation(KV(), 'usr_rev')).toBeNull();
	});

	it('POST /token/revoke deletes a refresh token, but only for the client it was issued to', async () => {
		// Refresh tokens live in D1 (openauth OA-2); one stored in KV by an older
		// version is moved to D1 when first read, and revocable the same way
		const storage = authStorage(E);
		const record = { subject: 'user:rev2', clientID: 'web', properties: { id: 'usr_rev' }, ttl: { access: 900, refresh: 3600 } };
		const d1Key = ['oauth:refresh', 'user:rev2', 'tok2'];
		const kvKey = ['oauth:refresh', 'user:rev2', 'legacy'];
		await Storage.atomic(storage).set(d1Key, record);
		await Storage.set(CloudflarePatchedStorage({ namespace: E.AUTH_STORAGE }), kvKey, record, 3600);
		for (const [token, key] of [['user:rev2:tok2', d1Key], ['user:rev2:legacy', kvKey]] as const) {
			expect((await call('/token/revoke', form({ token, client_id: 'other' }))).status).toBe(200);
			expect(await loadRefreshToken(storage, [...key])).toBeDefined();
			expect((await call('/token/revoke', form({ token, client_id: 'web' }))).status).toBe(200);
			expect(await loadRefreshToken(storage, [...key])).toBeUndefined();
			expect(await Storage.get(storage, [...key])).toBeUndefined();
		}
		expect((await call('/token/revoke', form({ token: 'user:nope:nope' }))).status).toBe(200);
		expect((await call('/token/revoke', form({}))).status).toBe(400);
	});

	it('a password change revokes every account with that email', async () => {
		const ts = Date.now();
		await E.AUTH_DB.prepare(
			`INSERT OR REPLACE INTO users (id, tenant_id, email, name, status, created_at, updated_at) VALUES ('usr_rev', 'default', 'Rev@Example.com', 'r', 'active', ?, ?)`,
		)
			.bind(ts, ts)
			.run();
		await signInBrowser('bs_rev', 'usr_rev');
		await signInBrowser('bs_other', 'usr_keep');
		expect(await revokeOnPasswordChange(E.AUTH_DB, KV(), 'rev@example.com')).toBe(1);
		expect((await readRevocation(KV(), 'usr_rev'))!.reason).toBe('password_changed');
		// No browser can sign the account in again silently; other users keep theirs
		expect(await accountSessions('usr_rev')).toBe(0);
		expect(await activeUser('bs_rev')).toBeNull();
		expect(await accountSessions('usr_keep')).toBe(1);
		expect(await activeUser('bs_other')).toBe('usr_keep');
		expect(await revokeOnPasswordChange(E.AUTH_DB, KV(), 'nobody@example.com')).toBe(0);
	});

	it('an admin suspend, delete or forced reset also ends the browser sign-ins', async () => {
		await signInBrowser('bs_adm', 'usr_adm');
		const { kv, data } = memoryKv();
		const app = new Hono();
		app.use('*', revokeOnAdminUserAction(kv, E.AUTH_DB));
		app.post('/:id/force-password-reset', (c) => c.json({ ok: true }));
		expect((await app.request('http://auth/usr_adm/force-password-reset', { method: 'POST' })).status).toBe(200);
		expect(JSON.parse(data.get('u:usr_adm')!).reason).toBe('admin_password_reset');
		expect(await accountSessions('usr_adm')).toBe(0);
		expect(await activeUser('bs_adm')).toBeNull();
		expect(await endBrowserSignIns(undefined, 'usr_adm')).toBe(0);
	});
});
