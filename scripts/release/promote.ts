/**
 * Stage-then-promote for production (SPEC §7): upload the already-built bundles as
 * new versions, give them 0% traffic, smoke-test them through the version-override
 * header, then move 100% of traffic, smoke again, and roll back automatically if
 * anything fails.
 *
 *   node --experimental-strip-types scripts/release/promote.ts --env production
 *   node --experimental-strip-types scripts/release/promote.ts --env stage      # rehearsal
 *
 * Expects the build job's output: dist/auth/index.js, dist/profile/index.js and
 * apps/admin/build/server (with wrangler.stage.json derived for stage).
 * Writes the result (previous and new version per worker) to release-result.json,
 * which the rollback workflow can use.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runSmoke, type CheckResult, type SmokeEnv, HOSTS } from './smoke.ts';

export type ReleaseEnv = 'stage' | 'production';

export interface ReleaseApp {
	app: 'auth' | 'profile' | 'admin';
	worker: string;
	/** Directory wrangler runs in */
	cwd: string;
	/** Config and env flags */
	configArgs: string[];
	/** Prebuilt bundle to upload with --no-bundle (null: the config's own main, already built) */
	bundle: string | null;
}

export function releaseApps(root: string, env: ReleaseEnv): ReleaseApp[] {
	const suffix = env === 'stage' ? '-stage' : '';
	const envArgs = env === 'stage' ? ['--env', 'stage'] : [];
	return [
		{
			app: 'auth',
			worker: `al-ummah-now-auth${suffix}`,
			cwd: join(root, 'apps/auth'),
			// auth keeps local dev at the top level; production is env.production
			configArgs: ['-c', 'wrangler.json', '--env', env],
			bundle: join(root, 'dist/auth/index.js'),
		},
		{
			app: 'profile',
			worker: `al-ummah-now-profile${suffix}`,
			cwd: join(root, 'apps/profile'),
			configArgs: ['-c', 'wrangler.json', ...envArgs],
			bundle: join(root, 'dist/profile/index.js'),
		},
		{
			app: 'admin',
			worker: `al-ummah-now-auth-admin${suffix}`,
			cwd: join(root, 'apps/admin'),
			configArgs: ['-c', env === 'stage' ? 'build/server/wrangler.stage.json' : 'build/server/wrangler.json'],
			bundle: null,
		},
	];
}

/** "Worker Version ID: <uuid>" from `wrangler versions upload`. */
export function parseVersionId(output: string): string {
	const match = output.match(/Worker Version ID:\s*([0-9a-f-]{36})/i);
	if (!match) throw new Error(`could not find the version id in wrangler output:\n${output.slice(-500)}`);
	return match[1];
}

/** The single version serving 100% (refuses to promote over an unfinished split). */
export function currentVersion(statusJson: string, worker: string): string {
	const status = JSON.parse(statusJson) as { versions: { version_id: string; percentage: number }[] };
	const full = status.versions.filter((v) => v.percentage === 100);
	if (status.versions.length !== 1 || full.length !== 1) {
		const split = status.versions.map((v) => `${v.version_id}@${v.percentage}%`).join(', ');
		throw new Error(`${worker} has a split deployment (${split}); finish or roll it back before releasing`);
	}
	return full[0].version_id;
}

export type Runner = (cwd: string, args: string[]) => string;

const runWrangler: Runner = (cwd, args) =>
	execFileSync('npx', ['wrangler', ...args], {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, CI: 'true' },
		stdio: ['ignore', 'pipe', 'pipe'],
		maxBuffer: 32 * 1024 * 1024,
	});

export interface Released {
	app: string;
	worker: string;
	previous: string;
	candidate: string;
}

export interface PromoteDeps {
	run: Runner;
	smoke: (env: SmokeEnv, overrides?: Record<string, string>) => Promise<CheckResult[]>;
	/** Resolves when auth deep health reports `version` (through the override, if given) */
	waitForVersion: (env: SmokeEnv, worker: string, version: string, override: boolean) => Promise<void>;
	log: (line: string) => void;
}

// (plain fields: node's strip-only TypeScript has no parameter properties)
export class ReleaseError extends Error {
	readonly released: Released[];
	readonly rolledBack: boolean;
	constructor(message: string, released: Released[], rolledBack: boolean) {
		super(message);
		this.released = released;
		this.rolledBack = rolledBack;
	}
}

const failures = (results: CheckResult[]) => results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`);

export async function promote(apps: ReleaseApp[], env: ReleaseEnv, message: string, deps: PromoteDeps): Promise<Released[]> {
	const { run, log } = deps;
	const released: Released[] = [];

	// 1. What is serving now (the rollback target), then upload candidates (no traffic yet)
	for (const a of apps) {
		const previous = currentVersion(run(a.cwd, ['deployments', 'status', '--json', ...a.configArgs]), a.worker);
		const upload = ['versions', 'upload', ...a.configArgs, '--message', message];
		if (a.bundle) upload.push('--no-bundle', a.bundle);
		const candidate = parseVersionId(run(a.cwd, upload));
		released.push({ app: a.app, worker: a.worker, previous, candidate });
		log(`${a.worker}: uploaded ${candidate} (serving ${previous})`);
	}

	// Every worker is attempted even if one rollback fails; the failures are reported together
	const rollback = (reason: string) => {
		log(`Rolling back: ${reason}`);
		const failed: string[] = [];
		for (const [i, a] of apps.entries()) {
			const r = released[i];
			try {
				run(a.cwd, ['rollback', r.previous, ...a.configArgs, '-y', '--message', `auto-rollback: ${reason}`.slice(0, 100)]);
				log(`${a.worker}: rolled back to ${r.previous}`);
			} catch (error) {
				failed.push(`${a.worker}: ${(error as Error).message}`);
			}
		}
		if (failed.length) throw new ReleaseError(`ROLLBACK FAILED, fix by hand (pnpm release:rollback): ${failed.join('; ')}`, released, false);
	};

	// 2. Candidates at 0%: reachable only through the override header
	try {
		for (const [i, a] of apps.entries()) {
			const r = released[i];
			run(a.cwd, ['versions', 'deploy', `${r.candidate}@0%`, `${r.previous}@100%`, ...a.configArgs, '-y', '--message', `${message} (0%)`]);
		}
		const overrides = Object.fromEntries(released.map((r) => [r.worker, r.candidate]));
		const auth = released.find((r) => r.app === 'auth');
		if (auth) await deps.waitForVersion(env, auth.worker, auth.candidate, true);
		const pre = failures(await deps.smoke(env, overrides));
		if (pre.length) throw new Error(`pre-traffic smoke failed: ${pre.join('; ')}`);
		log('Pre-traffic smoke passed on the candidates');
	} catch (error) {
		rollback((error as Error).message);
		throw new ReleaseError((error as Error).message, released, true);
	}

	// 3. 100% traffic, triggers (crons, routes), and the smoke a user would see
	try {
		for (const [i, a] of apps.entries()) {
			run(a.cwd, ['versions', 'deploy', `${released[i].candidate}@100%`, ...a.configArgs, '-y', '--message', message]);
			run(a.cwd, ['triggers', 'deploy', ...a.configArgs]);
		}
		const auth = released.find((r) => r.app === 'auth');
		if (auth) await deps.waitForVersion(env, auth.worker, auth.candidate, false);
		const post = failures(await deps.smoke(env));
		if (post.length) throw new Error(`post-promote smoke failed: ${post.join('; ')}`);
		log('Promoted; smoke passed');
	} catch (error) {
		rollback((error as Error).message);
		throw new ReleaseError((error as Error).message, released, true);
	}
	return released;
}

/** Polls auth deep health until the given version answers (deployments take a few seconds to propagate). */
export async function waitForAuthVersion(env: SmokeEnv, worker: string, version: string, override: boolean, timeoutMs = 90_000): Promise<void> {
	const headers: Record<string, string> = { 'User-Agent': 'al-ummah-now-release' };
	if (override) headers['Cloudflare-Workers-Version-Overrides'] = `${worker}="${version}"`;
	const deadline = Date.now() + timeoutMs;
	let last = 'no response';
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${HOSTS[env].auth}/health?deep=1`, { headers });
			const body = (await res.json()) as { version?: string | null };
			if (body.version === version) return;
			last = `version ${body.version}`;
		} catch (error) {
			last = (error as Error).message;
		}
		await new Promise((r) => setTimeout(r, 3000));
	}
	throw new Error(`${worker} did not serve ${version} within ${timeoutMs / 1000}s (last: ${last})`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
	const argv = process.argv.slice(2);
	const env = (argv[argv.indexOf('--env') + 1] ?? '') as ReleaseEnv;
	if (env !== 'stage' && env !== 'production') {
		process.stderr.write('usage: promote.ts --env stage|production [--message <text>]\n');
		process.exit(2);
	}
	const message = argv.includes('--message') ? argv[argv.indexOf('--message') + 1] : `release ${process.env.GITHUB_SHA?.slice(0, 7) ?? 'local'}`;
	const root = resolve(new URL('../..', import.meta.url).pathname);
	const log = (line: string) => process.stdout.write(`${line}\n`);
	const writeResult = (result: object) => writeFileSync(join(root, 'release-result.json'), JSON.stringify(result, null, 2));
	try {
		const released = await promote(releaseApps(root, env), env, message, {
			run: runWrangler,
			smoke: (e, overrides) => runSmoke({ env: e, overrides }),
			waitForVersion: waitForAuthVersion,
			log,
		});
		writeResult({ env, status: 'promoted', released });
	} catch (error) {
		const released = error instanceof ReleaseError ? error.released : [];
		writeResult({ env, status: 'rolled-back', error: (error as Error).message, released });
		process.stderr.write(`Release failed: ${(error as Error).message}\n`);
		process.exit(1);
	}
}
