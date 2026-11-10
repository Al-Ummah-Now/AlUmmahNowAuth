/**
 * Where Auth's themes live: D1 holds one row per custom theme (which package
 * is the draft, which is published), the Auth default and each client's
 * default; AUTH_THEMES KV holds packages and asset files under their content
 * hash, so a key is written once and never changes (no stale reads).
 */
import { BUILTIN_IDS, blobBytes, builtinBlob, builtinPackage } from '../../../../packages/ui/src/auth-theme/builtin.ts';
import { sha256Hex } from '../../../../packages/ui/src/auth-theme/package.ts';
import type { StoredPackage } from '../../../../packages/ui/src/auth-theme/types.ts';
import { deletedClause } from '../deletions/store';

/** Themes an admin deleted (admin_deletions) are left out everywhere until restored. */
const LIVE = `NOT EXISTS (${deletedClause('theme', 'auth_themes.id')})`;

export interface ThemeRow {
	id: string;
	name_en: string;
	name_ar: string;
	draft_key: string | null;
	draft_version: string | null;
	published_key: string | null;
	published_version: string | null;
	published_at: number | null;
	created_at: number;
	created_by: string | null;
	updated_at: number;
	updated_by: string | null;
}

export interface ThemeSettings {
	authDefault: string | null;
	clientDefaults: Record<string, string>;
	/** Published custom themes: id → package key. */
	published: Record<string, string>;
}

export const DEFAULT_THEME_KEY = 'default_theme';

export class ThemeStoreUnavailable extends Error {
	constructor() {
		super('Theme storage is not configured');
	}
}

export class ThemeStore {
	constructor(private db: D1Database, private kv: KVNamespace | undefined) {}

	private get blobs(): KVNamespace {
		if (!this.kv) throw new ThemeStoreUnavailable();
		return this.kv;
	}

	isBuiltin(id: string): boolean {
		return BUILTIN_IDS.includes(id);
	}

	async listRows(): Promise<ThemeRow[]> {
		const { results } = await this.db.prepare(`SELECT * FROM auth_themes WHERE ${LIVE} ORDER BY created_at`).all<ThemeRow>();
		return results ?? [];
	}

	/** A theme that is not deleted. */
	async getRow(id: string): Promise<ThemeRow | null> {
		return this.db.prepare(`SELECT * FROM auth_themes WHERE id = ? AND ${LIVE}`).bind(id).first<ThemeRow>();
	}

	/** The row whether or not it is deleted (its id stays taken until the cleanup removes it). */
	async rawRow(id: string): Promise<ThemeRow | null> {
		return this.db.prepare('SELECT * FROM auth_themes WHERE id = ?').bind(id).first<ThemeRow>();
	}

	async settings(): Promise<ThemeSettings> {
		const [def, clients, published] = await this.db.batch([
			this.db.prepare('SELECT value FROM auth_theme_settings WHERE key = ?').bind(DEFAULT_THEME_KEY),
			this.db.prepare('SELECT client_id, theme_id FROM auth_theme_client_defaults'),
			this.db.prepare(`SELECT id, published_key FROM auth_themes WHERE published_key IS NOT NULL AND ${LIVE}`),
		]);
		return {
			authDefault: (def.results?.[0] as { value?: string } | undefined)?.value ?? null,
			clientDefaults: Object.fromEntries((clients.results as { client_id: string; theme_id: string }[]).map((r) => [r.client_id, r.theme_id])),
			published: Object.fromEntries((published.results as { id: string; published_key: string }[]).map((r) => [r.id, r.published_key])),
		};
	}

	/** Stores a package; returns its key. */
	async putPackage(pkg: StoredPackage): Promise<string> {
		const json = JSON.stringify(pkg);
		const key = `pkg:${await sha256Hex(json)}`;
		await this.blobs.put(key, json);
		return key;
	}

	async getPackage(key: string): Promise<StoredPackage | null> {
		return (await this.blobs.get(key, 'json')) as StoredPackage | null;
	}

	/** Stores a file; returns its content hash. */
	async putAsset(data: Uint8Array, type: string): Promise<string> {
		const hash = await sha256Hex(data);
		if (!builtinBlob(hash)) await this.blobs.put(`asset:${hash}`, data, { metadata: { type } });
		return hash;
	}

	async getAsset(hash: string): Promise<{ data: Uint8Array; type: string } | null> {
		const builtin = builtinBlob(hash);
		if (builtin) return { data: blobBytes(builtin), type: builtin.type };
		if (!this.kv) return null;
		const { value, metadata } = await this.kv.getWithMetadata<{ type?: string }>(`asset:${hash}`, 'arrayBuffer');
		return value ? { data: new Uint8Array(value), type: metadata?.type ?? 'application/octet-stream' } : null;
	}

	async getAssetText(hash: string): Promise<string | null> {
		const a = await this.getAsset(hash);
		return a ? new TextDecoder().decode(a.data) : null;
	}

	async insertRow(row: Pick<ThemeRow, 'id' | 'name_en' | 'name_ar' | 'draft_key' | 'draft_version'>, by: string): Promise<void> {
		const now = Date.now();
		await this.db
			.prepare(
				'INSERT INTO auth_themes (id, name_en, name_ar, draft_key, draft_version, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
			)
			.bind(row.id, row.name_en, row.name_ar, row.draft_key, row.draft_version, now, by, now, by)
			.run();
	}

	async saveDraft(id: string, name: { en: string; ar: string }, key: string, version: string, by: string): Promise<void> {
		await this.db
			.prepare('UPDATE auth_themes SET name_en = ?, name_ar = ?, draft_key = ?, draft_version = ?, updated_at = ?, updated_by = ? WHERE id = ?')
			.bind(name.en, name.ar, key, version, Date.now(), by, id)
			.run();
	}

	async publish(id: string, key: string, version: string, by: string): Promise<void> {
		const now = Date.now();
		await this.db
			.prepare(
				'UPDATE auth_themes SET draft_key = ?, draft_version = ?, published_key = ?, published_version = ?, published_at = ?, updated_at = ?, updated_by = ? WHERE id = ?'
			)
			.bind(key, version, key, version, now, now, by, id)
			.run();
	}

	/**
	 * Removes a deleted theme for good (only the cleanup calls this): the row,
	 * then its packages and asset files that no other theme's current packages
	 * use (keys are content hashes, so themes can share them).
	 */
	async purgeRow(id: string): Promise<{ packages: number; assets: number } | null> {
		const row = await this.rawRow(id);
		if (!row) return null;
		const keys = [...new Set([row.draft_key, row.published_key].filter((k): k is string => !!k))];
		const packages = this.kv ? (await Promise.all(keys.map((k) => this.getPackage(k)))).filter((p): p is StoredPackage => !!p) : [];
		await this.db.prepare('DELETE FROM auth_themes WHERE id = ?').bind(id).run();
		if (!this.kv) return { packages: 0, assets: 0 };

		const { results: others } = await this.db
			.prepare('SELECT draft_key, published_key FROM auth_themes WHERE id != ?')
			.bind(id)
			.all<Pick<ThemeRow, 'draft_key' | 'published_key'>>();
		const otherKeys = new Set((others ?? []).flatMap((r) => [r.draft_key, r.published_key]).filter((k): k is string => !!k));
		const otherHashes = new Set<string>();
		for (const key of otherKeys) {
			const pkg = await this.getPackage(key);
			for (const a of Object.values(pkg?.assets ?? {})) otherHashes.add(a.hash);
		}
		let removedPackages = 0;
		let removedAssets = 0;
		for (const key of keys) {
			if (otherKeys.has(key)) continue;
			await this.kv.delete(key);
			removedPackages++;
		}
		const hashes = new Set(packages.flatMap((p) => Object.values(p.assets).map((a) => a.hash)));
		for (const hash of hashes) {
			if (otherHashes.has(hash) || builtinBlob(hash)) continue;
			await this.kv.delete(`asset:${hash}`);
			removedAssets++;
		}
		return { packages: removedPackages, assets: removedAssets };
	}

	async setAuthDefault(themeId: string, by: string): Promise<void> {
		await this.db
			.prepare(
				'INSERT INTO auth_theme_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by'
			)
			.bind(DEFAULT_THEME_KEY, themeId, Date.now(), by)
			.run();
	}

	async setClientDefault(clientId: string, themeId: string | null, by: string): Promise<void> {
		if (themeId === null) {
			await this.db.prepare('DELETE FROM auth_theme_client_defaults WHERE client_id = ?').bind(clientId).run();
			return;
		}
		await this.db
			.prepare(
				'INSERT INTO auth_theme_client_defaults (client_id, theme_id, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET theme_id = excluded.theme_id, updated_at = excluded.updated_at, updated_by = excluded.updated_by'
			)
			.bind(clientId, themeId, Date.now(), by)
			.run();
	}

	async clientExists(clientId: string): Promise<boolean> {
		return !!(await this.db.prepare(`SELECT 1 FROM oauth_clients WHERE id = ? AND NOT EXISTS (${deletedClause('client', 'oauth_clients.id')})`).bind(clientId).first());
	}

	/** A built-in package in the stored shape. */
	builtin(id: string) {
		return builtinPackage(id);
	}
}
