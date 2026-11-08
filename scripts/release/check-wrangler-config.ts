/**
 * Release-pipeline config check (SPEC §8). Runs in CI and before every deploy:
 *   node --experimental-strip-types scripts/release/check-wrangler-config.ts
 * Exits 1 and lists every problem if a deployed config or deploy command is wrong.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { APPS } from './apps.ts';
import { parseJsonc } from './jsonc.ts';
import { checkApp, type WranglerConfig } from './wrangler-config.ts';
import { checkDeployCommands, scanPackageScripts, scanWorkflow, type DeployCommand } from './deploy-commands.ts';

export function runCheck(root: string): string[] {
	const errors: string[] = [];

	for (const rule of APPS) {
		const path = join(root, rule.configPath);
		if (!existsSync(path)) {
			errors.push(`${rule.app}: ${rule.configPath} not found`);
			continue;
		}
		errors.push(...checkApp(rule, parseJsonc(readFileSync(path, 'utf8')) as WranglerConfig));
	}

	const commands: DeployCommand[] = [];
	const workflowDir = join(root, '.github/workflows');
	if (existsSync(workflowDir)) {
		for (const file of readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f))) {
			commands.push(...scanWorkflow(`.github/workflows/${file}`, readFileSync(join(workflowDir, file), 'utf8')));
		}
	}
	for (const rule of APPS) {
		const pkgPath = join(root, rule.dir, 'package.json');
		if (existsSync(pkgPath)) {
			commands.push(...scanPackageScripts(`${rule.dir}/package.json`, rule.dir, JSON.parse(readFileSync(pkgPath, 'utf8'))));
		}
	}
	errors.push(...checkDeployCommands(commands, APPS));
	return errors;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
	const root = resolve(process.argv[2] ?? process.cwd());
	const errors = runCheck(root);
	if (errors.length > 0) {
		process.stderr.write(`Wrangler config check failed (${errors.length}):\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
		process.exit(1);
	}
	process.stdout.write(`Wrangler config check passed (${APPS.map((a) => a.app).join(', ')}).\n`);
}
