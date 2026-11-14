/**
 * Dev-config check (scripts/release/dev-config.ts). Runs in CI:
 *   node --experimental-strip-types scripts/release/check-dev-config.ts
 * Exits 1 and lists every problem if local development could reach a deployed environment.
 */
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { APPS } from './apps.ts';
import { scanPackageScripts, scanWorkflow, type DeployCommand } from './deploy-commands.ts';
import {
	checkDevBindings,
	checkDevConfig,
	checkDevNotDeployed,
	checkLocalScripts,
	checkRemoteFlags,
	checkViteConfig,
	deployedIds,
	type DeployedId,
} from './dev-config.ts';
import { parseJsonc } from './jsonc.ts';
import type { WranglerConfig } from './wrangler-config.ts';

const read = (path: string) => parseJsonc(readFileSync(path, 'utf8')) as WranglerConfig;

export function runDevConfigCheck(root: string): string[] {
	const errors: string[] = [];
	const deployed: DeployedId[] = [];
	for (const rule of APPS) {
		const path = join(root, rule.configPath);
		if (existsSync(path)) deployed.push(...deployedIds(rule, read(path)));
		else errors.push(`${rule.app}: ${rule.configPath} not found`);
	}

	for (const rule of APPS) {
		const devPath = join(root, rule.devConfigPath);
		if (existsSync(devPath)) {
			const dev = read(devPath);
			errors.push(...checkDevConfig(rule.devConfigPath, dev, deployed));
			const configPath = join(root, rule.configPath);
			if (existsSync(configPath)) errors.push(...checkDevBindings(rule, read(configPath), dev));
		} else {
			errors.push(`${rule.app}: ${rule.devConfigPath} not found; every app needs a local-only dev config`);
		}

		const appDir = join(root, rule.dir);
		for (const file of readdirSync(appDir).filter((f) => /^wrangler(\..+)?\.jsonc?$/.test(f))) {
			if (join(appDir, file) !== devPath) errors.push(...checkRemoteFlags(`${rule.dir}/${file}`, read(join(appDir, file))));
		}
		const pkgPath = join(appDir, 'package.json');
		if (existsSync(pkgPath)) errors.push(...checkLocalScripts(rule, `${rule.dir}/package.json`, JSON.parse(readFileSync(pkgPath, 'utf8'))));
		for (const vite of ['vite.config.ts', 'vite.config.mts', 'vite.config.js']) {
			const vitePath = join(appDir, vite);
			if (existsSync(vitePath)) errors.push(...checkViteConfig(rule, `${rule.dir}/${vite}`, readFileSync(vitePath, 'utf8')));
		}
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
		if (existsSync(pkgPath)) commands.push(...scanPackageScripts(`${rule.dir}/package.json`, rule.dir, JSON.parse(readFileSync(pkgPath, 'utf8'))));
	}
	errors.push(...checkDevNotDeployed(commands));
	return errors;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	const root = resolve(process.argv[2] ?? process.cwd());
	const errors = runDevConfigCheck(root);
	if (errors.length > 0) {
		process.stderr.write(`Dev config check failed (${errors.length}):\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
		process.exit(1);
	}
	process.stdout.write(`Dev config check passed (${APPS.map((a) => a.devConfigPath).join(', ')}).\n`);
}
