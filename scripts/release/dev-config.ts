/**
 * Local development must never reach a deployed environment's stores.
 *
 * Found 2026-11-14: the auth admin's and profile's `pnpm dev` ran on wrangler.json, the
 * PRODUCTION config, whose AUTH_STORAGE binding said `remote: true`, so local dev read and
 * wrote the live production KV. Each app now has a local-only dev config (AppRule.devConfigPath)
 * and this check keeps it that way:
 *
 * - a dev config names no production or stage resource id (KV, D1, R2, Hyperdrive, Secrets Store);
 * - a dev config points at no deployed host (only localhost, or QA at most);
 * - no wrangler config in an app sets `remote: true` (it only matters to local dev);
 * - every local script (`wrangler dev`, `--local`) runs on the dev config or a QA config;
 * - the Vite dev server (auth admin) loads the dev config;
 * - no deploy command ships a dev config;
 * - a dev config has the same bindings as the app's wrangler.json, so new bindings reach dev too.
 *
 * Pure functions; the CLI is check-dev-config.ts.
 */
import { basename } from 'node:path';
import type { DeployCommand } from './deploy-commands.ts';
import { resolveEnv, type AppRule, type WranglerConfig } from './wrangler-config.ts';

/** A deployed resource id and where it is deployed. */
export interface DeployedId {
	id: string;
	/** e.g. "auth env.production kv_namespaces AUTH_STORAGE" */
	owner: string;
}

/** Binding kinds whose entries name a real Cloudflare resource, and the keys holding the id. */
const ID_KEYS: Record<string, string[]> = {
	kv_namespaces: ['id', 'preview_id'],
	d1_databases: ['database_id', 'preview_database_id'],
	r2_buckets: ['bucket_name', 'preview_bucket_name'],
	hyperdrive: ['id'],
	secrets_store_secrets: ['store_id'],
};

/** Every resource id the app's production and stage environments use. */
export function deployedIds(rule: AppRule, config: WranglerConfig): DeployedId[] {
	const envs: (string | null)[] = [rule.production.env];
	if (rule.stage?.env && config.env?.[rule.stage.env]) envs.push(rule.stage.env);
	const out: DeployedId[] = [];
	for (const envName of envs) {
		const resolved = resolveEnv(config, envName);
		const where = `${rule.app} ${envName === null ? 'production (top level)' : `env.${envName}`}`;
		for (const [kind, keys] of Object.entries(ID_KEYS)) {
			const list = resolved.config[kind];
			if (!Array.isArray(list)) continue;
			for (const entry of list as Record<string, unknown>[]) {
				const name = String(entry.binding ?? entry.name ?? kind);
				for (const key of keys) {
					const id = entry[key];
					if (typeof id === 'string' && id) out.push({ id, owner: `${where} ${kind} ${name}` });
				}
			}
		}
	}
	return out;
}

function walk(value: unknown, path: string, visit: (path: string, value: unknown, key: string) => void, key = ''): void {
	visit(path, value, key);
	if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, visit, key));
	else if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, visit, k);
	}
}

/** Hostnames of a deployed environment: anything on alummahnow.net except QA's `*.qa.` hosts. */
const DEPLOYED_HOST = /\b((?:[a-z0-9-]+\.)*alummahnow\.net)\b/gi;
const isQaHost = (host: string) => /(^|\.)qa\.alummahnow\.net$/i.test(host);

/** `remote: true` anywhere in a wrangler config (any file, any env). */
export function checkRemoteFlags(source: string, config: unknown): string[] {
	const errors: string[] = [];
	walk(config, '', (path, value, key) => {
		if (key === 'remote' && value === true) {
			errors.push(`${source}: ${path} is \`remote: true\`, which makes local dev use the real resource; remove it`);
		}
	});
	return errors;
}

/** One dev config against every deployed resource id of every app. */
export function checkDevConfig(source: string, config: unknown, deployed: DeployedId[]): string[] {
	const errors: string[] = [];
	// First owner wins (APPS order: auth first), so the message names the app that owns the store
	const byId = new Map<string, string>();
	for (const d of deployed) if (!byId.has(d.id)) byId.set(d.id, d.owner);
	walk(config, '', (path, value) => {
		if (typeof value !== 'string') return;
		const owner = byId.get(value);
		if (owner) errors.push(`${source}: ${path} is ${value}, the id used by ${owner}; dev configs use local stores only`);
		for (const [, host] of value.matchAll(DEPLOYED_HOST)) {
			if (!isQaHost(host)) errors.push(`${source}: ${path} points at ${host}, a deployed host; use localhost (or QA at most)`);
		}
	});
	if (config && typeof config === 'object' && 'env' in config) {
		errors.push(`${source}: a dev config has no env blocks; deployed environments live in the app's wrangler.json`);
	}
	errors.push(...checkRemoteFlags(source, config));
	return errors;
}

/** The dev config has the same bindings as the app's wrangler.json (top level). */
export function checkDevBindings(rule: AppRule, config: WranglerConfig, dev: WranglerConfig): string[] {
	const key = (b: { kind: string; name: string }) => `${b.kind}:${b.name}`;
	const base = new Set(resolveEnv(config, null).bindings.map(key));
	const local = new Set(resolveEnv(dev, null).bindings.map(key));
	const errors: string[] = [];
	for (const k of base) if (!local.has(k)) errors.push(`${rule.devConfigPath}: binding ${k} is in ${rule.configPath} but not in the dev config`);
	for (const k of local) if (!base.has(k)) errors.push(`${rule.devConfigPath}: binding ${k} is not in ${rule.configPath}`);
	return errors;
}

const CONFIG_FLAG = /(?:^|\s)(?:-c|--config)(?:\s+|=)(\S+)/;
const QA_CONFIG = /(^|\/)wrangler\.qa\.jsonc?$/;

/**
 * Every package script segment that runs locally (`wrangler dev`, `--local`) must name the dev
 * config or a QA config; `wrangler dev --remote` only with a QA config.
 */
export function checkLocalScripts(rule: AppRule, source: string, pkg: { scripts?: Record<string, string> }): string[] {
	const devFile = basename(rule.devConfigPath);
	const errors: string[] = [];
	for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
		for (const part of script.split(/&&|;|\|\|/)) {
			const segment = part.trim();
			const runsDev = /\bwrangler\b.*\bdev\b/.test(segment) && !/\bwrangler\b.*\b(deploy|types|tail)\b/.test(segment);
			const local = /(?:^|\s)--local\b/.test(segment);
			if (!runsDev && !local) continue;
			const config = segment.match(CONFIG_FLAG)?.[1];
			const qa = config !== undefined && QA_CONFIG.test(config);
			if (config !== devFile && !qa) {
				errors.push(`${source} (scripts.${name}): runs locally without -c ${devFile}, so it would use ${config ?? basename(rule.configPath)}: ${segment}`);
			} else if (runsDev && /(?:^|\s)--remote\b/.test(segment) && !qa) {
				errors.push(`${source} (scripts.${name}): wrangler dev --remote only with a QA config: ${segment}`);
			}
		}
	}
	return errors;
}

/** A Vite config that runs the Cloudflare plugin must load the dev config. */
export function checkViteConfig(rule: AppRule, source: string, text: string): string[] {
	if (!/\bcloudflare\s*\(/.test(text)) return [];
	const devFile = basename(rule.devConfigPath);
	return text.includes(devFile) ? [] : [`${source}: the Cloudflare Vite plugin must load ${devFile} for the dev server (configPath)`];
}

/** No deploy command ships a dev config. */
export function checkDevNotDeployed(commands: DeployCommand[]): string[] {
	return commands
		.filter((c) => /wrangler\.dev\.jsonc?\b/.test(c.command))
		.map((c) => `${c.source}${c.line ? `:${c.line}` : ''}: deploys a dev config: ${c.command}`);
}
