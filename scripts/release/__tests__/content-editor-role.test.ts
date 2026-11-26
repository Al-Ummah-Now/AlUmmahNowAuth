import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listMigrations } from '../d1-schema.ts';
import { SNAPSHOTS } from '../schema-snapshot.ts';

const ROOT = resolve(__dirname, '../../..');
const MIGRATION = '0056_content_editor_role.sql';

describe.each(SNAPSHOTS.map((snapshot) => [snapshot.file, snapshot.sources] as const))('%s', (_file, sources) => {
	it('seeds Content Editor on a migrated database and safely replays the seed', () => {
		const db = new DatabaseSync(':memory:');
		try {
			const files = sources.flatMap((source) => listMigrations({ ...source, dir: join(ROOT, source.dir) }));
			for (const file of files) db.exec(readFileSync(file, 'utf8'));

			const contentEditor = db.prepare("SELECT * FROM rbac_roles WHERE id = 'role_content_editor'");
			const seeded = contentEditor.all();
			expect(seeded).toEqual([
				expect.objectContaining({ id: 'role_content_editor', name: 'Content Editor', tenant_id: 'default', is_system_role: 0 }),
			]);

			const migration = files.find((file) => basename(file) === MIGRATION);
			expect(migration).toBeDefined();
			db.exec(readFileSync(migration!, 'utf8'));
			expect(contentEditor.all()).toEqual(seeded);
		} finally {
			db.close();
		}
	});
});
