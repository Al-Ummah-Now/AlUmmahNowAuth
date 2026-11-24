/**
 * Which databases accept http://localhost redirect URIs: QA and a local one, never production or stage
 * (migrations/0051, migrations-qa/0051, apps/auth/scripts/local-redirect-uris.sql). Runs the real
 * migration chains on in-memory SQLite.
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { listMigrations } from '../d1-schema.ts';
import { SNAPSHOTS } from '../schema-snapshot.ts';
import { toStageRedirectUris } from '../../stage/seed.ts';

const ROOT = resolve(__dirname, '../../..');
const PROD = 'apps/auth/schema.snapshot.sql';
const QA = 'apps/auth/schema.qa.snapshot.sql';
const PROFILE = '109a1087-6626-40f7-8a7f-7f42f83f4f30';
const ADMIN = '1448ed27-39a6-417d-b4c8-07f881e81269';
const WEB = 'f0de3c30-0304-4ac4-86d6-1e185dec0439';
const ADMIN_WEB = 'a24e39de-601d-463b-b50d-37a0a94e986b';
const EXAMPLES = ['client_admin_dashboard', 'client_web_app'];
const UNUSED_QA_PROFILE = '209a1087-6626-40f7-8a7f-7f42f83f4f30';

function database(snapshot: string, upTo: (file: string) => boolean = () => true): DatabaseSync {
	const db = new DatabaseSync(':memory:');
	for (const source of SNAPSHOTS.find((s) => s.file === snapshot)!.sources) {
		for (const file of listMigrations({ ...source, dir: resolve(ROOT, source.dir) })) if (upTo(file)) db.exec(readFileSync(file, 'utf8'));
	}
	return db;
}

interface Client { uris: string[]; enabled: number; grants: string[]; native: boolean }

function clients(db: DatabaseSync): Map<string, Client> {
	const rows = db.prepare('SELECT id, redirect_uris, enabled, grant_types, metadata FROM oauth_clients').all() as { id: string; redirect_uris: string; enabled: number; grant_types: string; metadata: string }[];
	return new Map(rows.map((r) => [r.id, { uris: JSON.parse(r.redirect_uris), enabled: r.enabled, grants: JSON.parse(r.grant_types), native: JSON.parse(r.metadata).type === 'native' }]));
}

const run = (db: DatabaseSync, path: string) => db.exec(readFileSync(resolve(ROOT, path), 'utf8'));
const MIGRATION = 'apps/auth/migrations/0051_client_redirect_uris.sql';
const LOCAL = 'apps/auth/scripts/local-redirect-uris.sql';
const httpHosts = (c: Client) => c.uris.filter((u) => u.startsWith('http://')).map((u) => new URL(u).hostname);

describe('http://localhost redirect URIs', () => {
	it('production and stage: no client has one; only native apps have loopback http', () => {
		const all = clients(database(PROD));
		for (const [id, c] of all) {
			expect(c.uris.join(' '), id).not.toMatch(/localhost/i);
			if (c.native) expect(httpHosts(c).every((h) => h === '127.0.0.1'), id).toBe(true);
			else expect(httpHosts(c), id).toEqual([]);
		}
		// What the deployed apps send is still there
		expect(all.get(PROFILE)!.uris).toEqual(['https://profile.auth.alummahnow.net/callback']);
		expect(all.get(ADMIN)!.uris).toEqual(['https://admin.auth.alummahnow.net/auth/callback']);
		expect(all.get(ADMIN_WEB)!.uris).toEqual(['https://admin.alummahnow.net/api/callback']);
		expect(all.get(WEB)!.uris).toEqual([
			'https://videos.alummahnow.net/api/callback',
			'https://videos.alummahnow.net/api/callback?locale=en',
			'https://videos.alummahnow.net/api/callback?locale=ar',
			'https://videos.alummahnow.net/api/callback/multi-account',
		]);
		expect([...all.values()].filter((c) => c.native && httpHosts(c).length > 0).length).toBeGreaterThan(0);
		for (const id of [PROFILE, ADMIN, WEB, ADMIN_WEB]) expect(toStageRedirectUris(all.get(id)!.uris)).toHaveLength(all.get(id)!.uris.length);
	});

	it('covers every client that had one, keeps entries added by hand in order, and changes nothing the second time', () => {
		const db = database(PROD, (f) => !f.includes('0051_'));
		const before = clients(db);
		expect([...before].filter(([, c]) => c.uris.some((u) => u.includes('localhost'))).map(([id]) => id).sort()).toEqual([ADMIN, ADMIN_WEB, PROFILE, WEB, ...EXAMPLES].sort());
		const hand = ['https://account.alummahnow.net/callback', 'HTTP://LOCALHOST:1/x', 'http://localhost', 'http://localhost/y', 'http://localhost?q=1', 'http://Localhost#f', 'https://localhost.alummahnow.net/z', 'http://localhostile.example/c', 'https://profile.auth.alummahnow.net/callback'];
		const kept = ['https://account.alummahnow.net/callback', 'https://localhost.alummahnow.net/z', 'http://localhostile.example/c', 'https://profile.auth.alummahnow.net/callback'];
		const set = (id: string, value: string) => db.prepare('UPDATE oauth_clients SET redirect_uris = ? WHERE id = ?').run(value, id);
		set(PROFILE, JSON.stringify(hand));
		// Not JSON arrays: left as they are
		const others: [string, string][] = [
			[ADMIN_WEB, 'not json, http://localhost:3091/x'],
			[WEB, '"http://localhost:3001/api/callback"'],
			[ADMIN, '{"a":"http://localhost:3303/auth/callback"}'],
			[EXAMPLES[0], '"http://localhost"'],
		];
		for (const [id, value] of others) set(id, value);
		run(db, MIGRATION);
		const list = (id: string) => (db.prepare('SELECT redirect_uris FROM oauth_clients WHERE id = ?').get(id) as { redirect_uris: string }).redirect_uris;
		expect(JSON.parse(list(PROFILE))).toEqual(kept);
		for (const [id, value] of others) expect(list(id)).toBe(value);
		db.prepare('UPDATE oauth_clients SET updated_at = 7').run();
		run(db, MIGRATION);
		expect(JSON.parse(list(PROFILE))).toEqual(kept);
		expect(db.prepare('SELECT count(*) AS n FROM oauth_clients WHERE updated_at <> 7').get()).toEqual({ n: 0 });
		run(db, LOCAL);
		for (const [id, value] of others) expect(list(id)).toBe(value);
	});

	it('a local database gets back exactly what it had, once', () => {
		const before = clients(database(PROD, (f) => !f.includes('0051_')));
		const db = database(PROD);
		run(db, LOCAL);
		run(db, LOCAL);
		const after = clients(db);
		expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
		for (const [id, c] of after) {
			const had = before.get(id)!.uris.filter((u) => !EXAMPLES.includes(id) || !u.includes('localhost'));
			expect([...c.uris].sort(), id).toEqual([...had].sort());
		}
		const scripts = (JSON.parse(readFileSync(resolve(ROOT, 'apps/auth/package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
		for (const [name, command] of Object.entries(scripts)) {
			if (!command.includes('local-redirect-uris')) continue;
			expect(name).toMatch(/^migrations:local/);
			expect(command).not.toContain('--remote');
		}
		expect(scripts['migrations:local']).toContain('d1 execute AUTH_DB --local --file=./scripts/local-redirect-uris.sql');
	});

	it('QA keeps its localhost redirects; a leftover row of the unused profile client is switched off, nothing else', () => {
		const db = database(QA, (f) => !f.includes('0051_'));
		// 0007 replaced the row (same name); as it would be had it been renamed or added again
		expect(clients(db).has(UNUSED_QA_PROFILE)).toBe(false);
		db.prepare(`INSERT INTO oauth_clients (id, tenant_id, name, redirect_uris, enabled, created_at, updated_at) VALUES (?, 'default', 'Auth Profile (old)', '["http://localhost:3302/callback"]', 1, 1, 1)`).run(UNUSED_QA_PROFILE);
		const before = clients(db);
		run(db, 'apps/auth/migrations-qa/0051_disable_unused_profile_client.sql');
		const after = clients(db);
		for (const [id, c] of after) {
			expect(c.uris, id).toEqual(before.get(id)!.uris);
			expect(c.enabled, id).toBe(id === UNUSED_QA_PROFILE ? 0 : before.get(id)!.enabled);
		}
		expect(after.get(PROFILE)!).toMatchObject({ enabled: 1 });
		expect(after.get(PROFILE)!.uris).toContain('http://localhost:3302/callback');
	});
});
