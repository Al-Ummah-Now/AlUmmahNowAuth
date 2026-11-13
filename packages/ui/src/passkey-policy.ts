/**
 * Staff passkey rules shared by Auth (issuer) and the Auth admin
 * (AUTH-PASSKEYS, AlUmmahNowWiki). The same contract is implemented by
 * AlUmmahNow admin-api/admin-web and the CMS admin.
 *
 * Token claims: top-level `amr` (RFC 8176: pwd, otp, passkey, fed) and
 * `auth_time` (epoch s); `properties.passkey_deadline` (epoch s) only for staff
 * while staff enforcement is on.
 */

/** Normalised staff role names (lower-case, spaces → `_`). */
export const STAFF_ROLES = ['super_admin', 'admin', 'moderator', 'writer', 'content_reviewer', 'senior_reviewer'] as const;

/** Step-up window for high-risk admin actions (AD5): 15 minutes. */
export const STEP_UP_MAX_AGE_SECONDS = 900;

export function normaliseRole(name: string): string {
	return name.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function isStaffRole(name: string): boolean {
	return (STAFF_ROLES as readonly string[]).includes(normaliseRole(name));
}

export function isStaff(roles: readonly string[] | undefined | null): boolean {
	return !!roles && roles.some((r) => typeof r === 'string' && isStaffRole(r));
}

export interface PasskeyClaims {
	amr?: unknown;
	auth_time?: unknown;
	properties?: { passkey_deadline?: unknown; roles?: unknown };
}

function amrOf(claims: PasskeyClaims): string[] {
	return Array.isArray(claims.amr) ? claims.amr.filter((m): m is string => typeof m === 'string') : [];
}

/** The deadline that applies to this staff token without a passkey sign-in, else undefined. */
export function pendingPasskeyDeadline(claims: PasskeyClaims): number | undefined {
	const deadline = claims.properties?.passkey_deadline;
	if (typeof deadline !== 'number') return undefined;
	const roles = Array.isArray(claims.properties?.roles) ? (claims.properties!.roles as string[]) : [];
	if (!isStaff(roles)) return undefined;
	if (amrOf(claims).includes('passkey')) return undefined;
	return deadline;
}

/** Consumer rule: staff access is refused ("Passkey needed" page). */
export function passkeyBlocked(claims: PasskeyClaims, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
	const deadline = pendingPasskeyDeadline(claims);
	return deadline !== undefined && nowSeconds >= deadline;
}

/** Grace: staff access, with a banner "Add a passkey by <date>". The deadline, else undefined. */
export function passkeyGraceUntil(claims: PasskeyClaims, nowSeconds = Math.floor(Date.now() / 1000)): number | undefined {
	const deadline = pendingPasskeyDeadline(claims);
	return deadline !== undefined && nowSeconds < deadline ? deadline : undefined;
}

/** Step-up for high-risk actions: a real sign-in within 15 minutes (with a passkey once it is required). */
export function stepUpNeeded(claims: PasskeyClaims, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
	const authTime = typeof claims.auth_time === 'number' ? claims.auth_time : 0;
	if (nowSeconds - authTime > STEP_UP_MAX_AGE_SECONDS) return true;
	return passkeyBlocked(claims, nowSeconds);
}
