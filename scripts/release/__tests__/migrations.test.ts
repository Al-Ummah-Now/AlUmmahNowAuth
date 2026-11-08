import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSchema } from '../d1-schema.ts';
import { checkMigrations, parseNameStatus } from '../migration-guard.ts';
import { snapshotDiffs } from '../schema-snapshot.ts';

const ROOT = resolve(__dirname, '../../..');
const base = ['apps/auth/migrations/0001_core.sql', 'apps/auth/migrations/0002_tokens.sql', 'apps/auth/src/index.ts'];

describe('migration guard', () => {
	it('allows appending a new migration', () => {
		expect(checkMigrations(parseNameStatus('A\tapps/auth/migrations/0003_add_col.sql'), base)).toEqual([]);
	});

	it('rejects modifying, deleting or renaming an existing migration', () => {
		const changes = parseNameStatus(
			['M\tapps/auth/migrations/0001_core.sql', 'D\tapps/auth/migrations/0002_tokens.sql', 'R100\tapps/auth/migrations/0001_core.sql\tapps/auth/migrations/0001_renamed.sql'].join('\n')
		);
		const errors = checkMigrations(changes, base);
		expect(errors).toHaveLength(3);
		expect(errors[0]).toContain('modified');
		expect(errors[1]).toContain('deleted');
		expect(errors[2]).toContain('renamed');
	});

	it('rejects a new migration that sorts before the latest one', () => {
		const errors = checkMigrations(parseNameStatus('A\tapps/auth/migrations/0001a_late.sql'), base);
		expect(errors[0]).toContain('sorts before');
	});

	it('ignores files outside migrations dirs', () => {
		expect(checkMigrations(parseNameStatus('M\tapps/auth/src/index.ts'), base)).toEqual([]);
	});
});

describe('schema snapshot', () => {
	it('committed snapshots match the migrations', () => {
		expect(snapshotDiffs(ROOT).map((d) => d.file)).toEqual([]);
	});

	it('changes when a migration adds a column', () => {
		const dir = mkdtempSync(join(tmpdir(), 'schema-'));
		mkdirSync(join(dir, 'm'));
		writeFileSync(join(dir, 'm', '0001.sql'), 'CREATE TABLE users (id TEXT PRIMARY KEY);');
		const before = buildSchema([{ label: 'm', dir: join(dir, 'm'), pattern: /\.sql$/ }]);
		writeFileSync(join(dir, 'm', '0002.sql'), 'ALTER TABLE users ADD COLUMN email TEXT;');
		const after = buildSchema([{ label: 'm', dir: join(dir, 'm'), pattern: /\.sql$/ }]);
		expect(after).not.toEqual(before);
		expect(after).toContain('email TEXT');
	});

	it('names the migration that fails to apply', () => {
		const dir = mkdtempSync(join(tmpdir(), 'schema-'));
		writeFileSync(join(dir, '0001.sql'), 'ALTER TABLE missing ADD COLUMN x TEXT;');
		expect(() => buildSchema([{ label: 'm', dir, pattern: /\.sql$/ }])).toThrow('m/0001.sql failed to apply');
	});
});
