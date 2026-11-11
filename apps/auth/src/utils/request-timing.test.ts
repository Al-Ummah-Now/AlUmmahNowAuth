import { describe, expect, it } from 'vitest';
import { RequestTimer, instrumentEnv, kvLabel, shouldLogTiming, sqlLabel } from './request-timing';

describe('sqlLabel', () => {
	it('names the verb and table, never the values', () => {
		expect(sqlLabel('SELECT id FROM users WHERE lower(email) = ?')).toBe('SELECT users');
		expect(sqlLabel(' INSERT INTO openauth_atomic (key) VALUES (?)')).toBe('INSERT openauth_atomic');
		expect(sqlLabel('UPDATE password_login_attempts SET failures = 0')).toBe('UPDATE password_login_attempts');
		expect(sqlLabel('DELETE FROM account_sessions WHERE id = ?')).toBe('DELETE account_sessions');
		expect(sqlLabel('PRAGMA optimize')).toBe('PRAGMA');
	});
});

describe('kvLabel', () => {
	it('masks emails, ids and token values in keys', () => {
		expect(kvLabel('email::someone@example.com::password')).toBe('email::*::password');
		expect(kvLabel('oauth:refresh::usr_1::abcdef')).toBe('oauth:refresh::*::*');
		expect(kvLabel('signing:key::primary')).toBe('signing:key::*');
		expect(kvLabel('theme')).toBe('theme');
		expect(kvLabel('a'.repeat(40))).toBe('*');
	});
});

describe('RequestTimer', () => {
	it('sums stages and binding calls into Server-Timing and the log summary', async () => {
		const timer = new RequestTimer();
		await timer.stage('guard', async () => 1);
		await timer.stage('onsuccess.roles', async () => 2);
		await timer.op('d1', 'SELECT users', async () => null);
		await timer.op('d1', 'UPDATE users', async () => null);
		const header = timer.serverTiming();
		expect(header).toMatch(/^guard;dur=[\d.]+, onsuccess-roles;dur=[\d.]+, d1;dur=[\d.]+;desc="n=2", total;dur=[\d.]+$/);
		const summary = timer.summary() as { io: { d1: { n: number } }; slowest: { op: string }[] };
		expect(summary.io.d1.n).toBe(2);
		expect(summary.slowest.map((s) => s.op).sort()).toEqual(['d1 SELECT users', 'd1 UPDATE users']);
		expect(Object.keys((timer.summary() as { ops: Record<string, unknown> }).ops)).toEqual(['d1 SELECT users', 'd1 UPDATE users']);
	});

	it('records a stage that throws', async () => {
		const timer = new RequestTimer();
		await expect(timer.stage('issuer', async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
		expect(timer.serverTiming()).toContain('issuer;dur=');
	});

	it('keeps only the slowest calls', async () => {
		const timer = new RequestTimer();
		for (let i = 0; i < 20; i++) await timer.op('kv', `get k${i}`, async () => null);
		expect((timer.summary() as { slowest: unknown[] }).slowest).toHaveLength(8);
	});
});

describe('instrumentEnv', () => {
	it('times D1 statements (also inside batch) and KV calls, and passes other values through', async () => {
		const calls: string[] = [];
		const stmt = (sql: string, args: unknown[] = []) => ({
			sql,
			args,
			bind: (...a: unknown[]) => stmt(sql, a),
			first: async () => {
				calls.push(`first ${sql}`);
				return { ok: 1 };
			},
			run: async () => ({ meta: { changes: 1 } }),
			all: async () => ({ results: [] }),
			raw: async () => [],
		});
		const db = {
			prepare: (sql: string) => stmt(sql),
			batch: async (stmts: { sql: string }[]) => {
				calls.push(`batch ${stmts.map((s) => s.sql).join('|')}`);
				return [];
			},
			exec: async () => ({}),
			dump: async () => new ArrayBuffer(0),
		};
		const kv = {
			get: async (key: string) => {
				calls.push(`kv ${key}`);
				return 'v';
			},
			put: async () => undefined,
			delete: async () => undefined,
			list: async () => ({ keys: [], list_complete: true }),
			getWithMetadata: async () => ({ value: null, metadata: null }),
		};
		const timer = new RequestTimer();
		const env = instrumentEnv({ AUTH_DB: db, AUTH_STORAGE: kv, SECRET: 's', ENVIRONMENT: 'qa' } as unknown as Record<string, unknown>, timer) as {
			AUTH_DB: D1Database;
			AUTH_STORAGE: KVNamespace;
			SECRET: string;
		};
		expect(env.SECRET).toBe('s');
		// A Secrets Store binding is an RPC stub (every property is a function): never wrapped
		const stub = new Proxy({}, { get: (_t, p) => (p === 'get' ? async () => 'stub-secret' : () => undefined) });
		const withStub = instrumentEnv({ E2E_CODE_SINK_SECRET: stub } as Record<string, unknown>, timer) as { E2E_CODE_SINK_SECRET: { get: () => Promise<string> } };
		expect(withStub.E2E_CODE_SINK_SECRET).toBe(stub);
		expect(await withStub.E2E_CODE_SINK_SECRET.get()).toBe('stub-secret');
		// Non-enumerable properties are reachable too
		const raw = { AUTH_DB: db } as Record<string, unknown>;
		Object.defineProperty(raw, 'STORE_SECRET', { value: { get: async () => 'hidden' }, enumerable: false });
		const hidden = instrumentEnv(raw, timer) as { STORE_SECRET: { get: () => Promise<string> } };
		expect(await hidden.STORE_SECRET.get()).toBe('hidden');
		expect(await env.AUTH_DB.prepare('SELECT 1 FROM users WHERE id = ?').bind('u').first()).toEqual({ ok: 1 });
		const s = env.AUTH_DB.prepare('DELETE FROM users WHERE id = ?').bind('u');
		await env.AUTH_DB.batch([s]);
		expect(await env.AUTH_STORAGE.get('email::x@y::password')).toBe('v');
		// batch got the real statements, not the timing wrappers
		expect(calls).toEqual(['first SELECT 1 FROM users WHERE id = ?', 'batch DELETE FROM users WHERE id = ?', 'kv email::x@y::password']);
		const summary = timer.summary() as { io: Record<string, { n: number }>; slowest: { op: string }[] };
		expect(summary.io.d1.n).toBe(2);
		expect(summary.io.kv.n).toBe(1);
		expect(summary.slowest.map((o) => o.op)).toContain('kv get email::*::password');
		expect(JSON.stringify(summary)).not.toContain('x@y');
	});
});

describe('shouldLogTiming', () => {
	it('logs every sign-in chain request and other requests only when slow', () => {
		expect(shouldLogTiming('/password/authorize', 5)).toBe(true);
		expect(shouldLogTiming('/token', 5)).toBe(true);
		expect(shouldLogTiming('/authorize', 5)).toBe(true);
		expect(shouldLogTiming('/admin/users', 5)).toBe(false);
		expect(shouldLogTiming('/admin/users', 1500)).toBe(true);
	});
});
