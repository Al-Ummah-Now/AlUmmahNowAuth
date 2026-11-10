/**
 * Auth theme management for the Auth admin: list, duplicate, edit drafts,
 * upload assets, publish, defaults, delete, import/export. Every change is
 * audit-logged with the acting admin.
 */
import { BUILTIN_IDS, builtinPackage } from '../../../../packages/ui/src/auth-theme/builtin.ts';
import { sanitizeSvg } from '../../../../packages/ui/src/auth-theme/svg.ts';
import type { AuthThemeJson, Localized, StoredPackage } from '../../../../packages/ui/src/auth-theme/types.ts';
import {
	assetTypeFor,
	formatIssues,
	MAX_ASSET_BYTES,
	MAX_PACKAGE_BYTES,
	referencedAssets,
	validateTheme,
	type Issue,
} from '../../../../packages/ui/src/auth-theme/validate.ts';
import { BUILTIN_DEFAULT_THEME } from '../../../../packages/ui/src/auth-theme/resolve.ts';
import { duplicatePackage, nextVersion } from '../../../../packages/ui/src/theme-packages/edit.ts';
import { SCHEMA } from '../../../../packages/ui/src/theme-packages/schema.generated.ts';
import { sniff, svgProblem } from '../../../../packages/ui/src/theme-packages/validate.ts';
import type { PackageFiles } from '../../../../packages/ui/src/theme-packages/types.ts';
import { packageToZip, zipToPackage } from '../../../../packages/ui/src/theme-packages/zip.ts';
import { AuditEventSeverity, AuditEventType } from '../audit-events';
import { emitAuditEvent } from '../audit-emitter';
import { invalidateThemeSettings } from './runtime';
import type { ThemeRow, ThemeStore } from './store';

export class ThemeError extends Error {
	constructor(public status: number, public code: string, message: string, public details?: Issue[]) {
		super(message);
	}
}

export interface Actor {
	userId: string;
	email: string;
	ip: string | null;
	userAgent: string | null;
	requestId: string | null;
}

export type ThemeStatus = 'published' | 'draft' | 'changed';

export interface ThemeSummary {
	id: string;
	name: Localized;
	kind: 'builtin' | 'custom';
	status: ThemeStatus;
	version: string | null;
	draftVersion: string | null;
	basedOn: string | null;
	isAuthDefault: boolean;
	clientIds: string[];
	updatedAt: number | null;
	updatedBy: string | null;
	publishedAt: number | null;
}

const ID = /^[a-z][a-z0-9-]{1,39}$/;
const AUTHOR = 'Al Ummah Now';
const SNIFFED: Record<string, string> = { 'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'image/x-icon': 'ico', 'font/woff2': 'woff2' };

const semver = (v: string) => v.split('.').map(Number) as [number, number, number];
const newer = (a: string, b: string) => {
	const [x, y] = [semver(a), semver(b)];
	return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

async function audit(actor: Actor, eventType: AuditEventType, metadata: Record<string, unknown>, severity = AuditEventSeverity.INFO) {
	await emitAuditEvent({
		timestamp: new Date().toISOString(),
		eventType,
		severity,
		userId: actor.userId,
		ipAddress: actor.ip,
		userAgent: actor.userAgent,
		requestId: actor.requestId,
		success: true,
		errorMessage: null,
		metadata: { ...metadata, actor_email: actor.email },
	});
}

export class ThemeService {
	constructor(private store: ThemeStore) {}

	/** A draft may still miss WCAG AA (the builder shows it); `publish` needs it. */
	private validate(theme: unknown, assets: StoredPackage['assets'], mode: 'draft' | 'publish', files?: Record<string, Uint8Array>): { theme: AuthThemeJson; contrast: Issue[] } {
		const v = validateTheme(theme, files ? { files } : { stored: assets });
		if (v.errors.length) throw new ThemeError(422, 'invalid_theme', formatIssues(v.errors), v.errors);
		if (mode === 'publish' && v.contrast.length) throw new ThemeError(422, 'contrast', `Fix contrast before publishing: ${formatIssues(v.contrast)}`, v.contrast);
		return { theme: theme as AuthThemeJson, contrast: v.contrast };
	}

	private async customRow(id: string): Promise<ThemeRow> {
		if (this.store.isBuiltin(id)) throw new ThemeError(409, 'builtin', 'Built-in themes cannot be changed; duplicate one instead');
		const row = await this.store.getRow(id);
		if (!row) throw new ThemeError(404, 'not_found', 'Theme not found');
		return row;
	}

	private async draftOf(row: ThemeRow): Promise<StoredPackage> {
		const key = row.draft_key ?? row.published_key;
		const pkg = key ? await this.store.getPackage(key) : null;
		if (!pkg) throw new ThemeError(500, 'missing_package', 'Theme package is missing from storage');
		return pkg;
	}

	/** The package of a theme: built-in, a custom theme's draft, or its published version. */
	async packageOf(id: string, source: 'draft' | 'published' = 'draft'): Promise<StoredPackage> {
		const builtin = builtinPackage(id);
		if (builtin) return builtin;
		const row = await this.store.getRow(id);
		if (!row) throw new ThemeError(404, 'not_found', 'Theme not found');
		if (source === 'published') {
			const pkg = row.published_key ? await this.store.getPackage(row.published_key) : null;
			if (!pkg) throw new ThemeError(404, 'not_published', 'Theme is not published');
			return pkg;
		}
		return this.draftOf(row);
	}

	async list(): Promise<{ themes: ThemeSummary[]; authDefault: string; clientDefaults: Record<string, string> }> {
		const [rows, settings] = await Promise.all([this.store.listRows(), this.store.settings()]);
		const authDefault = settings.authDefault ?? BUILTIN_DEFAULT_THEME;
		const clientsOf = (id: string) => Object.entries(settings.clientDefaults).filter(([, t]) => t === id).map(([c]) => c);
		const builtins: ThemeSummary[] = BUILTIN_IDS.map((id) => {
			const t = builtinPackage(id)!.theme;
			return {
				id, name: t.name, kind: 'builtin', status: 'published', version: t.version, draftVersion: null, basedOn: t.basedOn ?? null,
				isAuthDefault: authDefault === id, clientIds: clientsOf(id), updatedAt: null, updatedBy: null, publishedAt: null,
			};
		});
		const customs: ThemeSummary[] = rows.map((r) => ({
			id: r.id,
			name: { en: r.name_en, ar: r.name_ar },
			kind: 'custom',
			status: !r.published_key ? 'draft' : r.draft_key && r.draft_key !== r.published_key ? 'changed' : 'published',
			version: r.published_version,
			draftVersion: r.draft_version,
			basedOn: null,
			isAuthDefault: authDefault === r.id,
			clientIds: clientsOf(r.id),
			updatedAt: r.updated_at,
			updatedBy: r.updated_by,
			publishedAt: r.published_at,
		}));
		return { themes: [...builtins, ...customs], authDefault, clientDefaults: settings.clientDefaults };
	}

	async summary(id: string): Promise<ThemeSummary> {
		const found = (await this.list()).themes.find((t) => t.id === id);
		if (!found) throw new ThemeError(404, 'not_found', 'Theme not found');
		return found;
	}

	private async assertNewId(id: string) {
		if (!ID.test(id)) throw new ThemeError(400, 'invalid_id', 'Theme ids are 2–40 lowercase letters, digits and dashes, starting with a letter');
		if (this.store.isBuiltin(id) || (await this.store.rawRow(id))) throw new ThemeError(409, 'id_taken', `A theme with id "${id}" already exists (or is in Recently deleted)`);
	}

	async duplicate(actor: Actor, sourceId: string, newId: string, name: Localized): Promise<ThemeSummary> {
		await this.assertNewId(newId);
		const source = await this.packageOf(sourceId);
		const theme = duplicatePackage(source.theme, newId, name, AUTHOR) as AuthThemeJson;
		const key = await this.store.putPackage({ theme: this.validate(theme, source.assets, 'draft').theme, assets: source.assets });
		await this.store.insertRow({ id: newId, name_en: name.en, name_ar: name.ar, draft_key: key, draft_version: theme.version }, actor.userId);
		await audit(actor, AuditEventType.THEME_CREATED, { theme_id: newId, duplicated_from: sourceId });
		return this.summary(newId);
	}

	async saveDraft(actor: Actor, id: string, themeJson: unknown): Promise<ThemeSummary & { contrast: Issue[] }> {
		const row = await this.customRow(id);
		const current = await this.draftOf(row);
		if (!themeJson || typeof themeJson !== 'object') throw new ThemeError(400, 'invalid_theme', 'theme.json must be an object');
		const { $schema: _schema, ...rest } = themeJson as AuthThemeJson;
		const theme = { ...rest, id, kind: 'custom' as const };
		const { contrast } = this.validate(theme, current.assets, 'draft');
		const key = await this.store.putPackage({ theme, assets: current.assets });
		await this.store.saveDraft(id, theme.name, key, theme.version, actor.userId);
		await audit(actor, AuditEventType.THEME_DRAFT_SAVED, { theme_id: id, version: theme.version });
		return { ...(await this.summary(id)), contrast };
	}

	private async prepareAsset(path: string, data: Uint8Array): Promise<{ data: Uint8Array; type: string }> {
		if (path.length > 160) throw new ThemeError(400, 'invalid_path', 'Asset paths look like assets/name.png');
		const type = assetTypeFor(path);
		if (!type) throw new ThemeError(400, 'invalid_type', 'Allowed files: assets/….svg, .png, .jpg, .webp, .ico, and .woff2 under assets/fonts/');
		if (data.length > MAX_ASSET_BYTES) throw new ThemeError(413, 'too_large', 'Each file can be at most 2 MB');
		if (type === 'image/svg+xml') {
			const clean = sanitizeSvg(new TextDecoder().decode(data));
			const problem = clean ? svgProblem(clean) : 'has no <svg> element';
			if (!clean || problem) throw new ThemeError(400, 'invalid_svg', `The SVG ${problem}`);
			return { data: new TextEncoder().encode(clean), type };
		}
		if (sniff(data) !== SNIFFED[type]) throw new ThemeError(400, 'invalid_type', `${path} is not a real .${path.split('.').pop()} file`);
		return { data, type };
	}

	async uploadAsset(actor: Actor, id: string, path: string, bytes: Uint8Array): Promise<{ path: string; hash: string; type: string; size: number }> {
		const row = await this.customRow(id);
		const current = await this.draftOf(row);
		const { data, type } = await this.prepareAsset(path, bytes);
		const total = Object.entries(current.assets).filter(([p]) => p !== path).reduce((n, [, a]) => n + a.size, 0) + data.length;
		if (total > MAX_PACKAGE_BYTES) throw new ThemeError(413, 'package_too_large', 'A theme package can be at most 12 MB');
		const hash = await this.store.putAsset(data, type);
		const pkg: StoredPackage = { theme: current.theme, assets: { ...current.assets, [path]: { hash, type, size: data.length } } };
		const key = await this.store.putPackage(pkg);
		await this.store.saveDraft(id, current.theme.name, key, current.theme.version, actor.userId);
		await audit(actor, AuditEventType.THEME_ASSET_UPLOADED, { theme_id: id, path, size: data.length, type });
		return { path, hash, type, size: data.length };
	}

	async removeAsset(actor: Actor, id: string, path: string): Promise<void> {
		const row = await this.customRow(id);
		const current = await this.draftOf(row);
		if (!current.assets[path]) throw new ThemeError(404, 'not_found', 'No such file in the theme');
		if (referencedAssets(current.theme).has(path)) throw new ThemeError(409, 'in_use', `${path} is still used by the theme; change that setting first`);
		const assets = { ...current.assets };
		delete assets[path];
		const key = await this.store.putPackage({ theme: current.theme, assets });
		await this.store.saveDraft(id, current.theme.name, key, current.theme.version, actor.userId);
		await audit(actor, AuditEventType.THEME_ASSET_REMOVED, { theme_id: id, path });
	}

	async publish(actor: Actor, id: string): Promise<ThemeSummary> {
		const row = await this.customRow(id);
		let pkg = await this.draftOf(row);
		this.validate(pkg.theme, pkg.assets, 'publish');
		let key = row.draft_key ?? row.published_key!;
		if (row.published_key && key !== row.published_key && row.published_version && newer(pkg.theme.version, row.published_version) <= 0) {
			// A published version never changes: new content gets the next version
			pkg = { ...pkg, theme: { ...pkg.theme, version: nextVersion([row.published_version, pkg.theme.version]) } };
			key = await this.store.putPackage(pkg);
		}
		await this.store.publish(id, key, pkg.theme.version, actor.userId);
		invalidateThemeSettings();
		await audit(actor, AuditEventType.THEME_PUBLISHED, { theme_id: id, version: pkg.theme.version }, AuditEventSeverity.WARNING);
		return this.summary(id);
	}

	private async assertPublished(id: string) {
		if (this.store.isBuiltin(id)) return;
		const row = await this.store.getRow(id);
		if (!row) throw new ThemeError(404, 'not_found', 'Theme not found');
		if (!row.published_key) throw new ThemeError(409, 'not_published', 'Publish the theme first');
	}

	async setAuthDefault(actor: Actor, id: string): Promise<void> {
		await this.assertPublished(id);
		const previous = (await this.store.settings()).authDefault ?? BUILTIN_DEFAULT_THEME;
		await this.store.setAuthDefault(id, actor.userId);
		invalidateThemeSettings();
		await audit(actor, AuditEventType.THEME_DEFAULT_SET, { theme_id: id, previous }, AuditEventSeverity.WARNING);
	}

	async setClientDefault(actor: Actor, clientId: string, id: string | null): Promise<void> {
		if (!(await this.store.clientExists(clientId))) throw new ThemeError(404, 'client_not_found', 'No such OAuth client');
		if (id !== null) await this.assertPublished(id);
		const previous = (await this.store.settings()).clientDefaults[clientId] ?? null;
		await this.store.setClientDefault(clientId, id, actor.userId);
		invalidateThemeSettings();
		await audit(actor, AuditEventType.THEME_CLIENT_DEFAULT_SET, { client_id: clientId, theme_id: id, previous }, AuditEventSeverity.WARNING);
	}

	/**
	 * Checks a theme may be deleted (deletions/kinds.ts records the deletion; the
	 * cleanup removes it later). Returns its row.
	 */
	async assertRemovable(id: string): Promise<ThemeRow> {
		const row = await this.customRow(id);
		const settings = await this.store.settings();
		if ((settings.authDefault ?? BUILTIN_DEFAULT_THEME) === id) throw new ThemeError(409, 'in_use', 'This theme is the Auth default; choose another default first');
		const clients = Object.entries(settings.clientDefaults).filter(([, t]) => t === id).map(([c]) => c);
		if (clients.length) throw new ThemeError(409, 'in_use', `This theme is the default for ${clients.length} app(s); change those first`);
		return row;
	}

	async exportZip(id: string, source: 'draft' | 'published' = 'draft'): Promise<{ filename: string; data: Uint8Array }> {
		const pkg = await this.packageOf(id, source);
		const assets: Record<string, Uint8Array> = {};
		for (const [path, a] of Object.entries(pkg.assets)) {
			const asset = await this.store.getAsset(a.hash);
			if (!asset) throw new ThemeError(500, 'missing_asset', `${path} is missing from storage`);
			assets[path] = asset.data;
		}
		const theme = { $schema: (SCHEMA as { $id: string }).$id, ...pkg.theme };
		return { filename: `${id}-${pkg.theme.version}.zip`, data: packageToZip({ theme, assets }) };
	}

	async importZip(actor: Actor, zip: Uint8Array, opts: { id?: string; replace?: boolean }): Promise<ThemeSummary> {
		let files: PackageFiles;
		try {
			files = await zipToPackage(zip);
		} catch (error) {
			throw new ThemeError(400, 'invalid_zip', error instanceof Error ? error.message : 'Not a theme package');
		}
		if (!files.theme || typeof files.theme !== 'object') throw new ThemeError(400, 'invalid_theme', 'theme.json must be an object');
		const raw = files.theme as AuthThemeJson;
		const id = opts.id ?? raw.id;
		if (typeof id !== 'string' || !ID.test(id)) throw new ThemeError(400, 'invalid_id', 'Theme ids are 2–40 lowercase letters, digits and dashes, starting with a letter');
		if (!(await this.store.getRow(id)) && (await this.store.rawRow(id))) {
			throw new ThemeError(409, 'id_taken', `A theme with id "${id}" is in Recently deleted; restore it or import under another id`);
		}
		const existing = await this.store.getRow(id);
		if (this.store.isBuiltin(id) || (existing && !opts.replace)) {
			throw new ThemeError(409, 'id_taken', `A theme with id "${id}" already exists; import it under another id or replace it`);
		}
		let total = 0;
		const prepared: Record<string, { data: Uint8Array; type: string }> = {};
		for (const [path, data] of Object.entries(files.assets)) {
			const asset = await this.prepareAsset(path, data);
			total += asset.data.length;
			prepared[path] = asset;
		}
		if (total > MAX_PACKAGE_BYTES) throw new ThemeError(413, 'package_too_large', 'A theme package can be at most 12 MB');
		const { $schema: _schema, ...rest } = raw;
		const bytes = Object.fromEntries(Object.entries(prepared).map(([p, a]) => [p, a.data]));
		const { theme } = this.validate({ ...rest, id, kind: 'custom' }, {}, 'draft', bytes);
		const assets: StoredPackage['assets'] = {};
		for (const [path, a] of Object.entries(prepared)) assets[path] = { hash: await this.store.putAsset(a.data, a.type), type: a.type, size: a.data.length };
		const key = await this.store.putPackage({ theme, assets });
		if (existing) {
			await this.store.saveDraft(id, theme.name, key, theme.version, actor.userId);
		} else {
			await this.store.insertRow({ id, name_en: theme.name.en, name_ar: theme.name.ar, draft_key: key, draft_version: theme.version }, actor.userId);
		}
		await audit(actor, AuditEventType.THEME_IMPORTED, { theme_id: id, replaced: !!existing, files: Object.keys(prepared).length });
		return this.summary(id);
	}
}
