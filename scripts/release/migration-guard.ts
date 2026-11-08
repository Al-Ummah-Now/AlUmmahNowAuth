/**
 * Migrations are append-only (SPEC §6.2): a migration that may already have run in
 * some environment must never change, and new migrations must sort after the
 * existing ones (wrangler applies them in name order and skips names it has seen).
 *
 *   node --experimental-strip-types scripts/release/migration-guard.ts <base-ref>
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export const MIGRATION_DIR = /^apps\/[^/]+\/migrations[^/]*\/[^/]+\.sql$/;

export interface Change {
	status: string;
	path: string;
	/** For renames: the old path. */
	from?: string;
}

export function parseNameStatus(output: string): Change[] {
	return output
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [status, a, b] = line.split('\t');
			return status.startsWith('R') || status.startsWith('C') ? { status: status[0], path: b, from: a } : { status: status[0], path: a };
		});
}

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'));
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * @param changes  name-status diff base...head
 * @param baseFiles every migration file path that exists at base
 */
export function checkMigrations(changes: Change[], baseFiles: string[]): string[] {
	const errors: string[] = [];
	const latest = new Map<string, string>();
	for (const f of baseFiles) {
		if (!MIGRATION_DIR.test(f)) continue;
		const d = dirOf(f);
		if (!latest.has(d) || nameOf(f) > latest.get(d)!) latest.set(d, nameOf(f));
	}
	for (const c of changes) {
		const touched = [c.path, c.from].filter((p): p is string => !!p && MIGRATION_DIR.test(p));
		if (touched.length === 0) continue;
		if (c.status === 'M') errors.push(`${c.path}: existing migration modified. Add a new migration instead.`);
		else if (c.status === 'D') errors.push(`${c.path}: existing migration deleted.`);
		else if (c.status === 'R') errors.push(`${c.from} → ${c.path}: existing migration renamed.`);
		else if (c.status === 'A' || c.status === 'C') {
			const last = latest.get(dirOf(c.path));
			if (last && nameOf(c.path) <= last) {
				errors.push(`${c.path}: new migration sorts before the latest existing one (${last}); it may never run where ${last} already ran.`);
			}
		}
	}
	return errors;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
	const base = process.argv[2];
	if (!base) {
		process.stderr.write('usage: migration-guard.ts <base-ref>\n');
		process.exit(2);
	}
	const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' });
	const mergeBase = git('merge-base', base, 'HEAD').trim();
	const changes = parseNameStatus(git('diff', '--name-status', '-M', `${mergeBase}`, 'HEAD'));
	const baseFiles = git('ls-tree', '-r', '--name-only', mergeBase).split('\n');
	const errors = checkMigrations(changes, baseFiles);
	if (errors.length) {
		process.stderr.write(`Migration guard failed:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
		process.exit(1);
	}
	process.stdout.write(`Migration guard passed (base ${mergeBase.slice(0, 7)}).\n`);
}
