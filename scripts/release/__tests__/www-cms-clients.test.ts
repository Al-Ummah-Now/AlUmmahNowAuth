/**
 * 0011_www_cms_clients: the www site and the CMS are registered in each auth DB
 * with the exact redirect URIs their Workers send (the registry matches the full
 * string). Applies the real migration chain to in-memory SQLite, like the schema
 * snapshot does, and reads the rows back.
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { listMigrations } from '../d1-schema.ts';
import { SNAPSHOTS } from '../schema-snapshot.ts';

const ROOT = resolve(__dirname, '../../..');

function clientsAfterMigrations(snapshotFile: string): Map<string, { name: string; redirect_uris: string[]; metadata: string; secret: string | null; grants: string[] }> {
	const entry = SNAPSHOTS.find((s) => s.file === snapshotFile)!;
	const db = new DatabaseSync(':memory:');
	try {
		for (const source of entry.sources) {
			for (const file of listMigrations({ ...source, dir: resolve(ROOT, source.dir) })) db.exec(readFileSync(file, 'utf8'));
		}
		const rows = db.prepare('SELECT id, name, redirect_uris, metadata, client_secret_hash, grant_types FROM oauth_clients').all() as {
			id: string;
			name: string;
			redirect_uris: string;
			metadata: string;
			client_secret_hash: string | null;
			grant_types: string;
		}[];
		return new Map(
			rows.map((r) => [
				r.id,
				{ name: r.name, redirect_uris: JSON.parse(r.redirect_uris), metadata: r.metadata, secret: r.client_secret_hash, grants: JSON.parse(r.grant_types) },
			])
		);
	} finally {
		db.close();
	}
}

const CASES = [
	{
		env: 'production (and stage, rewritten by scripts/stage/seed.ts)',
		snapshot: 'apps/auth/schema.snapshot.sql',
		www: { id: 'd34701ed-03de-43f8-95a8-91cd1e1874bb', uri: 'https://www.alummahnow.net/auth/callback' },
		cms: { id: 'd06fd65a-5b79-45bc-8bfd-a856b8502330', uri: 'https://cms.alummahnow.net/sso/callback' },
	},
	{
		env: 'qa',
		snapshot: 'apps/auth/schema.qa.snapshot.sql',
		www: { id: 'ecda6f18-89cb-415c-b746-7e77184d75a2', uri: 'https://www.qa.alummahnow.net/auth/callback' },
		cms: { id: '0e613f49-674b-490a-93e5-97a35d586da1', uri: 'https://cms.qa.alummahnow.net/sso/callback' },
	},
];

describe.each(CASES)('www and cms clients: $env', ({ snapshot, www, cms }) => {
	const clients = clientsAfterMigrations(snapshot);

	it('registers www as a public PKCE client with its exact callback', () => {
		const c = clients.get(www.id);
		expect(c?.name).toBe('Al Ummah Now (www)');
		expect(c?.redirect_uris).toEqual(['http://localhost:4321/auth/callback', www.uri]);
		expect(JSON.parse(c!.metadata)).toEqual({ type: 'public' });
		expect(c?.secret).toBeNull();
		expect(c?.grants).not.toContain('client_credentials');
	});

	it('registers cms as a public PKCE client with its exact callback', () => {
		const c = clients.get(cms.id);
		expect(c?.name).toBe('CMS');
		expect(c?.redirect_uris).toEqual(['http://localhost:8585/sso/callback', cms.uri]);
		expect(JSON.parse(c!.metadata)).toEqual({ type: 'public' });
		expect(c?.secret).toBeNull();
		expect(c?.grants).not.toContain('client_credentials');
	});
});
