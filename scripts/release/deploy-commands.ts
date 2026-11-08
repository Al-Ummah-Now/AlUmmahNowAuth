/**
 * Finds every `wrangler deploy` / `wrangler versions upload` in workflows and
 * package.json scripts, and flags the ones that would deploy the wrong config.
 *
 * Incident 2026-11-07: auth's prod job ran bare `wrangler deploy`, which deploys
 * the top-level (local dev) config of apps/auth/wrangler.json instead of
 * env.production.
 */
import type { AppRule } from './wrangler-config.ts';

export interface DeployCommand {
	source: string;
	line: number;
	command: string;
	/** Directory the command runs in, relative to the repo root ('' = root/unknown). */
	dir: string;
}

const DEPLOY = /(?:wrangler(?:@[\w.^~-]+)?\s+(?:deploy|versions\s+upload)\b|^\s*command:\s*(?:deploy|versions\s+upload)\b)/;
const STEP_START = /^\s*-\s+(?:name|uses|run|id|if|working-directory|with|env|shell|timeout-minutes|continue-on-error):/;
const DIR_PATTERNS = [/working-directory:\s*['"]?([^'"\s]+)/, /workingDirectory:\s*['"]?([^'"\s]+)/, /\bcd\s+['"]?([^'"\s;&]+)/];

function normDir(dir: string): string {
	return dir.replace(/^\.\//, '').replace(/\/$/, '');
}

/** Scans a GitHub Actions workflow, step by step. */
export function scanWorkflow(source: string, text: string): DeployCommand[] {
	const lines = text.split('\n');
	const steps: { start: number; lines: string[] }[] = [];
	let current: { start: number; lines: string[] } = { start: 0, lines: [] };
	lines.forEach((line, i) => {
		if (STEP_START.test(line)) {
			steps.push(current);
			current = { start: i, lines: [] };
		}
		current.lines.push(line);
	});
	steps.push(current);

	const out: DeployCommand[] = [];
	for (const step of steps) {
		let dir = '';
		for (const line of step.lines) {
			for (const re of DIR_PATTERNS) {
				const m = line.match(re);
				if (m && m[1].startsWith('apps/')) dir = normDir(m[1]);
			}
		}
		// Join shell continuation lines so flags on the next line are seen.
		for (let i = 0; i < step.lines.length; i++) {
			if (step.lines[i].trimStart().startsWith('#')) continue;
			if (!DEPLOY.test(step.lines[i])) continue;
			let command = step.lines[i];
			let j = i;
			while (command.trimEnd().endsWith('\\') && j + 1 < step.lines.length) {
				j++;
				command = command.trimEnd().slice(0, -1) + ' ' + step.lines[j].trim();
			}
			out.push({ source, line: step.start + i + 1, command: command.trim(), dir });
		}
	}
	return out;
}

/** Scans one app's package.json scripts (they run in the app directory). */
export function scanPackageScripts(source: string, dir: string, pkg: { scripts?: Record<string, string> }): DeployCommand[] {
	const out: DeployCommand[] = [];
	for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
		for (const part of script.split(/&&|;|\|\|/)) {
			if (DEPLOY.test(part)) out.push({ source: `${source} (scripts.${name})`, line: 0, command: part.trim(), dir });
		}
	}
	return out;
}

function hasFlag(command: string, ...flags: string[]): boolean {
	return flags.some((f) => new RegExp(`(?:^|\\s)${f}(?:[=\\s]|$)`).test(command));
}

/**
 * For an app whose production config is a named env, every deploy must pick an env
 * or an explicit config file. Dry runs (bundling only) are fine.
 */
export function checkDeployCommands(commands: DeployCommand[], apps: AppRule[]): string[] {
	const errors: string[] = [];
	for (const cmd of commands) {
		const app = apps.find((a) => cmd.dir === a.dir || cmd.dir.startsWith(`${a.dir}/`));
		if (!app || app.production.env === null) continue;
		if (hasFlag(cmd.command, '--dry-run')) continue;
		if (hasFlag(cmd.command, '--env', '-e', '--config', '-c')) continue;
		errors.push(
			`${cmd.source}${cmd.line ? `:${cmd.line}` : ''}: bare deploy for ${app.app} would ship its top-level (dev) config; ` +
				`add --env ${app.production.env} (or --env stage / --config <file>): ${cmd.command}`
		);
	}
	return errors;
}
