import { getUserSession } from './session';
import { PermissionService } from './permission-service';
import { logger } from './logger';
import { verifyM2MAuth, hasM2MAuth, M2MAuthResult, M2MAuthError, createM2MAuthErrorResponse } from './middleware/m2m-auth';

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

  // Check RBAC permissions
  const permissionService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);

  // Check for admin permissions
  const hasAdminPermission = await permissionService.hasPermission(
    authContext.user.id,
    'system:manage:all'
  );

  if (!hasAdminPermission) {
    // Also check for role management permission as alternative
    const hasRoleManagement = await permissionService.hasPermission(
      authContext.user.id,
      'roles:manage:all'
    );

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
      const isActingUserAdmin = actualRoles.includes('admin') || actualRoles.includes('super_admin');
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
      if (error instanceof M2MAuthError) {
        throw error;
      }
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

  const permissionService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);
  const hasPermission = await permissionService.hasPermission(
    authContext.user.id,
    permission,
    resource
  );

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
  const effectivePermissions = await permissionService.getUserPermissions(authContext.user.id);

  // Combine all permission names from permissions, directGrants, excluding directDenies
  const allPermissions = [
    ...effectivePermissions.permissions,
    ...effectivePermissions.directGrants,
  ];

  const permissionNames = allPermissions
    .map(p => p.name)
    .filter(name => !effectivePermissions.directDenies.some(d => d.name === name));

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
  const permissionService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);

  // Super admins can grant any permission
  if (await permissionService.hasPermission(granterId, '*:*:*')) {
    logger.debug('Super admin granting permission', {
      granterId,
      permissionToGrant,
    });
    return true;
  }

  // Check if granter has the permission they're trying to grant
  const hasPermission = await permissionService.hasPermission(granterId, permissionToGrant);

  if (!hasPermission) {
    logger.warn('Granter lacks permission to grant', {
      granterId,
      permissionToGrant,
    });
    return false;
  }

  // Also check if granter has role/permission management rights
  const canManageRoles = await permissionService.hasPermission(granterId, 'roles:manage:all');
  const canManageUsers = await permissionService.hasPermission(granterId, 'users:manage:all');

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