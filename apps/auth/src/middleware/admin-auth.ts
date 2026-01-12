/**
 * @fileoverview Admin authorization middleware for Hono routes
 *
 * Provides middleware for requiring admin role and specific permissions.
 * Used by admin session management APIs to enforce authorization.
 * Supports both session-based and M2M authentication.
 *
 * Uses jose with locally cached JWKS for M2M token verification to avoid
 * worker-to-self HTTP call issues on Cloudflare Workers.
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { AccountSession } from '../types/sessions';
import { extractBearerToken, requireScope, requireAnyScope } from '@al-ummah-now/openauth';
import { logger } from '../logger';
import { createLocalJWKSet, jwtVerify, decodeJwt, type JWK } from 'jose';

// Cache for JWKS to avoid repeated fetches
let cachedJWKS: { keys: JWK[]; fetchedAt: number } | null = null;
const JWKS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Re-export OpenAuth's scope middleware for use in routes
export { requireScope, requireAnyScope };

/**
 * Get JWKS from storage or fetch with caching
 */
async function getJWKS(env: Env): Promise<{ keys: JWK[] }> {
	// Check cache first
	if (cachedJWKS && Date.now() - cachedJWKS.fetchedAt < JWKS_CACHE_TTL) {
		return { keys: cachedJWKS.keys };
	}

	// Try to get from KV storage (where OpenAuth stores keys)
	const primaryKey = await env.AUTH_STORAGE.get('keys');
	if (primaryKey) {
		try {
			const keyData = JSON.parse(primaryKey);
			if (keyData.public) {
				const publicJwk =
					typeof keyData.public === 'string' ? JSON.parse(keyData.public) : keyData.public;
				cachedJWKS = {
					keys: [{ ...publicJwk, kid: 'primary', use: 'sig' }],
					fetchedAt: Date.now(),
				};
				logger.debug('Loaded JWKS from KV storage');
				return { keys: cachedJWKS.keys };
			}
		} catch (e) {
			logger.error('Failed to parse JWKS from KV storage', { error: e });
		}
	}

	// Fallback: fetch from JWKS endpoint (may fail in workers)
	const issuer = env.OPENAUTH_ISSUER || 'http://localhost:3301';
	const jwksUrl = `${issuer}/.well-known/jwks.json`;

	logger.debug('Fetching JWKS from external URL', { jwksUrl });
	const response = await fetch(jwksUrl);
	if (!response.ok) {
		throw new Error(`Failed to fetch JWKS: ${response.status} ${response.statusText}`);
	}

	const jwks = (await response.json()) as { keys: JWK[] };
	cachedJWKS = {
		keys: jwks.keys,
		fetchedAt: Date.now(),
	};

	return jwks;
}

type AdminContext = Context<{
	Bindings: Env;
	Variables: {
		browserSession: unknown;
		activeAccount: AccountSession | null;
		tenantId: string;
		scopes: string[];
		token: unknown;
		clientId: string;
		adminUser: { userId: string; email: string; roles: string[] } | null;
	};
}>;

/**
 * Check if request has Bearer token
 */
function hasM2MAuth(request: Request): boolean {
	const authHeader = request.headers.get('Authorization');
	return extractBearerToken(authHeader) !== null;
}

/**
 * Middleware that requires admin role
 *
 * Supports both session-based and M2M authentication:
 * - Session: Uses activeAccount from context
 * - M2M: Uses Bearer token with X-Acting-User-Id header (via OpenAuth bearerAuth)
 *
 * Returns 401 if not authenticated
 * Returns 403 if not an admin
 *
 * Sets adminUser in context variables for audit logging
 */
export function requireAdmin(_requiredScope?: string): MiddlewareHandler<{
	Bindings: Env;
	Variables: {
		browserSession: unknown;
		activeAccount: AccountSession | null;
		tenantId: string;
		scopes: string[];
		token: unknown;
		clientId: string;
		adminUser: { userId: string; email: string; roles: string[] } | null;
	};
}> {
	return async (c: AdminContext, next) => {
		// Check for M2M auth first (Bearer token)
		if (hasM2MAuth(c.req.raw)) {
			logger.info('[requireAdmin] M2M auth detected');
			try {
				// Use local JWKS verification to avoid worker-to-self HTTP call issues
				const issuer = c.env.OPENAUTH_ISSUER || 'http://localhost:3301';
				const authHeader = c.req.header('Authorization');
				const token = extractBearerToken(authHeader);

				if (!token) {
					return c.json({ error: 'No bearer token provided' }, 401);
				}

				// Decode token to check claims before verification
				const decoded = decodeJwt(token);

				// Verify this is an M2M token
				if (!decoded.client_id) {
					return c.json({ error: 'Invalid token: not an M2M token' }, 401);
				}

				// Get JWKS from local storage
				const jwks = await getJWKS(c.env);
				const JWKS = createLocalJWKSet(jwks);

				// Verify the token
				const { payload } = await jwtVerify(token, JWKS, {
					issuer,
				});

				// Set context values
				const scopes = payload.scope
					? typeof payload.scope === 'string'
						? payload.scope.split(' ')
						: (payload.scope as string[])
					: [];
				c.set('tenantId', (payload.tenant_id as string) || 'default');
				c.set('clientId', payload.client_id as string);
				c.set('scopes', scopes);
				c.set('token', payload);

				logger.info('[requireAdmin] Local JWKS verification passed', {
					tenantId: c.get('tenantId'),
					clientId: c.get('clientId'),
				});

				// Get acting user from header (required for M2M)
				const actingUserId = c.req.header('X-Acting-User-Id');
				if (!actingUserId) {
					logger.warn('[requireAdmin] Missing X-Acting-User-Id header');
					return c.json({ error: 'M2M requests must include X-Acting-User-Id header' }, 401);
				}

				// Fetch acting user's roles from DB (never trust client headers)
				const rolesResult = await c.env.AUTH_DB.prepare(`
					SELECT r.name
					FROM rbac_user_roles ur
					JOIN rbac_roles r ON ur.role_id = r.id
					WHERE ur.user_id = ?
					  AND (ur.expires_at IS NULL OR ur.expires_at > unixepoch() * 1000)
				`)
					.bind(actingUserId)
					.all<{ name: string }>();

				const roles = rolesResult.results?.map((r) => r.name) || [];
				logger.info('[requireAdmin] Acting user roles', {
					actingUserId,
					roles,
					rolesCount: roles.length,
				});

				// Case-insensitive role check - OpenAuth seeds 'Admin' and 'Super Admin' (capitalized)
				const roleNamesLower = roles.map((r) => r.toLowerCase());
				const isAdmin = roleNamesLower.includes('admin') || roleNamesLower.includes('super admin');

				if (!isAdmin) {
					logger.warn('[requireAdmin] Acting user not admin', { actingUserId, roles });
					return c.json({ error: 'Forbidden: Acting user must be admin' }, 403);
				}

				// Get user email
				const user = await c.env.AUTH_DB.prepare(`SELECT email FROM users WHERE id = ?`)
					.bind(actingUserId)
					.first<{ email: string }>();

				c.set('adminUser', {
					userId: actingUserId,
					email: user?.email || '',
					roles,
				});

				await next();
				return;
			} catch (error) {
				// Handle OpenAuth middleware errors
				if (error instanceof Error) {
					const statusCode = error.name === 'InsufficientScopeError' ? 403 : 401;
					return c.json({ error: error.message }, statusCode);
				}
				return c.json({ error: 'M2M authentication failed' }, 401);
			}
		}

		// Fall back to session-based auth
		const activeAccount = c.get('activeAccount');

		if (!activeAccount) {
			return c.json({ error: 'Unauthorized' }, 401);
		}

		// Get user with roles
		const user = await c.env.AUTH_DB.prepare(`
			SELECT u.id, u.email
			FROM users u
			WHERE u.id = ?
		`)
			.bind(activeAccount.userId)
			.first<{ id: string; email: string }>();

		if (!user) {
			return c.json({ error: 'User not found' }, 404);
		}

		// Get user roles
		const rolesResult = await c.env.AUTH_DB.prepare(`
			SELECT r.name
			FROM rbac_user_roles ur
			JOIN rbac_roles r ON ur.role_id = r.id
			WHERE ur.user_id = ?
			  AND (ur.expires_at IS NULL OR ur.expires_at > unixepoch() * 1000)
		`)
			.bind(user.id)
			.all<{ name: string }>();

		const roles = rolesResult.results?.map((r) => r.name) || [];

		// Check for admin role (case-insensitive - OpenAuth seeds 'Admin' and 'Super Admin')
		const roleNamesLower = roles.map((r) => r.toLowerCase());
		const isAdmin = roleNamesLower.includes('admin') || roleNamesLower.includes('super admin');

		if (!isAdmin) {
			return c.json({ error: 'Forbidden: Admin access required' }, 403);
		}

		// Set admin user in context for audit logging
		c.set('adminUser', {
			userId: user.id,
			email: user.email,
			roles,
		});

		await next();
	};
}

/**
 * @deprecated Use requireScope from '@al-ummah-now/openauth/middleware' instead.
 * This is kept for backward compatibility during migration.
 *
 * For admin routes, use:
 *   requireAdmin() -> sets scopes in context
 *   requireScope('admin:users') -> checks scope from context
 */
export function requirePermission(_permission: string): MiddlewareHandler<{
	Bindings: Env;
	Variables: {
		browserSession: unknown;
		activeAccount: AccountSession | null;
		tenantId: string;
		scopes: string[];
		token: unknown;
		clientId: string;
		adminUser: { userId: string; email: string; roles: string[] } | null;
	};
}> {
	return async (c: AdminContext, next) => {
		const adminUser = c.get('adminUser');

		if (!adminUser) {
			return c.json({ error: 'Forbidden: Admin context not set' }, 403);
		}

		// All admins pass through - scope checking is done by requireScope
		// Case-insensitive role check (OpenAuth seeds 'Admin' and 'Super Admin')
		const roleNamesLower = adminUser.roles.map((r) => r.toLowerCase());
		if (roleNamesLower.includes('super admin') || roleNamesLower.includes('admin')) {
			await next();
			return;
		}

		return c.json({ error: 'Forbidden: Admin access required' }, 403);
	};
}
