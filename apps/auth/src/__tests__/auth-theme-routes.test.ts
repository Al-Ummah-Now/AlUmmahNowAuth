/**
 * Auth theme admin API (Auth admins only), the public theme endpoints, and
 * which theme a page gets: per-call ?theme=, client default, Auth default.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { setupDatabase } from '../test-setup';
import { clearJWKSCache, SIGNING_KEY_KV_KEY } from '../utils/jwks-cache';
import { adminThemeRoutes, handlePublicThemeList, handleThemeAsset, handleThemeResolve } from '../themes/routes';
import { invalidateThemeSettings, resolveRequestTheme } from '../themes/runtime';
import { ThemeStore } from '../themes/store';
import { builtinPackage } from '../../../../packages/ui/src/auth-theme/builtin.ts';
import { PROFILE, registerTestClients } from './helpers/clients';

const audit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../audit-emitter', () => ({ emitAuditEvent: audit }));

const ENV = env as unknown as Env;
const ISSUER = 'http://localhost:3301';
const ADMIN_USER = 'theme-admin';
const MEMBER_USER = 'theme-member';
const ID = 'test-theme-routes';
let privateKey: CryptoKey;
let previousKey: string | null;

async function token(scope = 'admin:*') {
	return new SignJWT({ client_id: 'admin-client', scope, mode: 'access' })
		.setProtectedHeader({ alg: 'ES256', kid: 'theme-kid' })
		.setIssuer(ISSUER)
		.setSubject('admin-client')
		.setIssuedAt()
		.setExpirationTime('5m')
		.sign(privateKey);
}

async function call(method: string, path: string, opts: { body?: unknown; raw?: Uint8Array; user?: string | null; scope?: string } = {}) {
	const headers: Record<string, string> = {};
	if (opts.user !== null) {
		headers.Authorization = `Bearer ${await token(opts.scope)}`;
		headers['X-Acting-User-Id'] = opts.user ?? ADMIN_USER;
	}
	let body: BodyInit | undefined;
	if (opts.raw) body = opts.raw;
	else if (opts.body !== undefined) {
		body = JSON.stringify(opts.body);
		headers['Content-Type'] = 'application/json';
	}
	return adminThemeRoutes.fetch(new Request(`${ISSUER}/admin/themes${path}`, { method, headers, body }), ENV);
}

beforeAll(async () => {
	await setupDatabase();
	await registerTestClients();
	const pair = await generateKeyPair('ES256', { extractable: true });
	privateKey = pair.privateKey as CryptoKey;
	previousKey = await ENV.AUTH_STORAGE.get(SIGNING_KEY_KV_KEY);
	await ENV.AUTH_STORAGE.put(
		SIGNING_KEY_KV_KEY,
		JSON.stringify({ id: 'theme-kid', alg: 'ES256', publicKey: await exportSPKI(pair.publicKey), privateKey: '', created: Date.now() })
	);
	clearJWKSCache();
	const now = Date.now();
	await ENV.AUTH_DB.prepare(`INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id) VALUES ('role_theme_admin', 'Admin', 'default')`).run();
	const admin = await ENV.AUTH_DB.prepare(`SELECT id FROM rbac_roles WHERE name = 'Admin' AND tenant_id = 'default'`).first<{ id: string }>();
	await ENV.AUTH_DB.prepare(
		`INSERT OR IGNORE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) VALUES (?, ?, 'default', ?, 'test')`
	)
		.bind(ADMIN_USER, admin!.id, now)
		.run();
	await ENV.AUTH_DB.prepare('DELETE FROM auth_theme_client_defaults').run();
	await ENV.AUTH_DB.prepare('DELETE FROM auth_theme_settings').run();
	await ENV.AUTH_DB.prepare('DELETE FROM auth_themes').run();
	invalidateThemeSettings();
});

afterAll(async () => {
	await ENV.AUTH_DB.prepare('DELETE FROM auth_theme_client_defaults').run();
	await ENV.AUTH_DB.prepare('DELETE FROM auth_theme_settings').run();
	await ENV.AUTH_DB.prepare('DELETE FROM auth_themes').run();
	if (previousKey) await ENV.AUTH_STORAGE.put(SIGNING_KEY_KV_KEY, previousKey);
	else await ENV.AUTH_STORAGE.delete(SIGNING_KEY_KV_KEY);
	clearJWKSCache();
	invalidateThemeSettings();
});

describe('who may manage themes', () => {
	it('nobody without a token', async () => {
		expect((await call('GET', '', { user: null })).status).toBe(401);
	});
	it('not a client without an admin scope', async () => {
		expect((await call('GET', '', { scope: 'read' })).status).toBe(403);
	});
	it('not a user without an Auth admin role', async () => {
		expect((await call('GET', '', { user: MEMBER_USER })).status).toBe(403);
		expect((await call('POST', '/fawanees/duplicate', { user: MEMBER_USER, body: { id: 'x-y', name: { en: 'X', ar: 'س' } } })).status).toBe(403);
	});
	it('an Auth admin', async () => {
		const res = await call('GET', '');
		expect(res.status).toBe(200);
		const body = await res.json<{ themes: { id: string; kind: string }[]; authDefault: string }>();
		expect(body.authDefault).toBe('fawanees');
		expect(body.themes.filter((t) => t.kind === 'builtin').map((t) => t.id).sort()).toEqual(['classic', 'fawanees', 'lantern', 'nahas', 'zujaj']);
	});
});

describe('a custom theme from duplicate to delete', () => {
	it('duplicates a built-in as a custom draft', async () => {
		const res = await call('POST', '/fawanees/duplicate', { body: { id: ID, name: { en: 'Test', ar: 'تجربة' } } });
		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({ id: ID, kind: 'custom', status: 'draft', basedOn: null });
		expect(audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'theme.created', userId: ADMIN_USER }));
		const got = await (await call('GET', `/${ID}`)).json<{ theme: Record<string, unknown> }>();
		expect(got.theme).toMatchObject({ id: ID, kind: 'custom', version: '1.0.0', basedOn: `fawanees@${builtinPackage('fawanees')!.theme.version}` });
	});

	it('cannot change or delete a built-in', async () => {
		expect((await call('PUT', '/fawanees/draft', { body: { theme: {} } })).status).toBe(409);
		expect((await call('DELETE', '/fawanees')).status).toBe(409);
	});

	it('saves a draft with a contrast problem but will not publish it', async () => {
		const { theme } = await (await call('GET', `/${ID}`)).json<{ theme: any }>();
		theme.tokens.color.light.textMuted = '#fff1c4';
		const saved = await call('PUT', `/${ID}/draft`, { body: { theme } });
		expect(saved.status).toBe(200);
		expect((await saved.json<{ contrast: unknown[] }>()).contrast.length).toBeGreaterThan(0);
		const pub = await call('POST', `/${ID}/publish`);
		expect(pub.status).toBe(422);
		expect(await pub.json()).toMatchObject({ error: 'contrast' });
	});

	it('rejects an invalid draft', async () => {
		const { theme } = await (await call('GET', `/${ID}`)).json<{ theme: any }>();
		theme['x-auth'].sections.base['card.padding'] = 'red;}</style>';
		expect((await call('PUT', `/${ID}/draft`, { body: { theme } })).status).toBe(422);
	});

	it('uploads an image, uses it, and publishes', async () => {
		const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="x()"><rect width="10" height="10" fill="#123456"/></svg>');
		const up = await call('POST', `/${ID}/assets?path=assets/header.svg`, { raw: svg });
		expect(up.status).toBe(201);
		const { hash } = await up.json<{ hash: string }>();
		const stored = await new ThemeStore(ENV.AUTH_DB, ENV.AUTH_THEMES).getAssetText(hash);
		expect(stored).not.toContain('onload');

		const { theme } = await (await call('GET', `/${ID}`)).json<{ theme: any }>();
		theme.tokens.color.light.textMuted = builtinMuted;
		theme.imagery.headerGraphic = { light: 'assets/header.svg', dark: 'assets/header.svg' };
		theme['x-auth'].sections.base['button.radius'] = '3px';
		expect((await call('PUT', `/${ID}/draft`, { body: { theme } })).status).toBe(200);
		expect((await call('DELETE', `/${ID}/assets?path=assets/header.svg`)).status).toBe(409);

		const pub = await call('POST', `/${ID}/publish`);
		expect(pub.status).toBe(200);
		expect(await pub.json()).toMatchObject({ status: 'published', version: '1.0.0' });
	});

	it('publishing changed content makes a new version', async () => {
		const { theme } = await (await call('GET', `/${ID}`)).json<{ theme: any }>();
		theme['x-auth'].sections.base['button.radius'] = '4px';
		await call('PUT', `/${ID}/draft`, { body: { theme } });
		expect(await (await call('POST', `/${ID}/publish`)).json()).toMatchObject({ version: '1.1.0' });
	});

	it('is listed publicly once published', async () => {
		invalidateThemeSettings();
		const list = await (await handlePublicThemeList(ENV)).json<{ themes: { id: string }[]; default: string }>();
		expect(list.themes.map((t) => t.id)).toContain(ID);
		expect(list.default).toBe('fawanees');
	});

	it('a client default, the per-call theme and the fallbacks', async () => {
		const store = new ThemeStore(ENV.AUTH_DB, ENV.AUTH_THEMES);
		expect((await call('PUT', `/clients/${PROFILE.id}`, { body: { themeId: ID } })).status).toBe(200);
		expect((await call('PUT', '/clients/no-such-client', { body: { themeId: ID } })).status).toBe(404);
		invalidateThemeSettings();

		const forClient = await resolveRequestTheme(store, { clientId: PROFILE.id, assetBase: ISSUER });
		expect(forClient).toMatchObject({ source: 'client', compiled: { id: ID } });
		expect(forClient.compiled.openauth.css).toContain('border-radius: 4px');
		expect(forClient.compiled.graphic!.light).toContain('#123456');

		expect(await resolveRequestTheme(store, { requested: 'nahas', clientId: PROFILE.id, assetBase: ISSUER })).toMatchObject({ source: 'requested', compiled: { id: 'nahas' } });
		expect(await resolveRequestTheme(store, { requested: 'no-such-theme', clientId: PROFILE.id, assetBase: ISSUER })).toMatchObject({ source: 'client', compiled: { id: ID } });
		expect(await resolveRequestTheme(store, { requested: 'no-such-theme', assetBase: ISSUER })).toMatchObject({ source: 'builtin', compiled: { id: 'fawanees' } });

		const resolved = await (await handleThemeResolve(ENV, new URL(`${ISSUER}/themes/resolve?client_id=${PROFILE.id}`))).json<{ id: string; css: string }>();
		expect(resolved.id).toBe(ID);
		expect(resolved.css).toContain('--fanous-color-background');
	});

	it('the Auth default', async () => {
		expect((await call('POST', '/default', { body: { themeId: 'lantern' } })).status).toBe(200);
		invalidateThemeSettings();
		const store = new ThemeStore(ENV.AUTH_DB, ENV.AUTH_THEMES);
		expect(await resolveRequestTheme(store, { clientId: 'other-client', assetBase: ISSUER })).toMatchObject({ source: 'auth', compiled: { id: 'lantern' } });
	});

	it('exports and imports a zip', async () => {
		const zip = await call('GET', `/${ID}/export?source=published`);
		expect(zip.headers.get('Content-Type')).toBe('application/zip');
		const bytes = new Uint8Array(await zip.arrayBuffer());
		expect((await call('POST', '/import', { raw: bytes })).status).toBe(409);
		const imported = await call('POST', `/import?id=${ID}-copy`, { raw: bytes });
		expect(imported.status).toBe(201);
		expect(await imported.json()).toMatchObject({ id: `${ID}-copy`, status: 'draft' });
		expect((await call('DELETE', `/${ID}-copy`)).status).toBe(200);
	});

	it('previews a real page with no scripts, for a stored or an edited theme', async () => {
		for (const lang of ['en', 'ar']) {
			const res = await call('POST', '/preview', { body: { themeId: 'nahas', page: 'sign-in', lang, scheme: 'dark' } });
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain('<form');
			expect(html).not.toMatch(/<script/i);
		}
		const { theme } = await (await call('GET', `/${ID}`)).json<{ theme: Record<string, unknown> }>();
		const edited = await call('POST', '/preview', { body: { theme, themeId: ID, page: 'register', lang: 'en', scheme: 'light' } });
		expect(edited.status).toBe(200);
		expect(await edited.text()).not.toMatch(/<script/i);
	});

	it('serves theme files by hash, immutable and sandboxed', async () => {
		const { assets } = await (await call('GET', `/${ID}`)).json<{ assets: Record<string, { hash: string }> }>();
		const res = await handleThemeAsset(ENV, assets['assets/header.svg'].hash);
		expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
		expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
		expect((await handleThemeAsset(ENV, 'nope')).status).toBe(404);
	});

	it('cannot be deleted while in use, then is soft-deleted: hidden everywhere, id still taken', async () => {
		expect((await call('DELETE', `/${ID}`)).status).toBe(409);
		await call('PUT', `/clients/${PROFILE.id}`, { body: { themeId: null } });
		await call('POST', '/default', { body: { themeId: 'fawanees' } });
		expect((await call('DELETE', `/${ID}`, { body: { reason: 'Replaced' } })).status).toBe(200);
		expect((await call('GET', `/${ID}`)).status).toBe(404);
		const list = await (await call('GET', '')).json<{ themes: { id: string }[] }>();
		expect(list.themes.map((t) => t.id)).not.toContain(ID);
		invalidateThemeSettings();
		const pub = await (await handlePublicThemeList(ENV)).json<{ themes: { id: string }[] }>();
		expect(pub.themes.map((t) => t.id)).not.toContain(ID);
		// Nothing removed yet: the row stays until the cleanup, so the id can't be reused
		expect(await new ThemeStore(ENV.AUTH_DB, ENV.AUTH_THEMES).rawRow(ID)).not.toBeNull();
		expect((await call('POST', `/${'fawanees'}/duplicate`, { body: { id: ID, name: { en: 'X', ar: 'س' } } })).status).toBe(409);
		expect(audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'admin.item.deleted' }));
		expect((await call('DELETE', `/${ID}`)).status).toBe(404);
	});
});

const builtinMuted = '#24505f';
