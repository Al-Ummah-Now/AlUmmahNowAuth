import { getUserSession } from './session';
import { logger } from './logger';
import { extractBearerToken, RBACServiceImpl, RBACAdapter } from '@al-ummah-now/openauth';
import { CloudflareStorage } from '@al-ummah-now/openauth/storage/cloudflare';
import { createLocalJWKSet, jwtVerify, decodeJwt } from 'jose';
import { getJWKS } from './utils/jwks-cache';

/**
 * Default client ID and tenant ID for RBAC operations
 * In a multi-tenant system, these would come from the request context
 * Note: OpenAuth RBAC uses 'clientId' not 'appId' in version 1.0.9
 */
const DEFAULT_CLIENT_ID = 'default-app';
const DEFAULT_TENANT_ID = 'default';

/**
 * Get RBAC service instance
 * Creates a new instance for each request - could be optimized with singleton pattern
 */
function getRBACService(env: Env): RBACServiceImpl {
  const adapter = new RBACAdapter(env.AUTH_DB);
  const storage = CloudflareStorage({ namespace: env.AUTH_STORAGE });
  return new RBACServiceImpl(adapter, storage);
}

/**
 * Check if request has Bearer token (M2M auth)
 */
function hasM2MAuth(request: Request): boolean {
  const authHeader = request.headers.get('Authorization');
  return extractBearerToken(authHeader) !== null;
}

/**
 * M2M auth result interface
 */
interface M2MAuthResult {
  clientId: string;
  tenantId?: string;
  scopes: string[];
}

/**
 * Verify M2M token using jose with locally cached JWKS
 * This avoids the worker-to-self HTTP call issue by using local key verification
 */
async function verifyM2MAuth(
  request: Request,
  env: Env,
  _requiredScope?: string
): Promise<M2MAuthResult> {
  // Derive issuer from X-Forwarded headers if present (matching how OpenAuth issues tokens)
  // Otherwise fall back to env.OPENAUTH_ISSUER
  let issuer = env.OPENAUTH_ISSUER || 'http://localhost:3301';
  const forwardedHost = request.headers.get('X-Forwarded-Host');
  const forwardedProto = request.headers.get('X-Forwarded-Proto');
  if (forwardedHost && forwardedProto) {
    issuer = `${forwardedProto}://${forwardedHost}`;
    logger.debug('Using forwarded issuer for M2M verification', { issuer, forwardedHost, forwardedProto });
  }

  // Extract bearer token
  const authHeader = request.headers.get('Authorization');
  const token = extractBearerToken(authHeader);

  if (!token) {
    throw new Error('No bearer token provided');
  }

  // Decode token to check claims before verification
  const decoded = decodeJwt(token);

  // Verify this is an M2M token (has client_id claim, no sub or sub equals client_id)
  if (!decoded.client_id) {
    throw new Error('Invalid token: not an M2M token (missing client_id)');
  }

  // Get JWKS (from cache/storage or external fetch as fallback)
  const jwks = await getJWKS(env);

  // Create local JWK set for verification
  const JWKS = createLocalJWKSet(jwks);

  // Verify the token
  const { payload } = await jwtVerify(token, JWKS, {
    issuer,
  });

  // Extract scopes from token
  const scopes = payload.scope
    ? (typeof payload.scope === 'string' ? payload.scope.split(' ') : payload.scope as string[])
    : [];

  logger.debug('M2M token verified successfully', {
    clientId: payload.client_id,
    tenantId: payload.tenant_id,
    scopes,
  });

  return {
    clientId: payload.client_id as string,
    tenantId: payload.tenant_id as string | undefined,
    scopes,
  };
}

/**
 * Authentication context that will be passed through the request
 */
export interface AuthContext {
  user: {
    id: string;
    email: string;
    roles: string[];
  };
  permissions?: string[];
  isAdmin: boolean;
}

/**
 * M2M authentication context
 */
export interface M2MAuthContext {
  type: 'm2m';
  clientId: string;
  tenantId?: string;
  scopes: string[];
  /** Acting user context (when M2M request is on behalf of a user) */
  actingUser?: {
    id: string;
    email: string;
    roles: string[];
  };
}

/**
 * Combined auth context - either user or M2M
 */
export type CombinedAuthContext =
  | (AuthContext & { type: 'user' })
  | M2MAuthContext;

/**
 * Verify that a user is authenticated
 * Returns the user context or throws an error
 */
export async function verifyAuth(
  request: Request,
  env: Env
): Promise<AuthContext> {
  // Get session from cookie
  const session = await getUserSession(request, env.AUTH_STORAGE);

  if (!session) {
    logger.warn('Authentication failed: No valid session', {
      hasAuthCookie: request.headers.get('Cookie')?.includes('auth_session'),
    });
    throw new Error('Authentication required');
  }

  // Check if session is expired
  if (new Date(session.expiresAt) < new Date()) {
    logger.warn('Authentication failed: Session expired', {
      userId: session.user.id,
      expiresAt: session.expiresAt,
    });
    throw new Error('Session expired');
  }

  const userRoles = session.user.roles || [];
  logger.debug('User authenticated', {
    userId: session.user.id,
    email: session.user.email,
    roles: userRoles,
  });

  return {
    user: session.user,
    isAdmin: userRoles.includes('admin') || userRoles.includes('super_admin'),
  };
}

/**
 * Verify that a user is an administrator
 * Uses both legacy role field and new RBAC system
 */
export async function verifyAdminAuth(
  request: Request,
  env: Env
): Promise<AuthContext> {
  const authContext = await verifyAuth(request, env);

  // Check RBAC admin roles first
  const userRoles = authContext.user.roles || [];
  if (userRoles.includes('admin') || userRoles.includes('super_admin')) {
    logger.debug('Admin access granted via RBAC role', {
      userId: authContext.user.id,
      roles: userRoles,
    });
    return authContext;
  }

  // Check RBAC permissions using OpenAuth
  const rbacService = getRBACService(env);

  // Check for admin permissions
  const hasAdminPermission = await rbacService.checkPermission({
    userId: authContext.user.id,
    clientId: DEFAULT_CLIENT_ID,
    tenantId: DEFAULT_TENANT_ID,
    permission: 'system:manage:all',
  });

  if (!hasAdminPermission) {
    // Also check for role management permission as alternative
    const hasRoleManagement = await rbacService.checkPermission({
      userId: authContext.user.id,
      clientId: DEFAULT_CLIENT_ID,
      tenantId: DEFAULT_TENANT_ID,
      permission: 'roles:manage:all',
    });

    if (!hasRoleManagement) {
      logger.warn('Admin access denied', {
        userId: authContext.user.id,
        roles: authContext.user.roles,
      });
      throw new Error('Admin access required');
    }
  }

  logger.debug('Admin access granted via RBAC', {
    userId: authContext.user.id,
  });

  return {
    ...authContext,
    isAdmin: true,
  };
}

/**
 * Verify admin access via either session or M2M authentication
 *
 * This function supports dual authentication:
 * 1. Session-based auth (cookie) - for browser-based admin users
 * 2. M2M auth (Bearer token) - for service-to-service communication
 *
 * @param request - The incoming HTTP request
 * @param env - Cloudflare Workers environment
 * @param requiredScope - Required M2M scope (e.g., 'admin:users'). Defaults to 'admin:*'
 * @returns Combined auth context (user or M2M)
 * @throws Error if authentication fails
 *
 * @example
 * ```typescript
 * // In an admin route handler
 * const auth = await verifyAdminRequest(request, env, 'admin:users');
 *
 * if (auth.type === 'm2m') {
 *   console.log(`M2M client ${auth.clientId} accessing admin API`);
 * } else {
 *   console.log(`User ${auth.user.email} accessing admin API`);
 * }
 * ```
 */
export async function verifyAdminRequest(
  request: Request,
  env: Env,
  requiredScope: string = 'admin:*'
): Promise<CombinedAuthContext> {
  // Check if request has M2M auth (Bearer token)
  if (hasM2MAuth(request)) {
    try {
      const m2mAuth = await verifyM2MAuth(request, env, requiredScope);

      // Extract acting user ID from header (required for AND logic)
      const actingUserId = request.headers.get('X-Acting-User-Id');
      const actingUserEmail = request.headers.get('X-Acting-User-Email');

      // AND logic: M2M requests MUST have acting user context
      if (!actingUserId) {
        logger.warn('M2M request missing acting user ID', {
          clientId: m2mAuth.clientId,
        });
        throw new Error('M2M requests must include acting user ID');
      }

      // SECURITY: Fetch actual roles from database - never trust client-provided roles
      // This prevents privilege escalation via spoofed X-Acting-User-Roles headers
      const actualRoles = await fetchUserRolesFromDB(env.AUTH_DB, actingUserId);

      // AND logic: Acting user MUST be an admin (verified against DB)
      // Check case-insensitively for Admin/admin, Super Admin/super_admin
      const isActingUserAdmin = actualRoles.some(role => {
        const lowerRole = role.toLowerCase();
        return lowerRole === 'admin' || lowerRole === 'super admin' || lowerRole === 'super_admin';
      });
      if (!isActingUserAdmin) {
        logger.warn('M2M acting user is not admin (verified from DB)', {
          clientId: m2mAuth.clientId,
          actingUserId,
          actualRoles,
        });
        throw new Error('Acting user must be an admin');
      }

      // Fetch email from DB if not provided (optional enhancement)
      let verifiedEmail = actingUserEmail;
      if (!verifiedEmail) {
        verifiedEmail = await fetchUserEmailFromDB(env.AUTH_DB, actingUserId);
      }

      logger.debug('M2M admin access granted (hybrid approach)', {
        clientId: m2mAuth.clientId,
        scopes: m2mAuth.scopes,
        actingUserId,
        actualRoles,
      });

      return {
        type: 'm2m',
        clientId: m2mAuth.clientId,
        tenantId: m2mAuth.tenantId,
        scopes: m2mAuth.scopes,
        actingUser: {
          id: actingUserId,
          email: verifiedEmail || '',
          roles: actualRoles,
        },
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'M2M authentication failed');
    }
  }

  // Fall back to session-based auth
  const authContext = await verifyAdminAuth(request, env);
  return {
    type: 'user',
    ...authContext,
  };
}

/**
 * Fetch user's actual roles from the database
 * This is the authoritative source of truth for user roles
 */
async function fetchUserRolesFromDB(db: D1Database, userId: string): Promise<string[]> {
  try {
    const result = await db.prepare(`
      SELECT r.name
      FROM rbac_user_roles ur
      JOIN rbac_roles r ON ur.role_id = r.id
      WHERE ur.user_id = ?
        AND (ur.expires_at IS NULL OR ur.expires_at > unixepoch() * 1000)
      ORDER BY r.name
    `).bind(userId).all<{ name: string }>();

    return result.results?.map(r => r.name) || [];
  } catch (error) {
    logger.error('Failed to fetch user roles from DB', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Fetch user's email from the database
 */
async function fetchUserEmailFromDB(db: D1Database, userId: string): Promise<string | null> {
  try {
    const result = await db.prepare(`
      SELECT email FROM users WHERE id = ?
    `).bind(userId).first<{ email: string }>();

    return result?.email || null;
  } catch (error) {
    logger.error('Failed to fetch user email from DB', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Helper to check if auth context is M2M
 */
export function isM2MAuth(auth: CombinedAuthContext): auth is M2MAuthContext {
  return auth.type === 'm2m';
}

/**
 * Helper to check if auth context is user session
 */
export function isUserAuth(auth: CombinedAuthContext): auth is (AuthContext & { type: 'user' }) {
  return auth.type === 'user';
}

/**
 * Get the actor ID for audit logging
 * Returns clientId for M2M, userId for user sessions
 */
export function getActorId(auth: CombinedAuthContext): string {
  if (isM2MAuth(auth)) {
    return `m2m:${auth.clientId}`;
  }
  return auth.user.id;
}

/**
 * Verify that a user has a specific permission
 */
export async function verifyPermission(
  request: Request,
  env: Env,
  permission: string,
  resource?: { type: string; id: string; ownerId?: string }
): Promise<AuthContext> {
  const authContext = await verifyAuth(request, env);

  const rbacService = getRBACService(env);

  // Note: OpenAuth RBAC doesn't support resource-level permissions yet
  // The resource parameter is ignored for now - could be implemented with custom logic
  const hasPermission = await rbacService.checkPermission({
    userId: authContext.user.id,
    clientId: DEFAULT_CLIENT_ID,
    tenantId: DEFAULT_TENANT_ID,
    permission,
  });

  if (!hasPermission) {
    logger.warn('Permission denied', {
      userId: authContext.user.id,
      permission,
      resource,
    });
    throw new Error(`Permission denied: ${permission}`);
  }

  logger.debug('Permission granted', {
    userId: authContext.user.id,
    permission,
  });

  // Load all user permissions for context
  const permissionNames = await rbacService.getUserPermissions({
    userId: authContext.user.id,
    clientId: DEFAULT_CLIENT_ID,
    tenantId: DEFAULT_TENANT_ID,
  });

  return {
    ...authContext,
    permissions: permissionNames,
  };
}

/**
 * Middleware to check if the granter has the permission they're trying to grant
 * CRITICAL SECURITY CHECK: Prevents privilege escalation
 */
export async function verifyGranterPermission(
  granterId: string,
  permissionToGrant: string,
  env: Env
): Promise<boolean> {
  const rbacService = getRBACService(env);

  // Super admins can grant any permission
  const isSuperAdmin = await rbacService.checkPermission({
    userId: granterId,
    clientId: DEFAULT_CLIENT_ID,
    tenantId: DEFAULT_TENANT_ID,
    permission: '*:*:*',
  });

  if (isSuperAdmin) {
    logger.debug('Super admin granting permission', {
      granterId,
      permissionToGrant,
    });
    return true;
  }

  // Check if granter has the permission they're trying to grant
  const hasPermission = await rbacService.checkPermission({
    userId: granterId,
    clientId: DEFAULT_CLIENT_ID,
    tenantId: DEFAULT_TENANT_ID,
    permission: permissionToGrant,
  });

  if (!hasPermission) {
    logger.warn('Granter lacks permission to grant', {
      granterId,
      permissionToGrant,
    });
    return false;
  }

  // Also check if granter has role/permission management rights
  const canManageRoles = await rbacService.checkPermission({
    userId: granterId,
    clientId: DEFAULT_CLIENT_ID,
    tenantId: DEFAULT_TENANT_ID,
    permission: 'roles:manage:all',
  });

  const canManageUsers = await rbacService.checkPermission({
    userId: granterId,
    clientId: DEFAULT_CLIENT_ID,
    tenantId: DEFAULT_TENANT_ID,
    permission: 'users:manage:all',
  });

  if (!canManageRoles && !canManageUsers) {
    logger.warn('Granter lacks management permissions', {
      granterId,
      permissionToGrant,
    });
    return false;
  }

  return true;
}

/**
 * Create a standard error response
 */
export function createAuthErrorResponse(
  message: string,
  status: number = 401
): Response {
  return new Response(
    JSON.stringify({
      error: message,
      status,
    }),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );
}

/**
 * Wrap a route handler with authentication
 */
export function withAuth<T extends unknown[], R>(
  handler: (authContext: AuthContext, ...args: T) => Promise<R>
) {
  return async (request: Request, env: Env, ...args: T): Promise<R | Response> => {
    try {
      const authContext = await verifyAuth(request, env);
      return await handler(authContext, ...[request, env, ...args] as T);
    } catch (error) {
      logger.error('Authentication error', {
        error: error instanceof Error ? error.message : String(error),
      });
      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Authentication required',
        401
      );
    }
  };
}

/**
 * Wrap a route handler with admin authentication
 */
export function withAdminAuth<T extends unknown[], R>(
  handler: (authContext: AuthContext, ...args: T) => Promise<R>
) {
  return async (request: Request, env: Env, ...args: T): Promise<R | Response> => {
    try {
      const authContext = await verifyAdminAuth(request, env);
      return await handler(authContext, ...[request, env, ...args] as T);
    } catch (error) {
      logger.error('Admin authentication error', {
        error: error instanceof Error ? error.message : String(error),
      });
      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Admin access required',
        403
      );
    }
  };
}

/**
 * Wrap a route handler with permission check
 */
export function withPermission<T extends unknown[], R>(
  permission: string,
  handler: (authContext: AuthContext, ...args: T) => Promise<R>
) {
  return async (request: Request, env: Env, ...args: T): Promise<R | Response> => {
    try {
      const authContext = await verifyPermission(request, env, permission);
      return await handler(authContext, ...[request, env, ...args] as T);
    } catch (error) {
      logger.error('Permission check error', {
        permission,
        error: error instanceof Error ? error.message : String(error),
      });
      return createAuthErrorResponse(
        error instanceof Error ? error.message : `Permission denied: ${permission}`,
        403
      );
    }
  };
}