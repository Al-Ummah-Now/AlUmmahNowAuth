/**
 * One-command rollback (SPEC §8). Puts each worker back on the version it served
 * before its latest deployment (or on --to <version-id>), then runs the smoke.
 * Code only: database migrations are expand-only and are never undone.
 *
 *   pnpm release:rollback --env production                 # all workers, previous version
 *   pnpm release:rollback --env production --app auth      # one worker
 *   pnpm release:rollback --env production --app auth --to <version-id>
 *
 * Also run by .github/workflows/rollback.yml (the one-click version).
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { releaseApps, type ReleaseEnv } from './promote.ts';
import { runSmoke } from './smoke.ts';

export interface RollbackArgs {
	env: ReleaseEnv;
	apps: string[];
	to?: string;
	reason: string;
}

export function parseRollbackArgs(argv: string[]): RollbackArgs {
	const value = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
	const env = value('--env');
	if (env !== 'stage' && env !== 'production') throw new Error('--env stage|production is required');
	const app = value('--app') ?? 'all';
	const apps = app === 'all' ? ['auth', 'profile', 'admin'] : app.split(',');
	for (const a of apps) if (!['auth', 'profile', 'admin'].includes(a)) throw new Error(`unknown --app ${a}`);
	const to = value('--to');
	if (to && apps.length !== 1) throw new Error('--to needs a single --app (version ids are per worker)');
	return { env, apps, to, reason: value('--reason') ?? 'manual rollback' };
}

/** wrangler arguments for each worker; without --to, wrangler picks the previous deployment's version. */
export function rollbackCommands(root: string, args: RollbackArgs): { worker: string; cwd: string; argv: string[] }[] {
	return releaseApps(root, args.env)
		.filter((a) => args.apps.includes(a.app))
		.map((a) => ({
			worker: a.worker,
			cwd: a.cwd,
			argv: ['rollback', ...(args.to ? [args.to] : []), ...a.configArgs, '-y', '--message', args.reason.slice(0, 100)],
		}));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
	const args = parseRollbackArgs(process.argv.slice(2));
	const root = resolve(new URL('../..', import.meta.url).pathname);
	let failed = false;
	for (const cmd of rollbackCommands(root, args)) {
		try {
			const out = execFileSync('npx', ['wrangler', ...cmd.argv], { cwd: cmd.cwd, encoding: 'utf8', env: { ...process.env, CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
			process.stdout.write(`${cmd.worker}: ${out.trim().split('\n').filter((l) => /success|rolled back|version/i.test(l)).join(' ') || 'rolled back'}\n`);
		} catch (error) {
			failed = true;
			process.stderr.write(`${cmd.worker}: ROLLBACK FAILED: ${(error as { stderr?: string }).stderr ?? (error as Error).message}\n`);
		}
	}
	// Deployments take a few seconds to propagate before the smoke sees them
	await new Promise((r) => setTimeout(r, 15000));
	const results = await runSmoke({ env: args.env });
	for (const r of results) process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.detail}\n`);
	if (failed || results.some((r) => !r.ok)) process.exit(1);
}
