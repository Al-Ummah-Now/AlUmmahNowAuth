/**
 * KV cost: refresh tokens left in KV from before D1 held them move to D1 in the
 * hourly cron; once KV has none, refresh-token keys skip KV (no list/get/delete).
 * Unchanged subject records are not rewritten on every password sign-in.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { setupDatabase } from '../test-setup';
import { authStorage } from '../storage/auth-storage';
import { D1AtomicStorage } from '../storage/d1-atomic';
import { ADOPTED_MARKER, adoptLegacyRefreshTokens, resetLegacyRefreshState } from '../storage/legacy-refresh';

const ENV = env as unknown as Env;
const KV = () => ENV.AUTH_STORAGE;
const DB = () => ENV.AUTH_DB;
const YEAR_S = 365 * 24 * 60 * 60;

/** KV with every call counted. */
function countingKv(kv: KVNamespace) {
	const calls = { get: 0, put: 0, delete: 0, list: 0 };
	const wrapped = {
		get: (...a: unknown[]) => (calls.get++, (kv.get as (...x: unknown[]) => unknown)(...a)),
		put: (...a: unknown[]) => (calls.put++, (kv.put as (...x: unknown[]) => unknown)(...a)),
		delete: (...a: unknown[]) => (calls.delete++, (kv.delete as (...x: unknown[]) => unknown)(...a)),
		list: (...a: unknown[]) => (calls.list++, (kv.list as (...x: unknown[]) => unknown)(...a)),
	} as unknown as KVNamespace;
	return { kv: wrapped, calls };
}

async function clearKv() {
	for (const k of (await KV().list()).keys) await KV().delete(k.name);
}

beforeEach(async () => {
	await setupDatabase();
	await DB().prepare('DELETE FROM openauth_atomic').run();
	await clearKv();
	resetLegacyRefreshState();
});

describe('legacy KV refresh tokens', () => {
	it('the cron moves them to D1 with their expiry, then marks KV as done', async () => {
		await KV().put('oauth:refresh::user:a::t1', JSON.stringify({ properties: { id: 'usr_a' } }), { expirationTtl: YEAR_S });
		await KV().put('oauth:refresh::user:b::t2', JSON.stringify({ properties: { id: 'usr_b' } }), { expirationTtl: YEAR_S });
		const atomic = D1AtomicStorage(DB());

		const first = await adoptLegacyRefreshTokens(KV(), atomic, DB());
		expect(first).toEqual({ moved: 2, done: false });
		expect(await atomic.get(['oauth:refresh', 'user:a', 't1'])).toEqual({ properties: { id: 'usr_a' } });
		const row = await DB().prepare(`SELECT expires_at FROM openauth_atomic WHERE key = 'oauth:refresh::user:b::t2'`).first<{ expires_at: number }>();
		expect(row!.expires_at).toBeGreaterThan(Date.now() + (YEAR_S - 60) * 1000);
		expect((await KV().list({ prefix: 'oauth:refresh::' })).keys).toEqual([]);

		expect(await adoptLegacyRefreshTokens(KV(), atomic, DB())).toEqual({ moved: 0, done: true });
		expect(await atomic.get(ADOPTED_MARKER)).toBeTruthy();
	});

	it('a live D1 token with the same key wins over the KV copy', async () => {
		const atomic = D1AtomicStorage(DB());
		await atomic.set(['oauth:refresh', 'user:a', 't1'], { v: 'd1' }, new Date(Date.now() + 60_000));
		await KV().put('oauth:refresh::user:a::t1', JSON.stringify({ v: 'kv' }), { expirationTtl: YEAR_S });
		await adoptLegacyRefreshTokens(KV(), atomic, DB());
		expect(await atomic.get(['oauth:refresh', 'user:a', 't1'])).toEqual({ v: 'd1' });
	});

	it('before the marker, refresh-token keys still read, list and delete KV', async () => {
		await KV().put('oauth:refresh::user:a::t1', JSON.stringify({ v: 1 }));
		const { kv, calls } = countingKv(KV());
		const storage = authStorage({ AUTH_STORAGE: kv, AUTH_DB: DB() });
		expect(await Storage.get(storage, ['oauth:refresh', 'user:a', 't1'])).toEqual({ v: 1 });
		expect((await Array.fromAsync(Storage.scan(storage, ['oauth:refresh', 'user:a']))).length).toBe(1);
		await Storage.remove(storage, ['oauth:refresh', 'user:a', 't1']);
		expect(calls).toMatchObject({ list: 1, delete: 1 });
	});

	it('after the marker, refresh-token keys skip KV; other keys do not', async () => {
		await D1AtomicStorage(DB()).set(ADOPTED_MARKER, { at: 1 });
		const { kv, calls } = countingKv(KV());
		const storage = authStorage({ AUTH_STORAGE: kv, AUTH_DB: DB() });
		expect(await Storage.get(storage, ['oauth:refresh', 'user:a', 't1'])).toBeUndefined();
		expect(await Array.fromAsync(Storage.scan(storage, ['oauth:refresh', 'user:a']))).toEqual([]);
		await Storage.remove(storage, ['oauth:refresh', 'user:a', 't1']);
		expect(calls).toEqual({ get: 0, put: 0, delete: 0, list: 0 });

		await Storage.set(storage, ['email', 'a@example.com', 'password'], 'h');
		expect(await Storage.get(storage, ['email', 'a@example.com', 'password'])).toBe('h');
		expect(calls.put).toBe(1);
	});
});

describe('subject records', () => {
	it('are written once; the same subject again is not rewritten', async () => {
		const { kv, calls } = countingKv(KV());
		const storage = authStorage({ AUTH_STORAGE: kv, AUTH_DB: DB() });
		await Storage.set(storage, ['email', 'a@example.com', 'subject'], 'user:abc');
		await Storage.set(storage, ['email', 'a@example.com', 'subject'], 'user:abc');
		expect(calls.put).toBe(1);
		await Storage.set(storage, ['email', 'a@example.com', 'subject'], 'user:def');
		expect(calls.put).toBe(2);
		expect(await Storage.get(storage, ['email', 'a@example.com', 'subject'])).toBe('user:def');
	});
});
