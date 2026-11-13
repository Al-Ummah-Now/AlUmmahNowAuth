/**
 * Staff passkey policy (AUTH-PASSKEYS, decisions PK3/PK8).
 *
 * Staff = any role in STAFF_ROLES. The admin-managed setting
 * `auth_settings['staff_passkeys']` switches enforcement on. While it is on,
 * staff tokens carry `properties.passkey_deadline` (epoch seconds): from that
 * time on, consumers (auth admin, admin-api/admin-web, CMS admin) refuse a
 * staff token whose `amr` lacks `passkey`.
 *
 * Deadline: staff whose staff role was assigned before enforcement was switched
 * on get `graceDays` (7); anyone made staff later has none (deadline =
 * enforcedAt, already past).
 */
import { getSetting, putSetting } from './store';

export const STAFF_PASSKEYS_SETTING = 'staff_passkeys';
export const DEFAULT_GRACE_DAYS = 7;

/** Normalised staff role names (lower-case, spaces → `_`). */
export const STAFF_ROLES = ['super_admin', 'admin', 'moderator', 'writer', 'content_reviewer', 'senior_reviewer'] as const;

export function normaliseRole(name: string): string {
	return name.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function isStaffRole(name: string): boolean {
	return (STAFF_ROLES as readonly string[]).includes(normaliseRole(name));
}

export function isStaff(roles: readonly string[] | undefined | null): boolean {
	return !!roles && roles.some((r) => typeof r === 'string' && isStaffRole(r));
}

export interface StaffPasskeySetting {
	enforced: boolean;
	/** epoch ms */
	enforcedAt: number | null;
	graceDays: number;
}

export const SETTING_OFF: StaffPasskeySetting = { enforced: false, enforcedAt: null, graceDays: DEFAULT_GRACE_DAYS };

let cached: { at: number; value: StaffPasskeySetting } | null = null;
const CACHE_MS = 30_000;

/** The setting (cached 30 s per isolate; every refresh reads it). */
export async function readStaffPasskeySetting(db: D1Database, now = Date.now()): Promise<StaffPasskeySetting> {
	if (cached && now - cached.at < CACHE_MS) return cached.value;
	const raw = await getSetting<Partial<StaffPasskeySetting>>(db, STAFF_PASSKEYS_SETTING);
	const value: StaffPasskeySetting = raw
		? {
				enforced: raw.enforced === true,
				enforcedAt: typeof raw.enforcedAt === 'number' ? raw.enforcedAt : null,
				graceDays: typeof raw.graceDays === 'number' && raw.graceDays >= 0 && raw.graceDays <= 30 ? raw.graceDays : DEFAULT_GRACE_DAYS,
			}
		: SETTING_OFF;
	cached = { at: now, value };
	return value;
}

export async function writeStaffPasskeySetting(db: D1Database, value: StaffPasskeySetting, updatedBy: string): Promise<void> {
	await putSetting(db, STAFF_PASSKEYS_SETTING, value, updatedBy);
	cached = null;
}

/** Tests only. */
export function clearPolicyCache(): void {
	cached = null;
}

/** The user's current role names, by user id (indexed). */
export async function userRoleNames(db: D1Database, userId: string): Promise<string[]> {
	const { results } = await db
		.prepare(`SELECT r.name AS name FROM rbac_user_roles ur JOIN rbac_roles r ON r.id = ur.role_id WHERE ur.user_id = ?1`)
		.bind(userId)
		.all<{ name: string }>();
	return (results ?? []).map((r) => r.name);
}

/** When each of the user's staff roles was assigned (ms), by user id (indexed). */
export async function staffRoleAssignedAt(db: D1Database, userId: string): Promise<number | null> {
	const { results } = await db
		.prepare(
			`SELECT r.name AS name, ur.assigned_at AS assigned_at
			 FROM rbac_user_roles ur JOIN rbac_roles r ON r.id = ur.role_id
			 WHERE ur.user_id = ?1`
		)
		.bind(userId)
		.all<{ name: string; assigned_at: number }>();
	let earliest: number | null = null;
	for (const row of results ?? []) {
		if (!isStaffRole(row.name)) continue;
		const at = row.assigned_at < 1e12 ? row.assigned_at * 1000 : row.assigned_at;
		if (earliest === null || at < earliest) earliest = at;
	}
	return earliest;
}

/**
 * `passkey_deadline` (epoch seconds) for a user with these roles, or
 * undefined (not staff, or enforcement off).
 */
export function deadlineFor(setting: StaffPasskeySetting, staffSince: number | null, roles: readonly string[]): number | undefined {
	if (!setting.enforced || !setting.enforcedAt || !isStaff(roles)) return undefined;
	const graceEnd = setting.enforcedAt + setting.graceDays * 24 * 60 * 60 * 1000;
	const existingStaff = staffSince !== null && staffSince < setting.enforcedAt;
	return Math.floor((existingStaff ? graceEnd : setting.enforcedAt) / 1000);
}

/** The deadline for a user, read from D1 only when it can apply. */
export async function passkeyDeadline(db: D1Database, userId: string, roles: readonly string[]): Promise<number | undefined> {
	if (!isStaff(roles)) return undefined;
	const setting = await readStaffPasskeySetting(db);
	if (!setting.enforced) return undefined;
	return deadlineFor(setting, await staffRoleAssignedAt(db, userId), roles);
}

/** Consumer rule (also used by Auth's own admin): is staff access blocked right now? */
export function passkeyBlocked(claims: { amr?: unknown; properties?: { passkey_deadline?: unknown; roles?: unknown } }, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
	const deadline = claims.properties?.passkey_deadline;
	if (typeof deadline !== 'number') return false;
	const roles = Array.isArray(claims.properties?.roles) ? (claims.properties!.roles as string[]) : [];
	if (!isStaff(roles)) return false;
	const amr = Array.isArray(claims.amr) ? claims.amr : [];
	if (amr.includes('passkey')) return false;
	return nowSeconds >= deadline;
}
