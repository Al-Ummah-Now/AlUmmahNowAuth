/**
 * #437: the token revocation list, the refresh-token gate in front of the
 * issuer, POST /token/revoke and POST /account/sign-out-all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import worker from '../index';
import { setupDatabase } from '../test-setup';
import { clearJWKSCache, SIGNING_KEY_KV_KEY } from '../utils/jwks-cache';
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import {
	MAX_REVOKED_JTIS,
	REVOCATION_TTL_SECONDS,
	isRevoked,
	readRevocation,
	revocationKey,
	revokeAccessToken,
	revokeUser,
	type RevocationEntry,
} from '../revocation/revocation-list';
import { guardIssuerStorage, parseAccessTtl } from '../revocation/token-gate';
import { adminUserActionReason, revokeOnPasswordChange } from '../revocation/lifecycle';

const ISSUER = 'http://localhost:3301';
const E = env as unknown as Env;
const KV = () => E.TOKEN_REVOCATIONS!;
const nowS = () => Math.floor(Date.now() / 1000);

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
		const first = await revokeUser(kv, 'usr_a', 'sign_out_all', t);
		expect(first!.before).toBe(t / 1000 + 1);
		expect(puts[0]).toEqual({ key: 'u:usr_a', ttl: REVOCATION_TTL_SECONDS });
		expect(REVOCATION_TTL_SECONDS).toBeGreaterThan(365 * 86400);
		// A clock behind the first write never moves `before` back
		const second = await revokeUser(kv, 'usr_a', 'password_changed', t - 60_000);
		expect(second!.before).toBe(first!.before);
		expect(second!.reason).toBe('password_changed');
	});

	it('revokeAccessToken lists one jti until it expires and keeps the list bounded', async () => {
		const { kv } = memoryKv();
		const t = Date.UTC(2026, 10, 8, 12, 0, 0);
		expect(await revokeAccessToken(kv, 'usr_a', 'expired', t / 1000 - 1, t)).toBeNull();
		await revokeAccessToken(kv, 'usr_a', 'j1', t / 1000 + 900, t);
		const entry = await readRevocation(kv, 'usr_a');
		expect(entry!.jtis).toEqual({ j1: t / 1000 + 900 });
		expect(entry!.before).toBeUndefined();
		// Expired jtis are pruned on the next write
		await revokeAccessToken(kv, 'usr_a', 'j2', t / 1000 + 2000, t + 1000_000);
		expect(Object.keys((await readRevocation(kv, 'usr_a'))!.jtis!)).toEqual(['j2']);
		for (let i = 0; i < MAX_REVOKED_JTIS + 5; i++) await revokeAccessToken(kv, 'usr_b', `j${i}`, t / 1000 + 900 + i, t);
		expect(Object.keys((await readRevocation(kv, 'usr_b'))!.jtis!)).toHaveLength(MAX_REVOKED_JTIS);
	});

	it('isRevoked: sign-in time decides, iat stands in, listed jtis always lose', () => {
		const entry: RevocationEntry = { v: 1, before: 1000, jtis: { bad: 5000 }, updatedAt: 0 };
		expect(isRevoked(null, { iat: 1 })).toBe(false);
		expect(isRevoked(entry, { authTime: 999, iat: 2000 })).toBe(true); // refreshed after, signed in before
		expect(isRevoked(entry, { authTime: 1000, iat: 1000 })).toBe(false);
		expect(isRevoked(entry, { iat: 999 })).toBe(true);
		expect(isRevoked(entry, { iat: 1001 })).toBe(false);
		expect(isRevoked(entry, {})).toBe(true);
		expect(isRevoked(entry, { authTime: 3000, jti: 'bad' })).toBe(true);
		expect(isRevoked({ v: 1, jtis: { bad: 1 }, updatedAt: 0 }, { authTime: 1, jti: 'ok' })).toBe(false);
	});

	it('does nothing without the KV binding', async () => {
		expect(await revokeUser(undefined, 'usr_a', 'sign_out_all')).toBeNull();
		expect(await readRevocation(undefined, 'usr_a')).toBeNull();
	});

	it('parseAccessTtl accepts whole seconds >= 60 only', () => {
		expect(parseAccessTtl('900')).toBe(900);
		expect(parseAccessTtl(900)).toBe(900);
		for (const bad of [undefined, '', 'abc', '30', '90.5', '-900']) expect(parseAccessTtl(bad)).toBeUndefined();
	});

	it('maps admin user actions to revocations', () => {
		expect(adminUserActionReason('POST', '/admin/users/usr_x/suspend')).toEqual({ userId: 'usr_x', reason: 'admin_suspended' });
		expect(adminUserActionReason('DELETE', '/admin/users/usr_x')).toEqual({ userId: 'usr_x', reason: 'admin_deleted' });
		expect(adminUserActionReason('POST', '/admin/users/usr_x/force-password-reset')).toMatchObject({ reason: 'admin_password_reset' });
		expect(adminUserActionReason('POST', '/admin/users/usr_x/unsuspend')).toBeNull();
		expect(adminUserActionReason('GET', '/admin/users/usr_x')).toBeNull();
		expect(adminUserActionReason('PATCH', '/admin/users/usr_x')).toBeNull();
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
		await revokeUser(kv, 'usr_guard', 'sign_out_all');
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

	it('is the plain storage when nothing is configured', () => {
		const raw = CloudflarePatchedStorage({ namespace: E.AUTH_STORAGE });
		expect(guardIssuerStorage(raw, {})).toBe(raw);
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
		await revokeUser(KV(), 'usr_rev', 'sign_out_all');
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

	it('POST /token/revoke lists a valid access token by jti; forged or foreign tokens change nothing', async () => {
		const jti = crypto.randomUUID();
		const t = await userToken('usr_rev', { jti });
		expect((await call('/token/revoke', form({ token: t }))).status).toBe(200);
		expect((await readRevocation(KV(), 'usr_rev'))!.jtis![jti]).toBeGreaterThan(nowS());

		// Another client presenting the token: 200, nothing written
		const t2 = await userToken('usr_other');
		expect((await call('/token/revoke', form({ token: t2, client_id: 'someone-else' }))).status).toBe(200);
		expect(await readRevocation(KV(), 'usr_other')).toBeNull();

		// Signed by another key: 200, nothing written
		const forger = (await generateKeyPair('ES256')).privateKey;
		const forged = await new SignJWT({ mode: 'access', type: 'user', properties: { id: 'usr_other' }, jti: 'x' })
			.setProtectedHeader({ alg: 'ES256', kid: 'rev-kid' })
			.setIssuer(ISSUER)
			.setIssuedAt()
			.setExpirationTime('15m')
			.sign(forger);
		expect((await call('/token/revoke', form({ token: forged }))).status).toBe(200);
		expect(await readRevocation(KV(), 'usr_other')).toBeNull();
	});

	it('POST /token/revoke deletes a refresh token, but only for the client it was issued to', async () => {
		const raw = CloudflarePatchedStorage({ namespace: E.AUTH_STORAGE });
		const key = ['oauth:refresh', 'user:rev2', 'tok2'];
		await Storage.set(raw, key, { subject: 'user:rev2', clientID: 'web', properties: { id: 'usr_rev' } }, 3600);
		expect((await call('/token/revoke', form({ token: 'user:rev2:tok2', client_id: 'other' }))).status).toBe(200);
		expect(await Storage.get(raw, key)).toBeDefined();
		expect((await call('/token/revoke', form({ token: 'user:rev2:tok2', client_id: 'web' }))).status).toBe(200);
		expect(await Storage.get(raw, key)).toBeUndefined();
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
		expect(await revokeOnPasswordChange(E.AUTH_DB, KV(), 'rev@example.com')).toBe(1);
		expect((await readRevocation(KV(), 'usr_rev'))!.reason).toBe('password_changed');
		expect(await revokeOnPasswordChange(E.AUTH_DB, KV(), 'nobody@example.com')).toBe(0);
	});
});
