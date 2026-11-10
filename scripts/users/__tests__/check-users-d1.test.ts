import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { authStores, collect, compareUsers, parseUserKey, type D1User } from '../check-users-d1.ts';
import type { CfClient } from '../../release/cf-api.ts';

const live = (id: string, email: string, status = 'active'): D1User => ({ id, tenant_id: 'default', email, status, deleted_at: null });

describe('parseUserKey', () => {
	it('reads user records and email entries with either separator', () => {
		expect(parseUserKey('user::default::usr_1')).toEqual({ kind: 'user', tenant: 'default', id: 'usr_1' });
		expect(parseUserKey('user\x1fdefault\x1fusr_2')).toEqual({ kind: 'user', tenant: 'default', id: 'usr_2' });
		expect(parseUserKey('user::email::default::a@b.com')).toEqual({ kind: 'email', tenant: 'default', email: 'a@b.com' });
		expect(parseUserKey('user::identity::default::google::1')).toEqual({ kind: 'other' });
		expect(parseUserKey('oauth:refresh::x::y')).toEqual({ kind: 'other' });
	});
});

describe('compareUsers', () => {
	it('sorts KV records into in-sync, KV-only, ghosts and drift', () => {
		const d1 = [live('usr_a', 'a@x.com'), live('usr_b', 'b@x.com', 'suspended'), live('usr_owner', 'taken@x.com')];
		const report = compareUsers(
			[
				{ id: 'usr_a', tenant_id: 'default', email: 'A@x.com', status: 'active', deleted_at: null },
				{ id: 'usr_b', tenant_id: 'default', email: 'b@x.com', status: 'active', deleted_at: null },
				{ id: 'usr_old', tenant_id: 'default', email: 'old@x.com', status: 'active', deleted_at: null },
				{ id: 'usr_ghost', tenant_id: 'default', email: 'taken@x.com', status: 'active', deleted_at: null },
			],
			[
				{ tenant: 'default', email: 'a@x.com', userId: 'usr_a' },
				{ tenant: 'default', email: 'taken@x.com', userId: 'usr_ghost' },
			],
			d1
		);
		expect(report.kvOnly).toEqual([{ id: 'usr_old', tenant: 'default', status: 'active' }]);
		expect(report.ghosts).toEqual([{ id: 'usr_ghost', tenant: 'default', ownedBy: 'usr_owner' }]);
		expect(report.drift).toEqual([{ id: 'usr_b', tenant: 'default', fields: ['status'] }]);
		expect(report.staleEmailIndex).toBe(1);
		expect(report).toMatchObject({ kvUserRecords: 4, kvEmailEntries: 2, d1Users: 3 });
	});

	it('a deleted KV-only user is reported as KV-only, not as a ghost', () => {
		const report = compareUsers([{ id: 'usr_x', tenant_id: 'default', email: 'a@x.com', status: 'deleted', deleted_at: 1 }], [], [live('usr_a', 'a@x.com')]);
		expect(report.ghosts).toEqual([]);
		expect(report.kvOnly).toEqual([{ id: 'usr_x', tenant: 'default', status: 'deleted' }]);
	});
});

describe('authStores', () => {
	it('reads the AUTH_STORAGE and AUTH_DB ids of each environment from the wrangler configs', () => {
		const root = resolve(import.meta.dirname, '../../..');
		for (const env of ['production', 'stage', 'qa']) {
			const stores = authStores(env, root);
			expect(stores.kv).toMatch(/^[0-9a-f]{32}$/);
			expect(stores.db).toMatch(/^[0-9a-f-]{36}$/);
		}
		expect(authStores('qa', root)).not.toEqual(authStores('production', root));
	});
});

describe('collect', () => {
	it('pages through KV keys and only reads', async () => {
		const kv: Record<string, unknown> = {
			'user::default::usr_a': { id: 'usr_a', email: 'a@x.com', status: 'active', deleted_at: null },
			'user::default::usr_old': { id: 'usr_old', email: 'old@x.com', status: 'active', deleted_at: null },
			'user::email::default::a@x.com': { userId: 'usr_a' },
		};
		const calls: string[] = [];
		const cf: CfClient = {
			accountId: 'acct',
			async request<T>(method: string, path: string, body?: unknown) {
				calls.push(`${method} ${path}`);
				expect((body as { sql: string }).sql).toMatch(/^SELECT /);
				return [{ results: [live('usr_a', 'a@x.com')] }] as T;
			},
			async fetchRaw(method: string, path: string) {
				calls.push(`${method} ${path}`);
				const url = new URL(`https://x${path}`);
				if (url.pathname.endsWith('/keys')) {
					const prefix = url.searchParams.get('prefix') ?? '';
					const names = Object.keys(kv).filter((k) => k.startsWith(prefix));
					// Two pages: the cursor must be followed
					const page = url.searchParams.get('cursor') ? names.slice(1) : names.slice(0, 1);
					const cursor = !url.searchParams.get('cursor') && names.length > 1 ? 'next' : '';
					return Response.json({ success: true, result: page.map((name) => ({ name })), result_info: { cursor } });
				}
				const key = decodeURIComponent(url.pathname.split('/values/')[1]);
				return key in kv ? new Response(JSON.stringify(kv[key])) : new Response('', { status: 404 });
			},
		};
		const report = await collect(cf, { kv: 'ns', db: 'db' });
		expect(report.kvUserRecords).toBe(2);
		expect(report.kvOnly.map((u) => u.id)).toEqual(['usr_old']);
		expect(report.staleEmailIndex).toBe(0);
		expect(calls.every((c) => c.startsWith('GET ') || c.startsWith('POST /d1/database/db/query'))).toBe(true);
	});
});
