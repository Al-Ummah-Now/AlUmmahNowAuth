/**
 * Passkey storage in Auth D1 (migration 0036, AUTH-PASSKEYS).
 *
 * Every query is by key: credential `id`, `user_id` (indexed), ticket
 * `token_hash` or setting `key`. Never a scan: a full scan on Auth D1 blocks
 * every sign-in.
 */
import type { PasskeyCredential, RegisteredPasskey } from '@al-ummah-now/openauth/passkey';

/** PK6: passkeys per account. */
export const MAX_PASSKEYS = 10;
/** Removed passkeys stay restorable this long in the hub (Undo), then purge. */
export const PASSKEY_RESTORE_MS = 30 * 24 * 60 * 60 * 1000;

export interface PasskeyRow {
	id: string;
	user_id: string;
	public_key: string;
	counter: number;
	transports: string | null;
	device_type: string;
	backed_up: number;
	aaguid: string | null;
	name: string;
	created_at: number;
	last_used_at: number | null;
	deleted_at: number | null;
}

/** What the hub and the admin show (never the public key). */
export interface PasskeySummary {
	id: string;
	name: string;
	synced: boolean;
	deviceType: string;
	createdAt: number;
	lastUsedAt: number | null;
}

export function summaryOf(row: PasskeyRow): PasskeySummary {
	return {
		id: row.id,
		name: row.name,
		synced: row.device_type === 'multiDevice' || row.backed_up === 1,
		deviceType: row.device_type,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
	};
}

const COLUMNS = 'id, user_id, public_key, counter, transports, device_type, backed_up, aaguid, name, created_at, last_used_at, deleted_at';

/** A live passkey by credential id, as the sign-in provider needs it. */
export async function getCredential(db: D1Database, id: string): Promise<(PasskeyCredential & { row: PasskeyRow }) | undefined> {
	const row = await db.prepare(`SELECT ${COLUMNS} FROM webauthn_credentials WHERE id = ?1 AND deleted_at IS NULL`).bind(id).first<PasskeyRow>();
	if (!row) return undefined;
	return {
		id: row.id,
		userID: row.user_id,
		publicKey: row.public_key,
		counter: row.counter,
		transports: parseTransports(row.transports),
		row,
	};
}

function parseTransports(raw: string | null): string[] | undefined {
	if (!raw) return undefined;
	try {
		const list = JSON.parse(raw);
		return Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string') : undefined;
	} catch {
		return undefined;
	}
}

/** After a sign-in: the new counter and last use. */
export async function touchCredential(db: D1Database, id: string, counter: number, now = Date.now()): Promise<void> {
	await db.prepare(`UPDATE webauthn_credentials SET counter = ?2, last_used_at = ?3 WHERE id = ?1`).bind(id, counter, now).run();
}

/** One user's passkeys (live, or also the removed ones still restorable). At most MAX_PASSKEYS + removed. */
export async function listForUser(db: D1Database, userId: string, opts: { includeRemoved?: boolean } = {}): Promise<PasskeyRow[]> {
	const sql = opts.includeRemoved
		? `SELECT ${COLUMNS} FROM webauthn_credentials WHERE user_id = ?1 ORDER BY created_at ASC LIMIT 50`
		: `SELECT ${COLUMNS} FROM webauthn_credentials WHERE user_id = ?1 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 50`;
	const { results } = await db.prepare(sql).bind(userId).all<PasskeyRow>();
	return results ?? [];
}

export async function countForUser(db: D1Database, userId: string): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?1 AND deleted_at IS NULL`)
		.bind(userId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** Default name: the platform the browser reports, else "Passkey". */
export function defaultPasskeyName(userAgent: string | null, synced: boolean): string {
	const ua = userAgent ?? '';
	const platform = /iPhone|iPad|iPod/.test(ua)
		? 'iPhone or iPad'
		: /Macintosh|Mac OS X/.test(ua)
			? 'Mac'
			: /Android/.test(ua)
				? 'Android'
				: /Windows/.test(ua)
					? 'Windows'
					: /CrOS/.test(ua)
						? 'Chromebook'
						: /Linux/.test(ua)
							? 'Linux'
							: '';
	if (!platform) return synced ? 'Synced passkey' : 'Passkey';
	return `Passkey on ${platform}`;
}

export async function insertCredential(
	db: D1Database,
	userId: string,
	reg: RegisteredPasskey,
	name: string,
	now = Date.now()
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports, device_type, backed_up, aaguid, name, created_at, last_used_at, deleted_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL)`
		)
		.bind(reg.id, userId, reg.publicKey, reg.counter, JSON.stringify(reg.transports ?? []), reg.deviceType, reg.backedUp ? 1 : 0, reg.aaguid || null, name, now)
		.run();
}

export function cleanPasskeyName(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	// No control characters; at most 64 characters
	const name = [...raw]
		.filter((ch) => {
			const code = ch.charCodeAt(0);
			return code >= 0x20 && code !== 0x7f;
		})
		.join('')
		.trim()
		.slice(0, 64);
	return name || null;
}

export async function renameCredential(db: D1Database, userId: string, id: string, name: string): Promise<boolean> {
	const r = await db
		.prepare(`UPDATE webauthn_credentials SET name = ?3 WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`)
		.bind(id, userId, name)
		.run();
	return (r.meta?.changes ?? 0) > 0;
}

/** Soft delete (Undo / 30-day restore). */
export async function removeCredential(db: D1Database, userId: string, id: string, now = Date.now()): Promise<boolean> {
	const r = await db
		.prepare(`UPDATE webauthn_credentials SET deleted_at = ?3 WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`)
		.bind(id, userId, now)
		.run();
	return (r.meta?.changes ?? 0) > 0;
}

export async function restoreCredential(db: D1Database, userId: string, id: string, now = Date.now()): Promise<boolean> {
	const r = await db
		.prepare(`UPDATE webauthn_credentials SET deleted_at = NULL WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NOT NULL AND deleted_at > ?3`)
		.bind(id, userId, now - PASSKEY_RESTORE_MS)
		.run();
	return (r.meta?.changes ?? 0) > 0;
}

/** A user's passkeys removed more than 30 days ago are deleted for good (by user, on their next change). */
export async function purgeRemovedForUser(db: D1Database, userId: string, now = Date.now()): Promise<void> {
	await db
		.prepare(`DELETE FROM webauthn_credentials WHERE user_id = ?1 AND deleted_at IS NOT NULL AND deleted_at <= ?2`)
		.bind(userId, now - PASSKEY_RESTORE_MS)
		.run();
}

/** Account erasure: every passkey of the user. */
export async function deleteAllForUser(db: D1Database, userId: string): Promise<void> {
	await db.batch([
		db.prepare(`DELETE FROM webauthn_credentials WHERE user_id = ?1`).bind(userId),
		db.prepare(`DELETE FROM webauthn_prompts WHERE user_id = ?1`).bind(userId),
		db.prepare(`DELETE FROM passkey_setup_tickets WHERE user_id = ?1`).bind(userId),
	]);
}

// ---------- PK1 "Not now" ----------

export const PROMPT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

export async function promptDismissedAt(db: D1Database, userId: string): Promise<number | null> {
	const row = await db.prepare(`SELECT dismissed_at FROM webauthn_prompts WHERE user_id = ?1`).bind(userId).first<{ dismissed_at: number }>();
	return row?.dismissed_at ?? null;
}

export async function dismissPrompt(db: D1Database, userId: string, now = Date.now()): Promise<void> {
	await db
		.prepare(`INSERT INTO webauthn_prompts (user_id, dismissed_at) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET dismissed_at = excluded.dismissed_at`)
		.bind(userId, now)
		.run();
}

// ---------- PK4 setup links ----------

export const SETUP_TICKET_TTL_MS = 24 * 60 * 60 * 1000;

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Creates a single-use setup link token for `userId`; returns the raw token (only its hash is stored). */
export async function createSetupTicket(db: D1Database, userId: string, createdBy: string, now = Date.now()): Promise<{ token: string; expiresAt: number }> {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	const expiresAt = now + SETUP_TICKET_TTL_MS;
	await db
		.prepare(`INSERT INTO passkey_setup_tickets (token_hash, user_id, created_by, created_at, expires_at, used_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL)`)
		.bind(await sha256Hex(token), userId, createdBy, now, expiresAt)
		.run();
	return { token, expiresAt };
}

/** The user a live (unused, unexpired) ticket belongs to, without using it. */
export async function peekSetupTicket(db: D1Database, token: string, now = Date.now()): Promise<string | null> {
	const row = await db
		.prepare(`SELECT user_id FROM passkey_setup_tickets WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2`)
		.bind(await sha256Hex(token), now)
		.first<{ user_id: string }>();
	return row?.user_id ?? null;
}

/** Uses a ticket for `userId`: true only for the one request that flips it. */
export async function useSetupTicket(db: D1Database, token: string, userId: string, now = Date.now()): Promise<boolean> {
	const row = await db
		.prepare(
			`UPDATE passkey_setup_tickets SET used_at = ?3 WHERE token_hash = ?1 AND user_id = ?2 AND used_at IS NULL AND expires_at > ?3 RETURNING user_id`
		)
		.bind(await sha256Hex(token), userId, now)
		.first();
	return !!row;
}

// ---------- settings ----------

export async function getSetting<T>(db: D1Database, key: string): Promise<T | null> {
	const row = await db.prepare(`SELECT value FROM auth_settings WHERE key = ?1`).bind(key).first<{ value: string }>();
	if (!row) return null;
	try {
		return JSON.parse(row.value) as T;
	} catch {
		return null;
	}
}

export async function putSetting(db: D1Database, key: string, value: unknown, updatedBy: string | null, now = Date.now()): Promise<void> {
	await db
		.prepare(
			`INSERT INTO auth_settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
		)
		.bind(key, JSON.stringify(value), now, updatedBy)
		.run();
}
