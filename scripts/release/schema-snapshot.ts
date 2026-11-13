/**
 * Writes or checks the committed D1 schema snapshots.
 *   node --experimental-strip-types scripts/release/schema-snapshot.ts --check
 *   node --experimental-strip-types scripts/release/schema-snapshot.ts --write
 *
 * Snapshots live next to (not inside) the migrations dirs: wrangler applies every
 * .sql file in a migrations dir.
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildSchema, type MigrationSource } from './d1-schema.ts';

const OPENAUTH_MIGRATIONS = 'apps/auth/node_modules/@al-ummah-now/openauth/src/migrations';

/** Deploy order: `openauth migrate --withSeed`, then `wrangler d1 migrations apply`. */
export const SNAPSHOTS: { file: string; sources: MigrationSource[] }[] = [
	{
		file: 'apps/auth/schema.snapshot.sql',
		sources: [
			{ label: 'openauth', dir: OPENAUTH_MIGRATIONS, pattern: /^\d{3}_.*\.sql$/ },
			{ label: 'migrations', dir: 'apps/auth/migrations', pattern: /\.sql$/ },
		],
	},
	{
		file: 'apps/auth/schema.qa.snapshot.sql',
		sources: [
			{ label: 'openauth', dir: OPENAUTH_MIGRATIONS, pattern: /^\d{3}_.*\.sql$/ },
			{ label: 'migrations-qa', dir: 'apps/auth/migrations-qa', pattern: /\.sql$/ },
		],
	},
];

export function snapshotDiffs(root: string): { file: string; expected: string; actual: string | null }[] {
	const out = [];
	for (const snap of SNAPSHOTS) {
		const expected = buildSchema(snap.sources.map((s) => ({ ...s, dir: join(root, s.dir) })));
		const path = join(root, snap.file);
		const actual = existsSync(path) ? readFileSync(path, 'utf8') : null;
		if (actual !== expected) out.push({ file: snap.file, expected, actual });
	}
	return out;
}

// fileURLToPath: a checkout path with a space is %20 in the URL's pathname, and the script then did nothing
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	const root = process.cwd();
	const write = process.argv.includes('--write');
	const diffs = snapshotDiffs(root);
	if (write) {
		for (const d of diffs) writeFileSync(join(root, d.file), d.expected);
		process.stdout.write(diffs.length ? `Updated ${diffs.map((d) => d.file).join(', ')}\n` : 'Schema snapshots already up to date.\n');
	} else if (diffs.length) {
		process.stderr.write(
			`Schema snapshot out of date: ${diffs.map((d) => d.file).join(', ')}\n` +
				'A migration changed the schema (or a snapshot was edited by hand).\n' +
				'Run `pnpm schema:snapshot` and commit the result together with the migration.\n'
		);
		process.exit(1);
	} else {
		process.stdout.write('Schema snapshots up to date.\n');
	}
}
