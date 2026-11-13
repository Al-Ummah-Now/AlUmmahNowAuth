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
import { D1UserAdapter } from '@al-ummah-now/openauth';
import { D1UserService } from '../services/d1-user-service';
import { getJWKS } from '../utils/jwks-cache';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { authStorage } from '../storage/auth-storage';
import { removeAllRefreshTokens } from '@al-ummah-now/openauth/refresh-token';
import type { StorageAdapter } from '@al-ummah-now/openauth/storage/storage';
import { getAuditEmitter } from '../audit-emitter';
import { AuditEventSeverity, AuditEventType, createAuditEvent } from '../audit-events';
import { logger } from '../logger';
import { revokeUser } from '../revocation/revocation-list';
import { parseAccessTtl } from '../revocation/token-gate';

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
	/** OpenAuth subject (`sub`): the key of the user's refresh tokens in KV. */
	subject?: string;
	clientId?: string;
	authTime?: number;
	jti?: string;
	exp?: number;
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
	return verifyUserToken(token, env);
}

/** A user access token of this issuer (signature, issuer, expiry), or the 401 to send. */
export async function verifyUserToken(token: string, env: Env): Promise<VerifiedUser | Response> {
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
	// Tokens issued for longer than ACCESS_TOKEN_TTL (the 30-day tokens from
	// before #437) are not accepted: the client refreshes and gets a short token
	// with the current roles
	if (exceedsAccessTtl(claims, parseAccessTtl(env.ACCESS_TOKEN_TTL))) {
		return unauthorized('The access token is invalid or expired');
	}
	return {
		userId: claims.properties.id,
		subject: typeof claims.sub === 'string' ? claims.sub : undefined,
		clientId: typeof claims.aud === 'string' ? claims.aud : undefined,
		authTime: typeof claims.auth_time === 'number' ? claims.auth_time : undefined,
		jti: typeof claims.jti === 'string' ? claims.jti : undefined,
		exp: typeof claims.exp === 'number' ? claims.exp : undefined,
	};
}

/** Clock slack between `iat` and `exp`, in seconds. */
const LIFETIME_SLACK_SECONDS = 60;

/** True when the token was issued for longer than `accessTtl` seconds. */
export function exceedsAccessTtl(claims: { iat?: unknown; exp?: unknown }, accessTtl: number | undefined): boolean {
	if (!accessTtl) return false;
	if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number') return true;
	return claims.exp - claims.iat > accessTtl + LIFETIME_SLACK_SECONDS;
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

/**
 * Refresh tokens live in D1 (openauth_atomic) since openauth's OA-2, and older
 * ones may still be in KV under ["oauth:refresh", subject, token]. Without
 * removing them, a deleted account could keep minting access tokens.
 */
/** Lists the account in Recently deleted so the cleanup purges it after 30 days. */
async function recordSelfDeletion(db: D1Database, row: { id: string; tenant_id: string; email: string; status: string }): Promise<void> {
	await db
		.prepare(
			`INSERT OR IGNORE INTO admin_deletions (kind, item_id, tenant_id, label, deleted_at, deleted_by, reason, snapshot)
			 VALUES ('user', ?1, ?2, ?3, ?4, 'self', 'Deleted by the account owner', ?5)`
		)
		.bind(row.id, row.tenant_id, row.email, Date.now(), JSON.stringify({ status: row.status === 'suspended' ? 'suspended' : 'active', email: row.email }))
		.run();
}

async function removeRefreshTokens(storage: StorageAdapter, subject: string | undefined): Promise<number> {
	if (!subject) return 0;
	return removeAllRefreshTokens(storage, subject);
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
	const storage = authStorage(env);
	if (row.status === 'deleted') {
		// Idempotent retry; also cleans refresh tokens of accounts deleted before this was fixed
		const removed = await removeRefreshTokens(storage, user.subject);
		await revokeUser({ kv: env.TOKEN_REVOCATIONS, db: env.AUTH_DB }, row.id, 'account_deleted');
		if (removed > 0) logger.info('[account] Removed refresh tokens of a deleted account', { userId: row.id, removed });
		return json({ deleted: true, userId: row.id, deletedAt: row.deleted_at });
	}

	const userAdapter = new D1UserAdapter({ db: env.AUTH_DB, usersTable: 'users' });
	// The old KV user record and email index, when the account has them (never written since AU-3)
	await new D1UserService({ db: env.AUTH_DB, adapter: userAdapter, legacy: storage }).removeLegacy(row.tenant_id, row.id, row.email.toLowerCase());
	// D1 is the source of truth: soft delete and drop the sign-in sessions (idempotent)
	await userAdapter.softDeleteUser(row.tenant_id, row.id, Date.now());
	// The hourly cleanup removes the account's data 30 days from now (deletions/purge.ts)
	await recordSelfDeletion(env.AUTH_DB, row);
	await userAdapter.revokeAllUserSessions(row.tenant_id, row.id);
	// The password credential: the deleted account can't be signed in to again
	for (const email of new Set([row.email, row.email.toLowerCase()])) {
		await Storage.remove(storage, ['email', email, 'password']);
	}

	// No refresh token of this user can mint access tokens any more: KV (OpenAuth) and D1
	const kvRefreshTokensRemoved = await removeRefreshTokens(storage, user.subject);
	// Every other sign-in (other subjects, access tokens already out): the revocation list
	await revokeUser({ kv: env.TOKEN_REVOCATIONS, db: env.AUTH_DB }, row.id, 'account_deleted');
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
				metadata: {
					initiatedBy: 'self',
					clientId: user.clientId,
					refreshTokensRevoked: revoked.meta?.changes ?? 0,
					kvRefreshTokensRemoved,
				},
			}),
		),
	);
	logger.info('[account] Account deleted by its owner', { userId: row.id });
	const after = await findUser(env.AUTH_DB, row.id);
	return json({ deleted: true, userId: row.id, deletedAt: after?.deleted_at ?? Date.now() });
}

/**
 * POST /account/sign-out-all: "sign out of all devices". Every sign-in of the
 * caller made up to now stops working: refresh tokens are refused, access
 * tokens are rejected by the APIs within the revocation bound. This client is
 * signed out too and signs in again.
 */
export async function handleSignOutAll(request: Request, env: Env, ctx: ExecutionContext, requestId: string): Promise<Response> {
	const user = await verifyUserAccessToken(request, env);
	if (user instanceof Response) return user;
	const entry = await revokeUser({ kv: env.TOKEN_REVOCATIONS, db: env.AUTH_DB }, user.userId, 'sign_out_all');
	if (!entry) return json({ error: 'temporarily_unavailable', error_description: 'Sign-out of all devices is not available' }, 503);
	const kvRefreshTokensRemoved = await removeRefreshTokens(authStorage(env), user.subject);
	ctx.waitUntil(
		getAuditEmitter().emit(
			createAuditEvent(AuditEventType.LOGOUT, {
				severity: AuditEventSeverity.INFO,
				userId: user.userId,
				ipAddress: request.headers.get('CF-Connecting-IP'),
				userAgent: request.headers.get('User-Agent'),
				requestId,
				metadata: { scope: 'all_devices', clientId: user.clientId, kvRefreshTokensRemoved },
			}),
		),
	);
	return json({ signedOut: true, revokedBefore: entry.before });
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

/** The name fields a user may set on their own Auth record (the platform's name rule reads them). */
const NAME_FIELDS = ['displayName', 'firstName', 'lastName'] as const;
const LOCALIZED_NAME_FIELDS = ['displayNameLocalized', 'firstNameLocalized', 'lastNameLocalized'] as const;
const NAME_MAX = 100;

function cleanName(v: unknown): string | null | undefined {
	if (v === undefined) return undefined;
	if (v === null) return null;
	if (typeof v !== 'string') throw new Error('a name must be a string');
	const s = v.replace(/\s+/g, ' ').trim();
	if (s.length > NAME_MAX) throw new Error(`a name is at most ${NAME_MAX} characters`);
	return s || null;
}

function cleanLocalized(v: unknown): Record<string, string> | null | undefined {
	if (v === undefined) return undefined;
	if (v === null) return null;
	if (typeof v !== 'object' || Array.isArray(v)) throw new Error('a localized name is an object of language → name');
	const out: Record<string, string> = {};
	for (const [lang, name] of Object.entries(v as Record<string, unknown>)) {
		if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(lang)) throw new Error(`unknown language ${lang}`);
		const s = cleanName(name);
		if (s) out[lang] = s;
	}
	return Object.keys(out).length ? out : null;
}

/**
 * PUT /account/name: the caller's own names (display name, first and last, and their localized
 * forms) on their Auth record, so every app that names accounts from Auth (the account switcher,
 * profile, accounts admin, www, the CMS) follows the platform rule: display name, else first + last,
 * else the email. The videos app keeps the names in its profile and sends them here whenever they
 * change (2026-11-13: names saved in videos never reached Auth, so every Auth-backed menu showed
 * the email). Only the fields sent change; null clears one. The display name is the users.name
 * column; first/last and the localized forms live in metadata.
 */
export async function handleSetAccountName(request: Request, env: Env): Promise<Response> {
	const user = await verifyUserAccessToken(request, env);
	if (user instanceof Response) return user;
	let body: Record<string, unknown>;
	try {
		const parsed: unknown = await request.json();
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('a JSON object is required');
		body = parsed as Record<string, unknown>;
	} catch (error) {
		return json({ error: 'invalid_request', error_description: error instanceof Error ? error.message : 'invalid JSON' }, 400);
	}
	const updates: Record<string, string | Record<string, string> | null> = {};
	try {
		for (const f of NAME_FIELDS) {
			const v = cleanName(body[f]);
			if (v !== undefined) updates[f] = v;
		}
		for (const f of LOCALIZED_NAME_FIELDS) {
			const v = cleanLocalized(body[f]);
			if (v !== undefined) updates[f] = v;
		}
	} catch (error) {
		return json({ error: 'invalid_request', error_description: (error as Error).message }, 400);
	}
	if (!Object.keys(updates).length) return json({ error: 'invalid_request', error_description: 'no name field was sent' }, 400);

	const row = await env.AUTH_DB.prepare('SELECT id, name, metadata, status FROM users WHERE id = ?')
		.bind(user.userId)
		.first<{ id: string; name: string | null; metadata: string | null; status: string }>();
	if (!row || row.status === 'deleted') return json({ error: 'not_found', error_description: 'Account not found' }, 404);

	let meta: Record<string, unknown> = {};
	try {
		const parsed: unknown = row.metadata ? JSON.parse(row.metadata) : {};
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
	} catch {
		// unreadable metadata is replaced by the names alone
	}
	for (const [k, v] of Object.entries(updates)) {
		if (k === 'displayName') continue;
		if (v === null) delete meta[k];
		else meta[k] = v;
	}
	const name = 'displayName' in updates ? (updates.displayName as string | null) : row.name;
	const metadata = Object.keys(meta).length ? JSON.stringify(meta) : null;
	await env.AUTH_DB.prepare('UPDATE users SET name = ?, metadata = ?, updated_at = ? WHERE id = ?')
		.bind(name, metadata, Date.now(), row.id)
		.run();
	return json({
		name,
		firstName: (meta.firstName as string | undefined) ?? null,
		lastName: (meta.lastName as string | undefined) ?? null,
	});
}
