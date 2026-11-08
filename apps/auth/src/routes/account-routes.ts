/**
 * Self-service account endpoints (Epic 9.7): in-app account deletion and the
 * auth-side data export, required by App Store 5.1.1(v) and Google Play.
 *
 * - DELETE /account        delete the caller's account
 * - GET    /account/export the caller's auth data as a JSON download
 *
 * Both take the user's own access token (`Authorization: Bearer`), never an
 * admin or M2M token. Deletion also needs a recent sign-in: the token's
 * `auth_time` (when the user last authenticated, kept across refreshes) must
 * be at most REAUTH_MAX_AGE_SECONDS old, so a stolen long-lived session can't
 * delete the account. Otherwise 401 with the RFC 9470 step-up challenge; apps
 * re-run sign-in with `prompt=login` and retry.
 *
 * api-videos orchestrates the full deletion (content first, then this call).
 */
import { createLocalJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { createUserService, D1UserAdapter } from '@al-ummah-now/openauth';
import { getJWKS } from '../utils/jwks-cache';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import { getAuditEmitter } from '../audit-emitter';
import { AuditEventSeverity, AuditEventType, createAuditEvent } from '../audit-events';
import { logger } from '../logger';

export const REAUTH_MAX_AGE_SECONDS = 600;
const AUDIT_EXPORT_LIMIT = 1000;

interface UserTokenClaims extends JWTPayload {
	mode?: string;
	type?: string;
	client_id?: string;
	auth_time?: number;
	properties?: { id?: string; email?: string };
}

export interface VerifiedUser {
	userId: string;
	clientId?: string;
	authTime?: number;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
	});

const unauthorized = (description: string) =>
	json({ error: 'invalid_token', error_description: description }, 401, {
		'WWW-Authenticate': `Bearer error="invalid_token", error_description="${description}"`,
	});

/** The caller's own user access token, or the 401 to send. */
export async function verifyUserAccessToken(request: Request, env: Env): Promise<VerifiedUser | Response> {
	const header = request.headers.get('Authorization') ?? '';
	const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
	if (!token) return unauthorized('A user access token is required');
	let claims: UserTokenClaims;
	try {
		const jwks = createLocalJWKSet(await getJWKS(env));
		({ payload: claims } = await jwtVerify<UserTokenClaims>(token, jwks, {
			issuer: env.OPENAUTH_ISSUER || 'http://localhost:3301',
		}));
	} catch (error) {
		logger.warn('[account] Token verification failed', { error: String(error) });
		return unauthorized('The access token is invalid or expired');
	}
	// User access tokens only: no M2M (client_credentials) or admin service tokens
	if (claims.mode !== 'access' || claims.type !== 'user' || claims.client_id || !claims.properties?.id) {
		return unauthorized('A user access token is required');
	}
	return {
		userId: claims.properties.id,
		clientId: typeof claims.aud === 'string' ? claims.aud : undefined,
		authTime: typeof claims.auth_time === 'number' ? claims.auth_time : undefined,
	};
}

/** Null when the sign-in is recent enough; otherwise the step-up challenge (RFC 9470). */
export function requireRecentSignIn(user: VerifiedUser, now = Date.now()): Response | null {
	if (user.authTime !== undefined && now / 1000 - user.authTime <= REAUTH_MAX_AGE_SECONDS) return null;
	return json(
		{
			error: 'insufficient_user_authentication',
			error_description: 'Sign in again to delete your account',
			max_age: REAUTH_MAX_AGE_SECONDS,
		},
		401,
		{
			'WWW-Authenticate': `Bearer error="insufficient_user_authentication", error_description="A recent sign-in is required", max_age=${REAUTH_MAX_AGE_SECONDS}`,
		},
	);
}

interface UserRow {
	id: string;
	tenant_id: string;
	email: string;
	name: string | null;
	status: string;
	created_at: number;
	updated_at: number;
	last_login_at: number | null;
	deleted_at: number | null;
}

async function findUser(db: D1Database, userId: string): Promise<UserRow | null> {
	return db
		.prepare(
			'SELECT id, tenant_id, email, name, status, created_at, updated_at, last_login_at, deleted_at FROM users WHERE id = ?',
		)
		.bind(userId)
		.first<UserRow>();
}

export async function handleDeleteAccount(request: Request, env: Env, ctx: ExecutionContext, requestId: string): Promise<Response> {
	const user = await verifyUserAccessToken(request, env);
	if (user instanceof Response) return user;
	const stale = requireRecentSignIn(user);
	if (stale) return stale;

	const row = await findUser(env.AUTH_DB, user.userId);
	if (!row) return json({ error: 'not_found', error_description: 'Account not found' }, 404);
	if (row.status === 'deleted') {
		return json({ deleted: true, userId: row.id, deletedAt: row.deleted_at });
	}

	const storage = CloudflarePatchedStorage({ namespace: env.AUTH_STORAGE });
	const userAdapter = new D1UserAdapter({ db: env.AUTH_DB, usersTable: 'users' });
	// KV user record and email index, when the account has them (older accounts live only in D1)
	try {
		await createUserService({ storage, d1Adapter: userAdapter }).deleteUser(row.tenant_id, row.id);
	} catch (error) {
		if ((error as { code?: string })?.code !== 'user_not_found') throw error;
	}
	// D1 is the source of truth: soft delete and drop the sign-in sessions (idempotent)
	await userAdapter.softDeleteUser(row.tenant_id, row.id, Date.now());
	await userAdapter.revokeAllUserSessions(row.tenant_id, row.id);
	// The password credential: the deleted account can't be signed in to again
	for (const email of new Set([row.email, row.email.toLowerCase()])) {
		await Storage.remove(storage, ['email', email, 'password']);
	}

	// No refresh token of this user can mint access tokens any more
	const nowUnix = Math.floor(Date.now() / 1000);
	const revoked = await env.AUTH_DB.prepare(
		`UPDATE refresh_tokens SET revoked = 1, revoked_at = ?, revoked_reason = 'account_deleted'
		 WHERE user_id = ? AND revoked = 0`,
	)
		.bind(nowUnix, row.id)
		.run();

	ctx.waitUntil(
		getAuditEmitter().emit(
			createAuditEvent(AuditEventType.USER_DELETED, {
				severity: AuditEventSeverity.WARNING,
				userId: row.id,
				ipAddress: request.headers.get('CF-Connecting-IP'),
				userAgent: request.headers.get('User-Agent'),
				requestId,
				metadata: { initiatedBy: 'self', clientId: user.clientId, refreshTokensRevoked: revoked.meta?.changes ?? 0 },
			}),
		),
	);
	logger.info('[account] Account deleted by its owner', { userId: row.id });
	const after = await findUser(env.AUTH_DB, row.id);
	return json({ deleted: true, userId: row.id, deletedAt: after?.deleted_at ?? Date.now() });
}

export async function handleAccountExport(request: Request, env: Env): Promise<Response> {
	const user = await verifyUserAccessToken(request, env);
	if (user instanceof Response) return user;
	const row = await findUser(env.AUTH_DB, user.userId);
	if (!row || row.status === 'deleted') return json({ error: 'not_found', error_description: 'Account not found' }, 404);

	const db = env.AUTH_DB;
	const [roles, identities, sessions, refreshTokens, audit] = await Promise.all([
		db
			.prepare(
				`SELECT r.name AS role, ur.assigned_at, ur.expires_at FROM rbac_user_roles ur
				 JOIN rbac_roles r ON r.id = ur.role_id WHERE ur.user_id = ?`,
			)
			.bind(row.id)
			.all(),
		db.prepare('SELECT provider, created_at FROM user_identities WHERE user_id = ?').bind(row.id).all(),
		db
			.prepare('SELECT client_id, authenticated_at, expires_at, is_active FROM account_sessions WHERE user_id = ? ORDER BY authenticated_at DESC')
			.bind(row.id)
			.all(),
		db
			.prepare('SELECT client_id, scope, created_at, expires_at, revoked, revoked_at FROM refresh_tokens WHERE user_id = ? ORDER BY created_at DESC')
			.bind(row.id)
			.all(),
		db
			.prepare(
				`SELECT timestamp, event_type, ip_address, user_agent, success FROM audit_events
				 WHERE user_id = ? ORDER BY timestamp DESC LIMIT ${AUDIT_EXPORT_LIMIT}`,
			)
			.bind(row.id)
			.all(),
	]);

	const body = {
		exportedAt: new Date().toISOString(),
		source: 'auth',
		account: {
			id: row.id,
			email: row.email,
			name: row.name,
			status: row.status,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			lastLoginAt: row.last_login_at,
		},
		roles: roles.results,
		identities: identities.results,
		sessions: sessions.results,
		refreshTokens: refreshTokens.results,
		auditEvents: audit.results,
	};
	return json(body, 200, { 'Content-Disposition': 'attachment; filename="alummahnow-account.json"' });
}
