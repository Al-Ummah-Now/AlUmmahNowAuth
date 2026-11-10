/**
 * The theme for one page: resolved from the per-call ?theme=, the client's
 * default and Auth's default (all must be published), then compiled and
 * cached per isolate (a package key never changes, so neither does its build).
 */
import { compileBuiltin } from '../../../../packages/ui/src/auth-theme/builtin.ts';
import { compileTheme } from '../../../../packages/ui/src/auth-theme/compile.ts';
import { chooseTheme, BUILTIN_DEFAULT_THEME, type ThemeSource } from '../../../../packages/ui/src/auth-theme/resolve.ts';
import type { CompiledTheme, StoredPackage } from '../../../../packages/ui/src/auth-theme/types.ts';
import { logger } from '../logger';
import { ThemeStore, type ThemeSettings } from './store';

const SETTINGS_TTL_MS = 5_000;
let settingsCache: { at: number; value: ThemeSettings } | null = null;
const compiledCache = new Map<string, CompiledTheme>();
const MAX_COMPILED = 50;

/** Forget cached settings (after an admin change in this isolate). */
export function invalidateThemeSettings(): void {
	settingsCache = null;
}

export async function themeSettings(store: ThemeStore): Promise<ThemeSettings> {
	if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
	try {
		const value = await store.settings();
		settingsCache = { at: Date.now(), value };
		return value;
	} catch (error) {
		// Before the migration has run (or D1 is unavailable) pages keep the built-in default
		logger.warn('Theme settings unavailable; using the built-in default', { error: error instanceof Error ? error.message : String(error) });
		return { authDefault: null, clientDefaults: {}, published: {} };
	}
}

export function assetBaseOf(env: Pick<Env, 'OPENAUTH_ISSUER'>, url: URL): string {
	return (env.OPENAUTH_ISSUER || url.origin).replace(/\/$/, '');
}

/** Compiles a stored package (header graphics are read from the asset store). */
export async function compileStored(store: ThemeStore, pkg: StoredPackage, assetBase: string): Promise<CompiledTheme> {
	const svgText: Record<string, string> = {};
	const g = pkg.theme.imagery?.headerGraphic as { light?: string; dark?: string } | undefined;
	const signInGraphic = (pkg.theme.signIn as { graphic?: string } | undefined)?.graphic;
	for (const path of [signInGraphic, g?.light, g?.dark]) {
		const a = path ? pkg.assets[path] : undefined;
		if (path && a && !(path in svgText)) svgText[path] = (await store.getAssetText(a.hash)) ?? '';
	}
	return compileTheme(pkg, { assetUrl: (_p, hash) => `${assetBase}/themes/assets/${hash}`, svgText });
}

async function compiledById(store: ThemeStore, id: string, settings: ThemeSettings, assetBase: string): Promise<CompiledTheme | undefined> {
	const builtin = compileBuiltin(id, assetBase);
	if (builtin) return builtin;
	const key = settings.published[id];
	if (!key) return undefined;
	const cacheKey = `${key}@${assetBase}`;
	const hit = compiledCache.get(cacheKey);
	if (hit) return hit;
	const pkg = await store.getPackage(key);
	if (!pkg) return undefined;
	const compiled = await compileStored(store, pkg, assetBase);
	if (compiledCache.size >= MAX_COMPILED) compiledCache.delete(compiledCache.keys().next().value!);
	compiledCache.set(cacheKey, compiled);
	return compiled;
}

export interface ResolvedTheme {
	compiled: CompiledTheme;
	source: ThemeSource;
}

export async function resolveRequestTheme(
	store: ThemeStore,
	opts: { requested?: string | null; clientId?: string | null; assetBase: string }
): Promise<ResolvedTheme> {
	const settings = await themeSettings(store);
	const isPublished = (id: string) => store.isBuiltin(id) || id in settings.published;
	const choice = chooseTheme(
		{ requested: opts.requested, clientDefault: opts.clientId ? settings.clientDefaults[opts.clientId] : null, authDefault: settings.authDefault },
		isPublished
	);
	try {
		const compiled = await compiledById(store, choice.id, settings, opts.assetBase);
		if (compiled) return { compiled, source: choice.source };
	} catch (error) {
		logger.error('Theme could not be built; using the built-in default', { theme: choice.id, error: error instanceof Error ? error.message : String(error) });
	}
	return { compiled: compileBuiltin(BUILTIN_DEFAULT_THEME, opts.assetBase)!, source: 'builtin' };
}
