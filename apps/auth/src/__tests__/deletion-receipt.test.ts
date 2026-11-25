/**
 * POST /account/deletion-receipt and GET /account/status through the auth worker: an app that lost
 * the answer of a deletion learns what became of it, with a receipt that opens nothing else.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT, exportSPKI, generateKeyPair } from 'jose';
import worker from '../index';
import { setupDatabase } from '../test-setup';
import { SIGNING_KEY_KV_KEY, clearJWKSCache } from '../utils/jwks-cache';
import { REAUTH_MAX_AGE_SECONDS } from '../routes/account-routes';
import { RECEIPT_TTL_SECONDS, readReceipt, signReceipt } from '../routes/deletion-receipt';

const ISSUER = 'http://localhost:3301';
const E = env as unknown as Env;
let privateKey: CryptoKey;
let previousKey: string | null;

const now = () => Math.floor(Date.now() / 1000);

async function token(id: string, claims: Record<string, unknown> = {}, expires: number | string = '5m') {
	return new SignJWT({ mode: 'access', type: 'user', aud: 'viewer-mobile', properties: { id, email: `${id}@example.com`, roles: [] }, auth_time: now() - 60, ...claims })
		.setProtectedHeader({ alg: 'ES256', kid: 'receipt-kid' })
		.setIssuer(ISSUER)
		.setSubject('user:abc')
		.setIssuedAt()
		.setExpirationTime(expires)
		.sign(privateKey);
}

async function call(path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(`${ISSUER}${path}`, { ...init, headers: { host: 'localhost:3301', ...(init.headers as Record<string, string>) } }),
		{ ...E, ...overrides } as Env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return res;
}

const ask = async (t: string, overrides: Partial<Env> = {}) => call('/account/deletion-receipt', { method: 'POST', headers: { Authorization: `Bearer ${t}` } }, overrides);
const status = (receipt: string, overrides: Partial<Env> = {}) => call('/account/status', { headers: { Authorization: `Deletion-Receipt ${receipt}` } }, overrides);
const receiptOf = async (id: string) => ((await (await ask(await token(id))).json()) as { receipt: string }).receipt;
const del = async (id: string) => call('/account', { method: 'DELETE', headers: { Authorization: `Bearer ${await token(id)}` } });

async function seedUser(id: string) {
	const ts = Date.now();
	await E.AUTH_DB.prepare(`INSERT OR REPLACE INTO users (id, tenant_id, email, name, status, created_at, updated_at) VALUES (?, 'default', ?, ?, 'active', ?, ?)`)
		.bind(id, `${id}@example.com`, id, ts, ts)
		.run();
}

const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const payloadOf = (receipt: string) => JSON.parse(atob(receipt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;

/** Signs any claims the way signReceipt does, to test what readReceipt refuses besides the signature. */
async function forge(claims: Record<string, unknown>, version = 'adr1') {
	const secret = await crypto.subtle.importKey('raw', new TextEncoder().encode(E.SESSION_SECRET || '0'.repeat(64)), 'HKDF', false, ['deriveKey']);
	const key = await crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('al-ummah-now/auth/deletion-receipt/v1') },
		secret,
		{ name: 'HMAC', hash: 'SHA-256', length: 256 },
		false,
		['sign'],
	);
	const body = `${version}.${b64(JSON.stringify(claims))}`;
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
	return `${body}.${b64(String.fromCharCode(...new Uint8Array(sig)))}`;
}
const good = (over: Record<string, unknown> = {}) => ({ typ: 'deletion-status', aud: ISSUER, sub: 'usr_alice', jti: 'j', iat: now(), exp: now() + 60, ...over });

describe('the receipt of an account deletion (worker)', () => {
	beforeAll(async () => {
		await setupDatabase();
		await E.AUTH_DB.prepare(
			"CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), timestamp TEXT NOT NULL, event_type TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'info', user_id TEXT, ip_address TEXT, user_agent TEXT, request_id TEXT, metadata TEXT, success INTEGER NOT NULL DEFAULT 1, error_message TEXT, tenant_id TEXT NOT NULL DEFAULT 'default', FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE);",
		).run();
		const pair = await generateKeyPair('ES256', { extractable: true });
		privateKey = pair.privateKey as CryptoKey;
		previousKey = await E.AUTH_STORAGE.get(SIGNING_KEY_KV_KEY);
		await E.AUTH_STORAGE.put(SIGNING_KEY_KV_KEY, JSON.stringify({ id: 'receipt-kid', alg: 'ES256', publicKey: await exportSPKI(pair.publicKey), privateKey: '', created: Date.now() }));
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

	it('says whether the account is deleted, before and after, and nothing else', async () => {
		const receipt = await receiptOf('usr_alice');
		expect(await (await status(receipt)).json()).toEqual({ deleted: false });
		expect((await del('usr_alice')).status).toBe(200);
		expect(await (await status(receipt)).json()).toEqual({ deleted: true });
		expect(await (await status(await receiptOf('usr_bob'))).json()).toEqual({ deleted: false });
	});

	it('is made for 30 days, each one its own, and names its purpose', async () => {
		const res = await ask(await token('usr_alice'));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { receipt: string; expiresAt: number };
		expect(Object.keys(body).sort()).toEqual(['expiresAt', 'receipt']);
		expect(Math.abs(body.expiresAt - (Date.now() + RECEIPT_TTL_SECONDS * 1000))).toBeLessThan(10_000);
		const claims = payloadOf(body.receipt);
		expect(claims).toMatchObject({ typ: 'deletion-status', aud: ISSUER, sub: 'usr_alice' });
		expect(claims.jti).not.toBe(payloadOf(await receiptOf('usr_alice')).jti);
	});

	it('needs a recent sign-in of a user whose account exists', async () => {
		const old = await ask(await token('usr_alice', { auth_time: now() - REAUTH_MAX_AGE_SECONDS - 60 }));
		expect(old.status).toBe(401);
		expect(((await old.json()) as { error: string }).error).toBe('insufficient_user_authentication');
		expect((await ask(await token('usr_alice', { client_id: 'svc' }))).status).toBe(401);
		expect((await ask(await token('usr_alice', {}, now() - 60))).status).toBe(401);
		expect((await call('/account/deletion-receipt', { method: 'POST' })).status).toBe(401);
		expect((await ask(await token('usr_nobody'))).status).toBe(404);
		await del('usr_alice');
		expect((await ask(await token('usr_alice'))).status).toBe(404);
	});

	it('the status takes no access token, live or expired, in either scheme', async () => {
		const live = await token('usr_alice');
		for (const authorization of [`Bearer ${live}`, `Deletion-Receipt ${live}`, `Bearer ${await receiptOf('usr_alice')}`, `Deletion-Receipt ${await token('usr_alice', {}, now() - 60)}`]) {
			const res = await call('/account/status', { headers: { Authorization: authorization } });
			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({ error: 'receipt_invalid' });
		}
		expect((await call('/account/status')).status).toBe(401);
		// Nor a receipt in the address
		expect((await call(`/account/status?receipt=${await receiptOf('usr_alice')}`)).status).toBe(401);
	});

	it('a receipt opens nothing else', async () => {
		const receipt = await receiptOf('usr_bob');
		for (const scheme of ['Bearer', 'Deletion-Receipt']) {
			const headers = { Authorization: `${scheme} ${receipt}` };
			expect((await call('/account', { method: 'DELETE', headers })).status).toBe(401);
			expect((await call('/account/export', { headers })).status).toBe(401);
			expect((await call('/account/deletion-receipt', { method: 'POST', headers })).status).toBe(401);
			expect((await call('/account/sign-out-all', { method: 'POST', headers })).status).toBe(401);
		}
	});

	it('a tampered receipt, another purpose, audience, version or lifetime is refused', async () => {
		expect((await status(await forge(good()))).status).toBe(200);
		const receipt = await receiptOf('usr_alice');
		const [version, payload, signature] = receipt.split('.') as [string, string, string];
		const other = b64(JSON.stringify({ ...payloadOf(receipt), sub: 'usr_bob' }));
		const refused = [
			`${version}.${other}.${signature}`,
			`${version}.${payload}.${signature.slice(0, -2)}AA`,
			`${version}.${payload}`,
			`${receipt}.x`,
			`${version}.${payload}.`,
			'a.b.c',
			'x'.repeat(5000),
			await forge(good({ typ: 'something-else' })),
			await forge(good({ typ: undefined })),
			await forge(good({ aud: 'https://auth.example.com' })),
			await forge(good({ sub: '' })),
			await forge(good({ exp: now() - 1 })),
			await forge(good({ exp: undefined })),
			await forge(good({ exp: now() + RECEIPT_TTL_SECONDS + 3600 })),
			await forge(good({ iat: now() + 3600, exp: now() + 7200 })),
			await forge(good(), 'adr2'),
		];
		// One answer for all of them: it never says what is wrong with a receipt
		for (const r of refused) {
			const res = await status(r);
			expect(res.status, r.slice(0, 60)).toBe(401);
			expect(await res.json()).toEqual({ error: 'receipt_invalid', error_description: 'A valid deletion receipt is required' });
		}
	});

	it('expires after 30 days', async () => {
		const made = Date.now() - RECEIPT_TTL_SECONDS * 1000;
		expect((await status((await signReceipt(E, 'usr_alice', made - 1000)).receipt)).status).toBe(401);
		expect((await status((await signReceipt(E, 'usr_alice', made + 60_000)).receipt)).status).toBe(200);
	});

	it('is signed with a key of its own: rotating the signing keys changes nothing, another secret does', async () => {
		const receipt = await receiptOf('usr_alice');
		const key = await E.AUTH_STORAGE.get(SIGNING_KEY_KV_KEY);
		await E.AUTH_STORAGE.delete(SIGNING_KEY_KV_KEY);
		clearJWKSCache();
		try {
			expect((await status(receipt)).status).toBe(200);
		} finally {
			await E.AUTH_STORAGE.put(SIGNING_KEY_KV_KEY, key!);
			clearJWKSCache();
		}
		expect(await readReceipt({ ...E, SESSION_SECRET: 'f'.repeat(64) }, receipt)).toBeNull();
	});

	it('an account restored by staff is not deleted; a purged one is; deleted_at counts too', async () => {
		const receipt = await receiptOf('usr_alice');
		await del('usr_alice');
		await E.AUTH_DB.prepare(`UPDATE users SET status = 'active', deleted_at = NULL WHERE id = 'usr_alice'`).run();
		expect(await (await status(receipt)).json()).toEqual({ deleted: false });
		await E.AUTH_DB.prepare(`UPDATE users SET deleted_at = ? WHERE id = 'usr_alice'`).bind(Date.now()).run();
		expect(await (await status(receipt)).json()).toEqual({ deleted: true });
		await E.AUTH_DB.prepare(`UPDATE users SET status = 'suspended', deleted_at = NULL WHERE id = 'usr_alice'`).run();
		expect(await (await status(receipt)).json()).toEqual({ deleted: false });
		// No account under the subject any more
		expect(await (await status((await signReceipt(E, 'usr_purged')).receipt)).json()).toEqual({ deleted: true });
	});

	it('both are rate limited, the status per client address before anything is checked', async () => {
		const keys: string[] = [];
		const ACCOUNT_DELETION_LIMITER = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) } as unknown as RateLimit;
		const asked = await ask(await token('usr_alice'), { ACCOUNT_DELETION_LIMITER });
		expect(asked.status).toBe(429);
		expect(asked.headers.get('retry-after')).toBe('60');
		const answered = await call('/account/status', { headers: { Authorization: 'Deletion-Receipt nonsense', 'CF-Connecting-IP': '203.0.113.7' } }, { ACCOUNT_DELETION_LIMITER });
		expect(answered.status).toBe(429);
		expect(keys).toEqual(['deletion-receipt:usr_alice', 'account-status:203.0.113.7']);
	});

	it('without the secret nothing is made or read', async () => {
		const off = { SESSION_SECRET: undefined, ENVIRONMENT: 'production' } as unknown as Partial<Env>;
		expect((await ask(await token('usr_alice'), off)).status).toBe(503);
		expect((await status(await forge(good()), off)).status).toBe(503);
	});

	it('every /account answer has the security headers and is not cached', async () => {
		const bearer = { Authorization: `Bearer ${await token('usr_alice')}` };
		const answers = await Promise.all([
			status(await receiptOf('usr_alice')),
			status('nonsense'),
			ask(await token('usr_alice')),
			call('/account/status', { method: 'POST' }),
			call('/account/deletion-receipt', { method: 'GET' }),
			call('/account', { method: 'GET' }),
			call('/account', { method: 'DELETE' }),
			call('/account/export', { headers: bearer }),
			call('/account/export'),
			call('/account/name', { method: 'PUT', body: '{}' }),
			call('/account/sign-out-all', { method: 'GET' }),
			call('/account/birth-date'),
		]);
		for (const res of answers) {
			expect(res.headers.get('cache-control'), res.url).toContain('no-store');
			expect(res.headers.get('x-content-type-options')).toBe('nosniff');
			expect(res.headers.get('x-frame-options')).toBe('DENY');
			expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
		}
		expect((await call('/account/status', { method: 'POST' })).status).toBe(405);
		expect((await call('/account/deletion-receipt', { method: 'GET' })).status).toBe(405);
	});
});
