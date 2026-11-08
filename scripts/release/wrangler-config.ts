/**
 * Wrangler config checks for the release pipeline (SPEC §8).
 *
 * Catches the 2026-11-07 incident class where a deploy shipped the wrong
 * wrangler environment (localhost issuer, no Secrets Store bindings).
 */

export type WranglerConfig = Record<string, unknown> & {
	env?: Record<string, Record<string, unknown>>;
};

/** Binding kinds wrangler does NOT inherit from the top level into a named env. */
const BINDING_KEYS = [
	'kv_namespaces',
	'd1_databases',
	'r2_buckets',
	'services',
	'secrets_store_secrets',
	'analytics_engine_datasets',
	'durable_objects',
	'queues',
	'ai',
	'browser',
	'hyperdrive',
	'vectorize',
	'version_metadata',
] as const;

/** Keys wrangler inherits from the top level when a named env omits them. */
const INHERITABLE_KEYS = [
	'name',
	'main',
	'compatibility_date',
	'compatibility_flags',
	'routes',
	'route',
	'workers_dev',
	'triggers',
	'assets',
	'tail_consumers',
	'observability',
] as const;

export type Binding = { kind: string; name: string };

export interface ResolvedEnv {
	envName: string | null;
	config: Record<string, unknown>;
	vars: Record<string, unknown>;
	bindings: Binding[];
	hosts: string[];
}

/**
 * Resolves the effective config for `envName` (null = top level) the way wrangler
 * does: bindings and vars come only from the env block, inheritable keys fall back
 * to the top level.
 */
export function resolveEnv(config: WranglerConfig, envName: string | null): ResolvedEnv {
	let effective: Record<string, unknown>;
	if (envName === null) {
		effective = { ...config };
		delete effective.env;
	} else {
		const block = config.env?.[envName];
		if (!block) throw new Error(`env.${envName} is not defined`);
		effective = { ...block };
		for (const key of INHERITABLE_KEYS) {
			if (!(key in effective) && key in config) effective[key] = config[key];
		}
	}
	return {
		envName,
		config: effective,
		vars: (effective.vars as Record<string, unknown>) ?? {},
		bindings: listBindings(effective),
		hosts: listHosts(effective),
	};
}

export function listBindings(config: Record<string, unknown>): Binding[] {
	const out: Binding[] = [];
	for (const kind of BINDING_KEYS) {
		const value = config[kind];
		if (!value) continue;
		if (kind === 'queues') {
			const q = value as { producers?: { binding: string }[]; consumers?: { queue: string }[] };
			for (const p of q.producers ?? []) out.push({ kind: 'queue_producer', name: p.binding });
			for (const c of q.consumers ?? []) out.push({ kind: 'queue_consumer', name: c.queue });
			continue;
		}
		if (kind === 'durable_objects') {
			const d = value as { bindings?: { name: string }[] };
			for (const b of d.bindings ?? []) out.push({ kind, name: b.name });
			continue;
		}
		if (Array.isArray(value)) {
			for (const item of value as Record<string, string>[]) {
				out.push({ kind, name: item.binding ?? item.name });
			}
			continue;
		}
		const single = value as { binding?: string };
		out.push({ kind, name: single.binding ?? kind });
	}
	return out;
}

function listHosts(config: Record<string, unknown>): string[] {
	const routes = (config.routes as unknown[]) ?? (config.route ? [config.route] : []);
	return routes.map((r) => {
		const pattern = typeof r === 'string' ? r : (r as { pattern: string }).pattern;
		return pattern.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
	});
}

/** What a deployable env must look like. */
export interface EnvRule {
	/** Wrangler env name, or null when the top level is the deployed config. */
	env: string | null;
	/** Exact var values that must be set. */
	vars?: Record<string, string>;
	/** Bindings that must exist. */
	requiredBindings?: Binding[];
	/** Every route host must match one of these (exact host or `*.suffix`). */
	allowedHosts: string[];
	/** Binding or var names that must NOT appear (test-only material). */
	forbiddenNames?: string[];
}

export interface AppRule {
	app: string;
	/** Path of the wrangler file, relative to the repo root. */
	configPath: string;
	/** App directory (used to attribute deploy commands). */
	dir: string;
	production: EnvRule;
	/** Stage rule; enforced (with prod parity) only once env.stage exists. */
	stage?: EnvRule;
}

const LOCALHOST = /\b(localhost|127\.0\.0\.1|0\.0\.0\.0)\b/;

function hostAllowed(host: string, allowed: string[]): boolean {
	return allowed.some((a) => (a.startsWith('*.') ? host.endsWith(a.slice(1)) : host === a));
}

function walkStrings(value: unknown, path: string, visit: (path: string, s: string) => void): void {
	if (typeof value === 'string') visit(path, value);
	else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, `${path}[${i}]`, visit));
	else if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value)) walkStrings(v, path ? `${path}.${k}` : k, visit);
	}
}

export function checkEnv(app: string, resolved: ResolvedEnv, rule: EnvRule): string[] {
	const where = `${app} (${resolved.envName === null ? 'top level' : `env.${resolved.envName}`})`;
	const errors: string[] = [];

	for (const [key, expected] of Object.entries(rule.vars ?? {})) {
		const actual = resolved.vars[key];
		if (actual !== expected) {
			errors.push(`${where}: vars.${key} must be ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
		}
	}

	for (const req of rule.requiredBindings ?? []) {
		if (!resolved.bindings.some((b) => b.kind === req.kind && b.name === req.name)) {
			errors.push(`${where}: missing required ${req.kind} binding ${req.name}`);
		}
	}

	if (resolved.hosts.length === 0) {
		errors.push(`${where}: no routes; a deployed env must declare its hostnames`);
	}
	for (const host of resolved.hosts) {
		if (!hostAllowed(host, rule.allowedHosts)) {
			errors.push(`${where}: route ${host} is not an allowed host (${rule.allowedHosts.join(', ')})`);
		}
	}

	const forbidden = new Set(rule.forbiddenNames ?? []);
	for (const b of resolved.bindings) {
		if (forbidden.has(b.name)) errors.push(`${where}: test-only binding ${b.name} must not be deployed here`);
	}
	for (const key of Object.keys(resolved.vars)) {
		if (forbidden.has(key)) errors.push(`${where}: test-only var ${key} must not be deployed here`);
	}

	walkStrings(resolved.config, '', (path, s) => {
		if (LOCALHOST.test(s)) errors.push(`${where}: ${path} points at localhost (${s})`);
	});

	return errors;
}

/** Stage and prod must have the same binding names and kinds (SPEC §8 parity). */
export function checkParity(app: string, prod: ResolvedEnv, stage: ResolvedEnv): string[] {
	const key = (b: Binding) => `${b.kind}:${b.name}`;
	const p = new Set(prod.bindings.map(key));
	const s = new Set(stage.bindings.map(key));
	const errors: string[] = [];
	for (const k of p) if (!s.has(k)) errors.push(`${app}: binding ${k} is in production but not in stage`);
	for (const k of s) if (!p.has(k)) errors.push(`${app}: binding ${k} is in stage but not in production`);
	const pv = Object.keys(prod.vars).sort().join(',');
	const sv = Object.keys(stage.vars).sort().join(',');
	if (pv !== sv) errors.push(`${app}: stage and production define different vars ([${sv}] vs [${pv}])`);
	return errors;
}

export function checkApp(rule: AppRule, config: WranglerConfig): string[] {
	const errors: string[] = [];
	let prod: ResolvedEnv | null = null;
	try {
		prod = resolveEnv(config, rule.production.env);
		errors.push(...checkEnv(rule.app, prod, rule.production));
	} catch (error) {
		errors.push(`${rule.app}: ${(error as Error).message}`);
	}
	if (rule.stage && rule.stage.env && config.env?.[rule.stage.env]) {
		const stage = resolveEnv(config, rule.stage.env);
		errors.push(...checkEnv(rule.app, stage, rule.stage));
		if (prod) errors.push(...checkParity(rule.app, prod, stage));
	}
	return errors;
}
