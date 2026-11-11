/**
 * #804: work a password sign-in does not need before its redirect runs after the
 * response (waitUntil), so a slow KV or D1 write cannot hold the redirect:
 * - the password provider's ["email", <email>, "subject"] KV record
 * - users.last_login_at
 * - giving the brute-force slot back
 * and the purge's refresh-token delete uses its index instead of a scan.
 */
import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { setupDatabase } from '../test-setup';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { authStorage, isSubjectRecord } from '../storage/auth-storage';
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import { guardPasswordRequest } from '../security/password-guard';
import { createOnSuccessHandler, type UserServiceLike } from '../handlers/auth-handlers';
import type { RBACServiceImpl } from '@al-ummah-now/openauth/rbac/index';

const E = env as unknown as Env;
const never = () => new Promise<never>(() => {});

function fakeKV(put: () => Promise<void>) {
	return { put: vi.fn(put), get: vi.fn(async () => null), delete: vi.fn(async () => {}), list: vi.fn() } as unknown as KVNamespace;
}

describe('the subject record write runs after the response', () => {
	it('matches only ["email", <email>, "subject"]', () => {
		expect(isSubjectRecord(['email', 'a@b.c', 'subject'])).toBe(true);
		expect(isSubjectRecord(['email', 'a@b.c', 'password'])).toBe(false);
		expect(isSubjectRecord(['oauth:refresh', 'user:x', 'subject'])).toBe(false);
	});

	it('set() resolves without waiting for the KV put, which goes to waitUntil', async () => {
		const deferred: Promise<unknown>[] = [];
		const kv = fakeKV(never);
		const storage = CloudflarePatchedStorage({ namespace: kv, deferWrite: isSubjectRecord, waitUntil: (p) => void deferred.push(p) });
		await Storage.set(storage, ['email', 'a@b.c', 'subject'], 'user:abc');
		expect(kv.put).toHaveBeenCalledOnce();
		expect(deferred).toHaveLength(1);
	});

	it('every other write is still awaited (the password credential, sessions)', async () => {
		let release!: () => void;
		const kv = fakeKV(() => new Promise<void>((r) => (release = r)));
		const storage = CloudflarePatchedStorage({ namespace: kv, deferWrite: isSubjectRecord, waitUntil: () => {} });
		let done = false;
		const write = Storage.set(storage, ['email', 'a@b.c', 'password'], { hash: 'h' }).then(() => (done = true));
		await Promise.resolve();
		expect(done).toBe(false);
		release();
		await write;
		expect(done).toBe(true);
	});

	it('the deferred write still lands', async () => {
		const deferred: Promise<unknown>[] = [];
		const storage = authStorage(E, { waitUntil: (p) => void deferred.push(p) });
		await Storage.set(storage, ['email', 'deferred@example.com', 'subject'], 'user:1234');
		await Promise.all(deferred);
		expect(await Storage.get(storage, ['email', 'deferred@example.com', 'subject'])).toBe('user:1234');
	});
});

describe('sign-in redirect does not wait for bookkeeping writes', () => {
	it('onSuccess returns before users.last_login_at is written', async () => {
		const deferred: Promise<unknown>[] = [];
		const userService: UserServiceLike = {
			getUserByEmail: vi.fn(async () => ({ id: 'usr_804', email: 'u@example.com', status: 'active' })),
			createUser: vi.fn(),
			updateLastLogin: vi.fn(never),
		};
		const rbac = { getUserRoles: vi.fn(async () => [{ name: 'member' }]) } as unknown as RBACServiceImpl;
		const onSuccess = createOnSuccessHandler(userService, rbac, {
			request: new Request('https://auth.example/password/authorize', { method: 'POST' }),
			env: {},
			ctx: { waitUntil: (p: Promise<unknown>) => void deferred.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext,
			requestId: 'req-804',
		});
		const subject = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://app.example/cb?code=x' } }));
		const res = await onSuccess({ subject }, { provider: 'password', properties: { email: 'u@example.com' }, tenantId: 'default', roles: [] }, { id: 'default' });
		expect(res.status).toBe(302);
		expect(userService.updateLastLogin).toHaveBeenCalledWith('default', 'usr_804');
		expect(deferred.length).toBeGreaterThan(0);
	});

	it('the guard hands the slot release to waitUntil after a successful sign-in', async () => {
		await setupDatabase();
		const deferred: Promise<unknown>[] = [];
		const url = new URL('https://auth.example/password/authorize');
		const request = new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ email: 'slot804@example.com', password: 'x' }).toString(),
		});
		const guard = await guardPasswordRequest(request, { AUTH_DB: E.AUTH_DB }, url, {}, (p) => void deferred.push(p));
		const failures = () =>
			E.AUTH_DB.prepare('SELECT failures FROM password_login_attempts WHERE email = ?').bind('slot804@example.com').first<{ failures: number }>();
		expect((await failures())?.failures).toBe(1);
		const res = await guard.finish(new Response(null, { status: 302 }));
		expect(res.status).toBe(302);
		expect(deferred).toHaveLength(1);
		await Promise.all(deferred);
		expect((await failures())?.failures).toBe(0);
	});
});

describe('purging an account deletes its refresh tokens through the index (migration 0031)', () => {
	it('the user id inside the token value selects the rows', async () => {
		await setupDatabase();
		const put = (key: string, id: string) =>
			E.AUTH_DB.prepare('INSERT OR REPLACE INTO openauth_atomic (key, value, expires_at) VALUES (?, ?, NULL)')
				.bind(key, JSON.stringify({ type: 'user', properties: { id, email: `${id}@example.com`, roles: [] } }))
				.run();
		await put('oauth:refresh::user:t804a::t1', 'usr_gone804');
		await put('oauth:refresh::user:t804a::t2', 'usr_gone804');
		await put('oauth:refresh::user:t804b::t3', 'usr_kept804');
		const sql = `DELETE FROM openauth_atomic WHERE key >= 'oauth:refresh' AND key < 'oauth:refresi' AND json_extract(value, '$.properties.id') = ?`;
		const plan = await E.AUTH_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind('usr_gone804').all<{ detail: string }>();
		expect(plan.results.map((r) => r.detail).join(' ')).toContain('idx_openauth_atomic_refresh_user');
		await E.AUTH_DB.prepare(sql).bind('usr_gone804').run();
		const left = await E.AUTH_DB.prepare("SELECT key FROM openauth_atomic WHERE key LIKE 'oauth:refresh::user:t804%' ORDER BY key").all<{ key: string }>();
		expect(left.results.map((r) => r.key)).toEqual(['oauth:refresh::user:t804b::t3']);
	});

	it('email lookups by lower(email) use idx_users_email_lower', async () => {
		await setupDatabase();
		const plan = await E.AUTH_DB.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM users WHERE lower(email) = ? AND id != ?')
			.bind('a@b.c', 'x')
			.all<{ detail: string }>();
		expect(plan.results.map((r) => r.detail).join(' ')).toContain('idx_users_email_lower');
	});
});
