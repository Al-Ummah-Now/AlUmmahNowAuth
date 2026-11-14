/**
 * System accounts (openauth user/system.ts): placeholder users such as
 * `user_system` (system@openauth.local) that only label automatic actions, e.g.
 * the `assigned_by` of the Member role every new account gets. Never people.
 *
 * - They never sign in, by any way in: every sign-in provider (password, email
 *   code, password reset, passkey, silent single sign-on, device), the code and
 *   device grants, token refresh, and acting as an admin (X-Acting-User-Id or a
 *   session). `metadata.type = "system"` or a SYSTEM_USER_IDS id.
 * - They never hold a role: refused by the admin APIs, by openauth's RBAC
 *   service, and by the D1 trigger of migrations/0041_system_accounts.sql.
 * - Admin lists hide exactly SYSTEM_USER_IDS, and the super admin's read-only
 *   "System accounts" view shows exactly those, so hiding one never hides a risk.
 * - Every refused attempt writes an audit event and raises a needs-action item
 *   on the admin Errors page (one per account and kind of attempt; an admin
 *   acknowledges it there, and a later attempt reopens it).
 */
import {
	SYSTEM_USER_ID,
	SYSTEM_USER_IDS,
	isSystemMetadata,
	isSystemUser,
	isSystemUserId,
} from '@al-ummah-now/openauth/user/system';
import { getAuditEmitter } from '../audit-emitter';
import { AuditEventSeverity, AuditEventType } from '../audit-events';
import { reportNeedsAction, type ErrorReportEnv } from '../errors/report';
import { logger } from '../logger';

export { SYSTEM_USER_ID, SYSTEM_USER_IDS, isSystemMetadata, isSystemUser, isSystemUserId };

/** SQL list of the system account ids, for `id IN (...)` / `id NOT IN (...)` (constants, never input). */
export const SYSTEM_USER_IDS_SQL = SYSTEM_USER_IDS.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');

/** What was tried on a system account. */
export type SystemAccountAttempt =
	/** A sign-in provider (password, email code, passkey, single sign-on, device), a code or a reset */
	| 'sign_in'
	/** The refresh grant */
	| 'token_refresh'
	/** Acting as an admin: M2M X-Acting-User-Id or an admin session */
	| 'acting_admin'
	/** Granting a role */
	| 'role_grant'
	/** Another admin change (edit, suspend, delete, sessions, forced reset) */
	| 'admin_change';

const TITLES: Record<SystemAccountAttempt, string> = {
	sign_in: 'Sign-in attempt on a system account',
	token_refresh: 'Token refresh attempt on a system account',
	acting_admin: 'Admin action attempted as a system account',
	role_grant: 'Role grant attempted on a system account',
	admin_change: 'Admin change attempted on a system account',
};

export interface SystemAccountAttemptInput {
	userId: string;
	attempt: SystemAccountAttempt;
	/** sign-in provider, route or role id: what exactly was tried (no emails, no secrets) */
	detail?: string;
	request?: Request;
	requestId?: string;
	/** Who tried, when known (an admin's id or an M2M client id) */
	actorId?: string;
}

export type SystemAccountEnv = ErrorReportEnv & { OPENAUTH_ISSUER?: string };

/** The Auth admin's System accounts view, for the Errors page item (https on alummahnow.net only). */
export function systemAccountsAdminUrl(issuer: string | undefined): string | undefined {
	try {
		const host = new URL(issuer ?? '').hostname;
		if (host !== 'alummahnow.net' && !host.endsWith('.alummahnow.net')) return undefined;
		return `https://admin.${host}/users?view=system`;
	} catch {
		return undefined;
	}
}

/**
 * Records a refused attempt on a system account: an audit event and a
 * needs-action item on the admin Errors page. Never throws, never delays the response.
 */
export function flagSystemAccountAttempt(
	env: SystemAccountEnv | undefined,
	ctx: { waitUntil(p: Promise<unknown>): void } | undefined,
	input: SystemAccountAttemptInput
): void {
	try {
		const { userId, attempt, detail, request, requestId, actorId } = input;
		logger.warn('[system-accounts] Refused an attempt on a system account', { userId, attempt, detail, actorId });
		const route = request ? new URL(request.url).pathname : undefined;
		const ip = request?.headers.get('CF-Connecting-IP') ?? null;
		const audit = getAuditEmitter()
			.emit({
				timestamp: new Date().toISOString(),
				eventType: attempt === 'role_grant' ? AuditEventType.SYSTEM_ACCOUNT_ROLE_REFUSED : AuditEventType.SYSTEM_ACCOUNT_SIGNIN_REFUSED,
				severity: AuditEventSeverity.WARNING,
				userId,
				ipAddress: ip,
				userAgent: request?.headers.get('User-Agent') ?? null,
				requestId: requestId ?? null,
				success: false,
				errorMessage: 'system_account',
				metadata: { attempt, detail: detail ?? null, actorId: actorId ?? null, route: route ?? null },
			})
			.catch(() => undefined);
		try {
			ctx?.waitUntil(audit);
		} catch {
			// outside a request: the promise still runs
		}
		reportNeedsAction(env ?? {}, ctx, {
			key: `auth-system-account:${attempt}:${userId}`,
			source: 'ops',
			title: TITLES[attempt],
			message: `${TITLES[attempt]} (${userId}${detail ? `, ${detail}` : ''}) was refused. System accounts cannot sign in or hold roles; check who tried.`,
			itemType: 'system-account',
			itemId: userId,
			itemUrl: systemAccountsAdminUrl(env?.OPENAUTH_ISSUER),
			route,
			method: request?.method,
			requestId,
			extra: { attempt, ...(detail ? { detail: detail.slice(0, 100) } : {}), ...(actorId ? { actor: actorId.slice(0, 100) } : {}) },
		});
	} catch {
		// never break the refusal itself
	}
}
