/**
 * One-command rollback (SPEC §8). Puts each worker back on the version it served
 * before its latest deployment (or on --to <version-id>), then runs the smoke.
 * Code only: database migrations are expand-only and are never undone.
 *
 *   pnpm release:rollback --env production                 # all workers, previous version
 *   pnpm release:rollback --env production --app auth      # one worker
 *   pnpm release:rollback --env production --app auth --to <version-id>
 *   pnpm release:rollback --env production --dry-run       # resolve targets, change nothing
 *
 * The target version is resolved here (not left to wrangler), so a dry run names
 * exactly the version a real rollback would deploy.
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
	dryRun: boolean;
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
	return { env, apps, to, reason: value('--reason') ?? 'manual rollback', dryRun: argv.includes('--dry-run') };
}

interface Deployment {
	created_on: string;
	versions: { version_id: string; percentage: number }[];
}

const mainVersion = (d: Deployment) => [...d.versions].sort((a, b) => b.percentage - a.percentage)[0]?.version_id;

/**
 * From `wrangler deployments list --json`: the version serving now and the one to
 * roll back to, i.e. the main version of the most recent earlier deployment that
 * served something else (a 0% candidate split counts as its 100% side).
 */
export function rollbackTarget(deploymentsJson: string, worker: string, to?: string): { current: string; target: string } {
	const deployments = (JSON.parse(deploymentsJson) as Deployment[]).slice().sort((a, b) => a.created_on.localeCompare(b.created_on));
	const latest = deployments.at(-1);
	if (!latest) throw new Error(`${worker} has no deployments`);
	if (latest.versions.length !== 1) {
		const split = latest.versions.map((v) => `${v.version_id}@${v.percentage}%`).join(', ');
		if (!to) throw new Error(`${worker} is mid-promote (${split}); pick the version with --to`);
	}
	const current = mainVersion(latest)!;
	if (to) return { current, target: to };
	for (let i = deployments.length - 2; i >= 0; i--) {
		const v = mainVersion(deployments[i]);
		if (v && v !== current) return { current, target: v };
	}
	throw new Error(`${worker} has no earlier version to roll back to`);
}

/** Per worker: how to list its deployments, and the wrangler rollback argv for a resolved target version. */
export function rollbackCommands(root: string, args: RollbackArgs): { worker: string; cwd: string; listArgv: string[]; argv: (target: string) => string[] }[] {
	return releaseApps(root, args.env)
		.filter((a) => args.apps.includes(a.app))
		.map((a) => ({
			worker: a.worker,
			cwd: a.cwd,
			listArgv: ['deployments', 'list', '--json', ...a.configArgs],
			argv: (target: string) => ['rollback', target, ...a.configArgs, '-y', '--message', args.reason.slice(0, 100)],
		}));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
	const args = parseRollbackArgs(process.argv.slice(2));
	const root = resolve(new URL('../..', import.meta.url).pathname);
	const wrangler = (cwd: string, argv: string[]) =>
		execFileSync('npx', ['wrangler', ...argv], { cwd, encoding: 'utf8', env: { ...process.env, CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
	let failed = false;
	for (const cmd of rollbackCommands(root, args)) {
		try {
			const { current, target } = rollbackTarget(wrangler(cmd.cwd, cmd.listArgv), cmd.worker, args.to);
			if (args.dryRun) {
				process.stdout.write(`${cmd.worker}: DRY RUN, would roll back ${current} -> ${target} (wrangler ${cmd.argv(target).join(' ')})\n`);
				continue;
			}
			const out = wrangler(cmd.cwd, cmd.argv(target));
			process.stdout.write(`${cmd.worker}: ${current} -> ${target} ${out.trim().split('\n').filter((l) => /success/i.test(l)).join(' ')}\n`);
		} catch (error) {
			failed = true;
			process.stderr.write(`${cmd.worker}: ROLLBACK FAILED: ${(error as { stderr?: string }).stderr ?? (error as Error).message}\n`);
		}
	}
	if (args.dryRun) {
		process.stdout.write(failed ? 'Dry run: some targets could not be resolved.\n' : 'Dry run: no traffic moved.\n');
		process.exit(failed ? 1 : 0);
	}
	// Deployments take a few seconds to propagate before the smoke sees them
	await new Promise((r) => setTimeout(r, 15000));
	const results = await runSmoke({ env: args.env });
	for (const r of results) process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.detail}\n`);
	if (failed || results.some((r) => !r.ok)) process.exit(1);
}
