import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationChecksum, pendingOpenauthMigrations } from '../d1-migrate.ts';

const OPENAUTH = join(__dirname, '../../../apps/auth/node_modules/@al-ummah-now/openauth/src/migrations');

describe('d1-migrate', () => {
	it('records the same checksum as `openauth migrate` (value in production _openauth_migrations)', () => {
		expect(migrationChecksum(readFileSync(join(OPENAUTH, '001_schema.sql'), 'utf8'))).toBe('cbe49d1435420877');
	});

	it('lists only unapplied numbered migrations, in order', () => {
		const files = ['003_c.sql', 'README.md', '001_a.sql', '002_b.sql', 'x.sql'];
		expect(pendingOpenauthMigrations(files, new Set(['001_a.sql']))).toEqual(['002_b.sql', '003_c.sql']);
		expect(pendingOpenauthMigrations(files, new Set(['001_a.sql', '002_b.sql', '003_c.sql']))).toEqual([]);
	});
});
