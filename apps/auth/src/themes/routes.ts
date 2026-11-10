/**
 * Theme HTTP routes.
 *
 * Admin (/admin/themes/*): Auth admins only (Admin or Super Admin, from
 * requireAdmin: M2M token with admin scope + acting admin user, or an admin
 * session). Public (/themes*): published theme ids and names, compiled CSS
 * and asset files; nothing private.
 */
import { Hono, type Context } from 'hono';
import { BUILTIN_IDS, builtinPackage } from '../../../../packages/ui/src/auth-theme/builtin.ts';
import type { AuthThemeJson, StoredPackage } from '../../../../packages/ui/src/auth-theme/types.ts';
import { formatIssues, validateTheme } from '../../../../packages/ui/src/auth-theme/validate.ts';
import { requireAdmin } from '../middleware/admin-auth';
import { getClientIP } from '../rate-limit';
import { PREVIEW_PAGES, renderPreview, type PreviewPage } from './preview';
import { assetBaseOf, compileStored, resolveRequestTheme, themeSettings } from './runtime';
import { ThemeError, ThemeService, type Actor } from './service';
import { ThemeStore, ThemeStoreUnavailable } from './store';

type Vars = { adminUser: { userId: string; email: string; roles: string[] } | null; tenantId: string };
type AdminContext = Context<{ Bindings: Env; Variables: Vars }>;

const serviceOf = (env: Env) => new ThemeService(new ThemeStore(env.AUTH_DB, env.AUTH_THEMES));

function actorOf(c: AdminContext): Actor {
	const admin = c.get('adminUser');
	return {
		userId: admin?.userId ?? 'unknown',
		email: admin?.email ?? '',
		ip: getClientIP(c.req.raw),
		userAgent: c.req.header('User-Agent') ?? null,
		requestId: c.req.header('X-Request-Id') ?? null,
	};
}

function fail(c: AdminContext, error: unknown) {
	if (error instanceof ThemeError) return c.json({ error: error.code, error_description: error.message, details: error.details }, error.status as 400);
	if (error instanceof ThemeStoreUnavailable) return c.json({ error: 'unavailable', error_description: error.message }, 503);
	throw error;
}

const handle = (fn: (c: AdminContext) => Promise<Response>) => async (c: AdminContext) => {
	try {
		return await fn(c);
	} catch (error) {
		return fail(c, error);
	}
};

async function bodyBytes(c: AdminContext): Promise<Uint8Array> {
	return new Uint8Array(await c.req.arrayBuffer());
}

export const adminThemeRoutes = new Hono<{ Bindings: Env; Variables: Vars }>().basePath('/admin/themes');
adminThemeRoutes.use('*', requireAdmin());

adminThemeRoutes.get('/', handle(async (c) => c.json(await serviceOf(c.env).list())));

adminThemeRoutes.post(
	'/default',
	handle(async (c) => {
		const { themeId } = await c.req.json<{ themeId?: string }>();
		if (!themeId) throw new ThemeError(400, 'invalid_request', 'themeId is required');
		await serviceOf(c.env).setAuthDefault(actorOf(c), themeId);
		return c.json({ ok: true });
	})
);

adminThemeRoutes.put(
	'/clients/:clientId',
	handle(async (c) => {
		const { themeId } = await c.req.json<{ themeId?: string | null }>();
		await serviceOf(c.env).setClientDefault(actorOf(c), c.req.param('clientId'), themeId ?? null);
		return c.json({ ok: true });
	})
);

adminThemeRoutes.post(
	'/import',
	handle(async (c) => {
		const id = c.req.query('id') || undefined;
		const summary = await serviceOf(c.env).importZip(actorOf(c), await bodyBytes(c), { id, replace: c.req.query('replace') === '1' });
		return c.json(summary, 201);
	})
);

/** Live preview of a (possibly unsaved) theme: { theme?, themeId?, page, lang, scheme } → HTML. */
adminThemeRoutes.post(
	'/preview',
	handle(async (c) => {
		const body = await c.req.json<{ theme?: AuthThemeJson; themeId?: string; page?: string; lang?: string; scheme?: string }>();
		const page = (PREVIEW_PAGES as readonly string[]).includes(body.page ?? '') ? (body.page as PreviewPage) : 'sign-in';
		const lang = body.lang === 'ar' ? 'ar' : 'en';
		const scheme = body.scheme === 'dark' ? 'dark' : 'light';
		const env = c.env;
		const store = new ThemeStore(env.AUTH_DB, env.AUTH_THEMES);
		const service = new ThemeService(store);
		const url = new URL(c.req.url);
		const assetBase = assetBaseOf(env, url);
		let pkg: StoredPackage;
		if (body.theme) {
			const assets = body.themeId ? (await service.packageOf(body.themeId)).assets : {};
			const { errors } = validateTheme(body.theme, { stored: assets });
			if (errors.length) throw new ThemeError(422, 'invalid_theme', formatIssues(errors), errors);
			pkg = { theme: body.theme, assets };
		} else if (body.themeId) {
			pkg = await service.packageOf(body.themeId);
		} else throw new ThemeError(400, 'invalid_request', 'theme or themeId is required');
		const compiled = await compileStored(store, pkg, assetBase);
		const html = await renderPreview(compiled, {
			page, lang, scheme, issuer: assetBase, profileUrl: (env.PROFILE_APP_URL || 'https://profile.auth.alummahnow.net').replace(/\/$/, ''),
		});
		return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
	})
);

adminThemeRoutes.get(
	'/:id',
	handle(async (c) => {
		const service = serviceOf(c.env);
		const id = c.req.param('id');
		const source = c.req.query('source') === 'published' ? 'published' : 'draft';
		const [summary, pkg] = await Promise.all([service.summary(id), service.packageOf(id, source)]);
		const base = assetBaseOf(c.env, new URL(c.req.url));
		const assetUrls = Object.fromEntries(Object.entries(pkg.assets).map(([p, a]) => [p, `${base}/themes/assets/${a.hash}`]));
		return c.json({ summary, theme: pkg.theme, assets: pkg.assets, assetUrls });
	})
);

adminThemeRoutes.post(
	'/:id/duplicate',
	handle(async (c) => {
		const { id, name } = await c.req.json<{ id?: string; name?: { en?: string; ar?: string } }>();
		if (!id || !name?.en || !name?.ar) throw new ThemeError(400, 'invalid_request', 'id and name (en, ar) are required');
		return c.json(await serviceOf(c.env).duplicate(actorOf(c), c.req.param('id'), id, { en: name.en, ar: name.ar }), 201);
	})
);

adminThemeRoutes.put(
	'/:id/draft',
	handle(async (c) => {
		const { theme } = await c.req.json<{ theme?: unknown }>();
		return c.json(await serviceOf(c.env).saveDraft(actorOf(c), c.req.param('id'), theme));
	})
);

adminThemeRoutes.post(
	'/:id/assets',
	handle(async (c) => {
		const path = c.req.query('path') ?? '';
		return c.json(await serviceOf(c.env).uploadAsset(actorOf(c), c.req.param('id'), path, await bodyBytes(c)), 201);
	})
);

adminThemeRoutes.delete(
	'/:id/assets',
	handle(async (c) => {
		await serviceOf(c.env).removeAsset(actorOf(c), c.req.param('id'), c.req.query('path') ?? '');
		return c.json({ ok: true });
	})
);

adminThemeRoutes.post('/:id/publish', handle(async (c) => c.json(await serviceOf(c.env).publish(actorOf(c), c.req.param('id')))));

adminThemeRoutes.delete(
	'/:id',
	handle(async (c) => {
		await serviceOf(c.env).remove(actorOf(c), c.req.param('id'));
		return c.json({ ok: true });
	})
);

adminThemeRoutes.get(
	'/:id/export',
	handle(async (c) => {
		const { filename, data } = await serviceOf(c.env).exportZip(c.req.param('id'), c.req.query('source') === 'published' ? 'published' : 'draft');
		return new Response(data, {
			headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' },
		});
	})
);

// ---------------------------------------------------------------- public

const PUBLIC_HEADERS = { 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' };

/** GET /themes: published Auth themes (ids and names) apps may pass as ?theme=. */
export async function handlePublicThemeList(env: Env): Promise<Response> {
	const store = new ThemeStore(env.AUTH_DB, env.AUTH_THEMES);
	const settings = await themeSettings(store);
	const rows = Object.keys(settings.published).length ? await store.listRows().catch(() => []) : [];
	const themes = [
		...BUILTIN_IDS.map((id) => ({ id, name: builtinPackage(id)!.theme.name, version: builtinPackage(id)!.theme.version })),
		...rows.filter((r) => r.published_key).map((r) => ({ id: r.id, name: { en: r.name_en, ar: r.name_ar }, version: r.published_version })),
	];
	return new Response(JSON.stringify({ themes, default: settings.authDefault ?? 'fawanees' }), {
		headers: { ...PUBLIC_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' },
	});
}

/** GET /themes/resolve?client_id=&theme=: the theme a client's pages get, with its token CSS (profile, admin shell). */
export async function handleThemeResolve(env: Env, url: URL): Promise<Response> {
	const store = new ThemeStore(env.AUTH_DB, env.AUTH_THEMES);
	const requested = url.searchParams.get('theme');
	const { compiled, source } = await resolveRequestTheme(store, {
		requested: requested && /^[a-z][a-z0-9-]{1,39}$/.test(requested) ? requested : null,
		clientId: url.searchParams.get('client_id'),
		assetBase: assetBaseOf(env, url),
	});
	return new Response(JSON.stringify({ id: compiled.id, version: compiled.version, name: compiled.name, source, css: compiled.tokensCss }), {
		headers: { ...PUBLIC_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' },
	});
}

/** GET /themes/assets/<sha256>: a theme file. Immutable; SVG can't run script here. */
export async function handleThemeAsset(env: Env, hash: string): Promise<Response> {
	if (!/^[0-9a-f]{64}$/.test(hash)) return new Response('Not found', { status: 404 });
	const asset = await new ThemeStore(env.AUTH_DB, env.AUTH_THEMES).getAsset(hash);
	if (!asset) return new Response('Not found', { status: 404 });
	return new Response(asset.data, {
		headers: {
			...PUBLIC_HEADERS,
			'Content-Type': asset.type,
			'Cache-Control': 'public, max-age=31536000, immutable',
			'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
			'Cross-Origin-Resource-Policy': 'cross-origin',
		},
	});
}
