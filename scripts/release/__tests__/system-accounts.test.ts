/**
 * System accounts never hold a role (apps/auth/src/security/system-accounts.ts).
 *
 * Builds each deployed D1 schema the way deploys do (openauth `migrate --withSeed`,
 * then every Auth migration in order) in node:sqlite and fails if any system
 * account (user_system, or metadata.type "system") holds a role row. Also proves
 * migration 0041 removes the Super Admin grant that openauth seeds before
 * 1.0.52 gave user_system, and that its triggers refuse any later grant.
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { listMigrations } from '../d1-schema.ts';
import { SNAPSHOTS } from '../schema-snapshot.ts';

const ROOT = resolve(__dirname, '../../..');

const SYSTEM_ROLE_ROWS = `
	SELECT ur.user_id, ur.role_id FROM rbac_user_roles ur LEFT JOIN users u ON u.id = ur.user_id
	WHERE ur.user_id = 'user_system' OR (json_valid(u.metadata) AND json_extract(u.metadata, '$.type') = 'system')`;

/** Every migration file of a snapshot, in deploy order. */
function files(snapshot: (typeof SNAPSHOTS)[number]): string[] {
	return snapshot.sources.flatMap((s) => listMigrations({ ...s, dir: join(ROOT, s.dir) }));
}

function apply(db: DatabaseSync, file: string) {
	try {
		db.exec(readFileSync(file, 'utf8'));
	} catch (error) {
		throw new Error(`${basename(file)} failed to apply: ${(error as Error).message}`);
	}
}

describe.each(SNAPSHOTS.map((s) => [s.file, s] as const))('%s', (_name, snapshot) => {
	it('no system account holds a role after every migration', () => {
		const db = new DatabaseSync(':memory:');
		try {
			for (const file of files(snapshot)) apply(db, file);
			expect(db.prepare(`SELECT id FROM users WHERE id = 'user_system'`).all()).toHaveLength(1);
			expect(db.prepare(SYSTEM_ROLE_ROWS).all()).toEqual([]);
		} finally {
			db.close();
		}
	});

	it('0041 removes a Super Admin grant seeded before it, keeps the user and its assigned_by references, and refuses new grants', () => {
		const all = files(snapshot);
		const at = all.findIndex((f) => basename(f) === '0041_system_accounts.sql');
		expect(at).toBeGreaterThan(0);
		const db = new DatabaseSync(':memory:');
		try {
			for (const file of all.slice(0, at)) apply(db, file);
			// What openauth's seed did before 1.0.52, plus an automatic Member grant it labels
			db.exec(`INSERT OR IGNORE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by)
			         VALUES ('user_system', 'role_super_admin', 'default', 0, 'system')`);
			db.exec(`INSERT INTO users (id, tenant_id, email, status, created_at, updated_at) VALUES ('usr_person', 'default', 'p@example.com', 'active', 0, 0)`);
			db.exec(`INSERT INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) VALUES ('usr_person', 'role_member', 'default', 0, 'user_system')`);
			expect(db.prepare(SYSTEM_ROLE_ROWS).all()).not.toEqual([]);

			for (const file of all.slice(at)) apply(db, file);
			expect(db.prepare(SYSTEM_ROLE_ROWS).all()).toEqual([]);
			expect(db.prepare(`SELECT json_extract(metadata, '$.type') AS type FROM users WHERE id = 'user_system'`).get()).toEqual({ type: 'system' });
			expect(db.prepare(`SELECT assigned_by FROM rbac_user_roles WHERE user_id = 'usr_person'`).get()).toEqual({ assigned_by: 'user_system' });
			expect(() =>
				db.exec(`INSERT INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) VALUES ('user_system', 'role_admin', 'default', 0, 'x')`)
			).toThrow(/system_account_role_refused/);
			// Running the migration again (it is idempotent) changes nothing
			apply(db, all[at]);
			expect(db.prepare(SYSTEM_ROLE_ROWS).all()).toEqual([]);
		} finally {
			db.close();
		}
	});
});
