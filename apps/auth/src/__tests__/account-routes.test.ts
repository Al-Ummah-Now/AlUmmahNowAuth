/**
 * Epic 9.7: DELETE /account and GET /account/export through the auth worker.
 * Only the caller's own user token works; deletion needs a recent sign-in
 * (auth_time <= 10 min) and deletes only the caller.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import worker from '../index';
import { setupDatabase } from '../test-setup';
import { clearJWKSCache, SIGNING_KEY_KV_KEY } from '../utils/jwks-cache';
import { REAUTH_MAX_AGE_SECONDS, exceedsAccessTtl, requireRecentSignIn } from '../routes/account-routes';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import { D1SessionAdapter } from '../adapters/session-adapter';

const ISSUER = 'http://localhost:3301';
const EXTRA_TABLES = [
	"CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), timestamp TEXT NOT NULL, event_type TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'info', user_id TEXT, ip_address TEXT, user_agent TEXT, request_id TEXT, metadata TEXT, success INTEGER NOT NULL DEFAULT 1, error_message TEXT, tenant_id TEXT NOT NULL DEFAULT 'default', FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE);",
	"CREATE TABLE IF NOT EXISTS user_identities (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, tenant_id TEXT NOT NULL, provider TEXT NOT NULL, provider_user_id TEXT NOT NULL, provider_data TEXT, created_at INTEGER NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);"
];
const E = env as unknown as Env;
let privateKey: CryptoKey;
let previousKey: string | null;

async function token(claims: Record<string, unknown>, opts: { iss?: string } = {}) {
	return new SignJWT({ mode: 'access', type: 'user', aud: 'viewer-mobile', ...claims })
		.setProtectedHeader({ alg: 'ES256', kid: 'acct-kid' })
		.setIssuer(opts.iss ?? ISSUER)
		.setSubject('user:abc')
		.setIssuedAt()
		.setExpirationTime('5m')
		.sign(privateKey);
}

const now = () => Math.floor(Date.now() / 1000);
const userToken = (id: string, authAgo = 60) => token({ properties: { id, email: `${id}@example.com`, roles: [] }, auth_time: now() - authAgo });

async function call(path: string, init: RequestInit = {}) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`${ISSUER}${path}`, { ...init, headers: { host: 'localhost:3301', ...(init.headers as Record<string, string>) } }), E, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

const del = (t: string) => call('/account', { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } });

async function seedUser(id: string) {
	const ts = Date.now();
	await E.AUTH_DB.prepare(
		`INSERT OR REPLACE INTO users (id, tenant_id, email, name, status, created_at, updated_at) VALUES (?, 'default', ?, ?, 'active', ?, ?)`,
	)
		.bind(id, `${id}@example.com`, id, ts, ts)
		.run();
	await E.AUTH_DB.prepare(
		`INSERT INTO refresh_tokens (token_hash, user_id, client_id, expires_at) VALUES (?, ?, 'viewer-mobile', ?)`,
	)
		.bind(`hash-${id}-${ts}-${Math.random()}`, id, ts + 86_400_000)
		.run();
}

const userRow = (id: string) => E.AUTH_DB.prepare('SELECT status, deleted_at FROM users WHERE id = ?').bind(id).first<{ status: string; deleted_at: number | null }>();
const liveTokens = async (id: string) =>
	(await E.AUTH_DB.prepare('SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ? AND revoked = 0').bind(id).first<{ n: number }>())!.n;

describe('self-service account endpoints (worker)', () => {
	beforeAll(async () => {
		await setupDatabase();
		// Production tables the shared test schema doesn't build (DDL from schema.snapshot.sql)
		for (const ddl of EXTRA_TABLES) await E.AUTH_DB.prepare(ddl).run();
		const pair = await generateKeyPair('ES256', { extractable: true });
		privateKey = pair.privateKey as CryptoKey;
		previousKey = await E.AUTH_STORAGE.get(SIGNING_KEY_KV_KEY);
		await E.AUTH_STORAGE.put(
			SIGNING_KEY_KV_KEY,
			JSON.stringify({ id: 'acct-kid', alg: 'ES256', publicKey: await exportSPKI(pair.publicKey), privateKey: '', created: Date.now() }),
		);
		clearJWKSCache();
	});

	afterAll(async () => {
		if (previousKey) await E.AUTH_STORAGE.put(SIGNING_KEY_KV_KEY, previousKey);
		else await E.AUTH_STORAGE.delete(SIGNING_KEY_KV_KEY);
		clearJWKSCache();
	});

	beforeEach(async () => {
		await seedUser('usr_alice');
		await seedUser('usr_bob');
	});

	it('deletes only the caller, revokes their refresh tokens and removes the password', async () => {
		const kv = CloudflarePatchedStorage({ namespace: E.AUTH_STORAGE });
		await Storage.set(kv, ['email', 'usr_alice@example.com', 'password'], { hash: 'x' });
		await Storage.set(kv, ['email', 'usr_bob@example.com', 'password'], { hash: 'y' });
		const res = await del(await userToken('usr_alice'));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body).toMatchObject({ deleted: true, userId: 'usr_alice' });
		expect((await userRow('usr_alice'))!.status).toBe('deleted');
		expect(await liveTokens('usr_alice')).toBe(0);
		// Someone else is untouched
		expect((await userRow('usr_bob'))!.status).toBe('active');
		expect(await liveTokens('usr_bob')).toBeGreaterThan(0);
		// The deleted account's password no longer exists; others keep theirs
		expect(await Storage.get(kv, ['email', 'usr_alice@example.com', 'password'])).toBeFalsy();
		expect(await Storage.get(kv, ['email', 'usr_bob@example.com', 'password'])).toBeTruthy();
	});

	it("removes the caller's OpenAuth refresh tokens from KV, so the deleted account can't refresh (prod finding)", async () => {
		const kv = CloudflarePatchedStorage({ namespace: E.AUTH_STORAGE });
		await Storage.set(kv, ['oauth:refresh', 'user:abc', 'tok-1'], { subject: 'user:abc' });
		await Storage.set(kv, ['oauth:refresh', 'user:abc', 'tok-2'], { subject: 'user:abc' });
		await Storage.set(kv, ['oauth:refresh', 'user:other', 'tok-3'], { subject: 'user:other' });
		expect((await del(await userToken('usr_alice'))).status).toBe(200);
		expect(await Storage.get(kv, ['oauth:refresh', 'user:abc', 'tok-1'])).toBeFalsy();
		expect(await Storage.get(kv, ['oauth:refresh', 'user:abc', 'tok-2'])).toBeFalsy();
		expect(await Storage.get(kv, ['oauth:refresh', 'user:other', 'tok-3'])).toBeTruthy();
	});

	it('a retry on an already deleted account still removes leftover refresh tokens', async () => {
		const kv = CloudflarePatchedStorage({ namespace: E.AUTH_STORAGE });
		const t = await userToken('usr_alice');
		expect((await del(t)).status).toBe(200);
		// Left over from a deletion made before refresh tokens were removed
		await Storage.set(kv, ['oauth:refresh', 'user:abc', 'tok-late'], { subject: 'user:abc' });
		expect((await del(t)).status).toBe(200);
		expect(await Storage.get(kv, ['oauth:refresh', 'user:abc', 'tok-late'])).toBeFalsy();
	});

	it('a 30-day token from before 15-minute tokens is refused once ACCESS_TOKEN_TTL is set', async () => {
		const legacy = await new SignJWT({ mode: 'access', type: 'user', aud: 'viewer-mobile', properties: { id: 'usr_alice', roles: ['Admin'] }, auth_time: now() - 60 })
			.setProtectedHeader({ alg: 'ES256', kid: 'acct-kid' })
			.setIssuer(ISSUER)
			.setSubject('user:abc')
			.setIssuedAt(now() - 3600)
			.setExpirationTime(now() - 3600 + 30 * 86_400)
			.sign(privateKey);
		const withTtl = { ...E, ACCESS_TOKEN_TTL: '900' } as Env;
		const ctx = createExecutionContext();
		const res = await worker.fetch(
			new Request(`${ISSUER}/account`, { method: 'DELETE', headers: { host: 'localhost:3301', Authorization: `Bearer ${legacy}` } }),
			withTtl,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(401);
		expect((await userRow('usr_alice'))!.status).toBe('active');
		// A 15-minute token passes the lifetime check (then the normal rules apply)
		const ctx2 = createExecutionContext();
		const ok = await worker.fetch(
			new Request(`${ISSUER}/account`, { method: 'DELETE', headers: { host: 'localhost:3301', Authorization: `Bearer ${await userToken('usr_bob')}` } }),
			withTtl,
			ctx2,
		);
		await waitOnExecutionContext(ctx2);
		expect(ok.status).toBe(200);
	});

	it('exceedsAccessTtl: lifetime over the TTL (plus 60 s slack) or no iat/exp', () => {
		expect(exceedsAccessTtl({ iat: 1000, exp: 1900 }, 900)).toBe(false);
		expect(exceedsAccessTtl({ iat: 1000, exp: 1960 }, 900)).toBe(false);
		expect(exceedsAccessTtl({ iat: 1000, exp: 1961 }, 900)).toBe(true);
		expect(exceedsAccessTtl({ iat: 1000, exp: 1000 + 30 * 86_400 }, 900)).toBe(true);
		expect(exceedsAccessTtl({ exp: 1900 }, 900)).toBe(true);
		// No TTL configured (local dev): no cap
		expect(exceedsAccessTtl({ iat: 1000, exp: 1000 + 30 * 86_400 }, undefined)).toBe(false);
	});

	it('requires a recent sign-in: stale or missing auth_time gets the step-up challenge', async () => {
		for (const t of [await userToken('usr_alice', REAUTH_MAX_AGE_SECONDS + 60), await token({ properties: { id: 'usr_alice' } })]) {
			const res = await del(t);
			expect(res.status).toBe(401);
			expect(((await res.json()) as any).error).toBe('insufficient_user_authentication');
			expect(res.headers.get('www-authenticate')).toContain('max_age=600');
		}
		expect((await userRow('usr_alice'))!.status).toBe('active');
	});

	it('rejects M2M tokens, other issuers, bad signatures and missing tokens', async () => {
		const m2m = await token({ client_id: 'svc', scope: 'admin:*', properties: { id: 'usr_alice' }, auth_time: now() });
		const foreign = await token({ properties: { id: 'usr_alice' }, auth_time: now() }, { iss: 'https://evil.example' });
		const tampered = (await userToken('usr_alice')).slice(0, -4) + 'AAAA';
		for (const t of [m2m, foreign, tampered]) expect((await del(t)).status).toBe(401);
		expect((await call('/account', { method: 'DELETE' })).status).toBe(401);
		expect((await userRow('usr_alice'))!.status).toBe('active');
	});

	it('is idempotent and only answers DELETE', async () => {
		const t = await userToken('usr_alice');
		expect((await del(t)).status).toBe(200);
		const again = await del(t);
		expect(again.status).toBe(200);
		expect(((await again.json()) as any).deleted).toBe(true);
		expect((await call('/account', { method: 'POST', headers: { Authorization: `Bearer ${t}` } })).status).toBe(405);
	});

	it('exports the caller\'s auth data as a download, without secrets', async () => {
		const res = await call('/account/export', { headers: { Authorization: `Bearer ${await userToken('usr_bob', 86_400)}` } });
		expect(res.status).toBe(200);
		expect(res.headers.get('content-disposition')).toContain('attachment');
		const body = (await res.json()) as any;
		expect(body.account).toMatchObject({ id: 'usr_bob', email: 'usr_bob@example.com', status: 'active' });
		expect(body.refreshTokens.length).toBeGreaterThan(0);
		expect(JSON.stringify(body)).not.toContain('hash-usr_bob');
		expect(body).toHaveProperty('auditEvents');
	});

	it('export needs the user token too, and a deleted account has nothing to export', async () => {
		expect((await call('/account/export')).status).toBe(401);
		await del(await userToken('usr_alice'));
		const res = await call('/account/export', { headers: { Authorization: `Bearer ${await userToken('usr_alice')}` } });
		expect(res.status).toBe(404);
	});
});

describe('requireRecentSignIn', () => {
	it('allows up to 10 minutes after sign-in', () => {
		const t = 1_800_000_000_000;
		expect(requireRecentSignIn({ userId: 'u', authTime: t / 1000 - 600 }, t)).toBeNull();
		expect(requireRecentSignIn({ userId: 'u', authTime: t / 1000 - 601 }, t)?.status).toBe(401);
		expect(requireRecentSignIn({ userId: 'u' }, t)?.status).toBe(401);
	});
});

describe('D1SessionAdapter.addAccountToSession', () => {
	it('keeps a given sign-in time (silent SSO) instead of now', async () => {
		await setupDatabase();
		const adapter = new D1SessionAdapter(E.AUTH_DB);
		const browser = await adapter.createBrowserSession({ tenantId: 'default', userAgent: 'test', ipAddress: '127.0.0.1' });
		const base = { browserSessionId: browser.id, userId: 'usr_sso', subjectType: 'user', subjectProperties: {}, refreshToken: 'r', clientId: 'c', ttl: 3600 };
		const first = await adapter.addAccountToSession(base);
		const signedInAt = first.authenticated_at - 3_600_000;
		const silent = await adapter.addAccountToSession({ ...base, authenticatedAt: signedInAt });
		expect(silent.authenticated_at).toBe(signedInAt);
		expect((await adapter.getAccountSession(browser.id, 'usr_sso'))!.authenticated_at).toBe(signedInAt);
		// Without it (a real sign-in) the time is now
		const fresh = await adapter.addAccountToSession(base);
		expect(fresh.authenticated_at).toBeGreaterThan(signedInAt);
	});
});
