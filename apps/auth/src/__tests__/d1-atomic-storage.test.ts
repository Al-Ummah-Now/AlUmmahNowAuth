/**
 * OA-1: the issuer's atomic store on D1 (miniflare's real SQLite D1), and the
 * authorization code made single-use through it while KV is stale.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { object, string } from 'valibot';
import { issuer } from '@al-ummah-now/openauth/issuer';
import { createClient } from '@al-ummah-now/openauth/client';
import { createSubjects } from '@al-ummah-now/openauth/subject';
import type { StorageAdapter } from '@al-ummah-now/openauth/storage/storage';
import prodMigration from '../../migrations/0021_openauth_atomic.sql?raw';
import qaMigration from '../../migrations-qa/0021_openauth_atomic.sql?raw';
import { D1AtomicStorage } from '../storage/d1-atomic';
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import { guardIssuerStorage } from '../revocation/token-gate';
import { TokenCleanupService } from '../services/token-cleanup';
import { setupDatabase } from '../test-setup';

const DB = () => (env as unknown as Env).AUTH_DB;

async function applyMigration(sql: string) {
	await DB().prepare('DROP TABLE IF EXISTS openauth_atomic').run();
	for (const stmt of sql
		.replace(/^\s*--.*$/gm, '')
		.split(';')
		.map((s) => s.trim())
		.filter(Boolean)) {
		await DB().prepare(stmt).run();
	}
}

beforeAll(async () => {
	await setupDatabase();
	expect(qaMigration).toBe(prodMigration);
});
beforeEach(async () => {
	await applyMigration(prodMigration);
});

describe('D1AtomicStorage', () => {
	it('get/set/remove round-trip JSON and honour expiry', async () => {
		const a = D1AtomicStorage(DB());
		await a.set(['k', '1'], { x: 1 });
		expect(await a.get(['k', '1'])).toEqual({ x: 1 });
		await a.set(['k', '2'], { y: 2 }, new Date(Date.now() - 1));
		expect(await a.get(['k', '2'])).toBeUndefined();
		await a.remove(['k', '1']);
		expect(await a.get(['k', '1'])).toBeUndefined();
	});

	it('add creates only when absent, and takes over an expired row', async () => {
		const a = D1AtomicStorage(DB());
		expect(await a.add(['k'], 1)).toBe(true);
		expect(await a.add(['k'], 2)).toBe(false);
		expect(await a.get(['k'])).toBe(1);
		await a.set(['e'], 'old', new Date(Date.now() - 1));
		expect(await a.add(['e'], 'new')).toBe(true);
		expect(await a.get(['e'])).toBe('new');
	});

	it('replace is a compare-and-set on the JSON value', async () => {
		const a = D1AtomicStorage(DB());
		await a.set(['k'], { status: 'pending', n: 1 });
		const seen = await a.get(['k']);
		expect(await a.replace(['k'], seen, { status: 'approved', n: 1 })).toBe(true);
		expect(await a.replace(['k'], seen, { status: 'pending', n: 2 })).toBe(false);
		expect(await a.get(['k'])).toEqual({ status: 'approved', n: 1 });
		expect(await a.replace(['missing'], seen, 1)).toBe(false);
	});

	it('200 parallel add() on one key: exactly one wins', async () => {
		const a = D1AtomicStorage(DB());
		const results = await Promise.all(Array.from({ length: 200 }, (_, i) => a.add(['once'], i)));
		expect(results.filter(Boolean).length).toBe(1);
	});

	it('200 parallel take() of one key: exactly one caller gets the value', async () => {
		const a = D1AtomicStorage(DB());
		await a.set(['code'], { v: 42 });
		const results = await Promise.all(Array.from({ length: 200 }, () => a.take(['code'])));
		expect(results.filter((r) => r !== undefined)).toEqual([{ v: 42 }]);
	});

	it('50 parallel read-replace increments lose no update (retry on conflict)', async () => {
		const a = D1AtomicStorage(DB());
		await a.set(['n'], 0);
		await Promise.all(
			Array.from({ length: 50 }, async () => {
				for (;;) {
					const cur = (await a.get(['n'])) as number;
					if (await a.replace(['n'], cur, cur + 1)) return;
				}
			}),
		);
		expect(await a.get(['n'])).toBe(50);
	}, 30_000);

	it('the cleanup cron deletes expired rows only', async () => {
		const a = D1AtomicStorage(DB());
		await a.set(['live'], 1, new Date(Date.now() + 60_000));
		await a.set(['forever'], 1);
		await a.set(['dead'], 1, new Date(Date.now() - 1));
		const result = await TokenCleanupService.runCleanup(env as unknown as Env);
		expect(result.expiredAtomicDeleted).toBe(1);
		const { results } = await DB().prepare('SELECT key FROM openauth_atomic ORDER BY key').all<{ key: string }>();
		expect(results.map((r) => r.key)).toEqual(['forever', 'live']);
	});
});

// ---------------------------------------------------------------------------
// The issuer on KV that is stale in every "PoP" + the D1 atomic store
// ---------------------------------------------------------------------------

const HOST = 'https://auth.example.com';
const REDIRECT = 'https://client.example.com/callback';
const subjects = createSubjects({ user: object({ userID: string() }) });

/** A KV namespace as one PoP sees it: the first read of a key is cached for good. */
function stalePopKv(global: Map<string, string>): KVNamespace {
	const cache = new Map<string, string | null>();
	const read = (k: string) => {
		if (!cache.has(k)) cache.set(k, global.get(k) ?? null);
		return cache.get(k) ?? null;
	};
	return {
		async get(k: string, type?: string) {
			const v = read(k);
			return v === null ? null : type === 'json' ? JSON.parse(v) : v;
		},
		async put(k: string, v: string) {
			global.set(k, v);
			cache.set(k, v);
		},
		async delete(k: string) {
			global.delete(k);
			cache.set(k, null);
		},
		async list({ prefix }: { prefix?: string } = {}) {
			return { keys: [...global.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
		},
	} as unknown as KVNamespace;
}

function makeIssuer(storage: StorageAdapter) {
	return issuer({
		storage,
		subjects,
		allow: async () => true,
		providers: {
			dummy: {
				type: 'dummy',
				init(route: any, ctx: any) {
					route.get('/authorize', async (c: any) => ctx.success(c, { email: 'a@b.c' }));
				},
			} as any,
		},
		success: async (ctx: any) => ctx.subject('user', { userID: 'u1' }),
	} as any);
}

const pop = (kv: Map<string, string>) =>
	makeIssuer(
		guardIssuerStorage(CloudflarePatchedStorage({ namespace: stalePopKv(kv), atomic: D1AtomicStorage(DB()) }), {
			accessTtl: 900,
		}),
	);

describe('authorization code through D1', () => {
	it('200 exchanges of one code spread over 8 stale PoPs: exactly one succeeds, the rest revoke it', async () => {
		const kv = new Map<string, string>();
		const first = pop(kv);
		const client = createClient({ issuer: HOST, clientID: 'app', fetch: (a, b) => Promise.resolve(first.request(a, b)) });
		const { challenge, url } = await client.authorize(REDIRECT, 'code', { pkce: true });
		let res = await first.request(url);
		res = await first.request(res.headers.get('location')!, { headers: { cookie: res.headers.get('set-cookie')! } });
		const code = new URL(res.headers.get('location')!).searchParams.get('code')!;

		const pops = Array.from({ length: 8 }, () => pop(kv));
		const results = await Promise.all(
			Array.from({ length: 200 }, (_, i) =>
				pops[i % 8].request(`${HOST}/token`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({
						grant_type: 'authorization_code',
						code,
						redirect_uri: REDIRECT,
						client_id: 'app',
						code_verifier: challenge.verifier!,
					}).toString(),
				}),
			),
		);
		const ok = results.filter((r) => r.status === 200);
		expect(ok.length).toBe(1);
		const tokens = (await ok[0].json()) as { refresh_token: string; access_token: string };

		// The code never touched KV; the losers revoked the winner's family
		expect([...kv.keys()].some((k) => k.startsWith('oauth:code'))).toBe(false);
		const refreshed = await pops[3].request(`${HOST}/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).toString(),
		});
		expect(refreshed.status).toBe(400);
	});
});
