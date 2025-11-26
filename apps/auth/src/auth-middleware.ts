import { getUserSession } from './session';
import { PermissionService } from './permission-service';
import { logger } from './logger';

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
export function withAuth<T extends any[], R>(
  handler: (authContext: AuthContext, ...args: T) => Promise<R>
) {
  return async (request: Request, env: Env, ...args: T): Promise<R | Response> => {
    try {
      const authContext = await verifyAuth(request, env);
      return await handler(authContext, ...[request, env, ...args] as any);
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
export function withAdminAuth<T extends any[], R>(
  handler: (authContext: AuthContext, ...args: T) => Promise<R>
) {
  return async (request: Request, env: Env, ...args: T): Promise<R | Response> => {
    try {
      const authContext = await verifyAdminAuth(request, env);
      return await handler(authContext, ...[request, env, ...args] as any);
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
export function withPermission<T extends any[], R>(
  permission: string,
  handler: (authContext: AuthContext, ...args: T) => Promise<R>
) {
  return async (request: Request, env: Env, ...args: T): Promise<R | Response> => {
    try {
      const authContext = await verifyPermission(request, env, permission);
      return await handler(authContext, ...[request, env, ...args] as any);
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