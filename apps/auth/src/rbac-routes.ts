import { PermissionService } from './permission-service';
import { RoleService } from './role-service';
import { verifyAuth, verifyPermission, AuthContext, createAuthErrorResponse, verifyGranterPermission } from './auth-middleware';
import { logger } from './logger';
import { emitAuditEvent } from './audit-emitter-enhanced';
import {
  AuditEventType,
  AuditEventSeverity,
  createRoleManagementEvent,
  createPermissionManagementEvent,
  createAuditEvent,
  createSecurityAlertEvent
} from './audit-events';
import { checkRateLimit, getClientIP } from './rate-limit';
import * as v from 'valibot';

// Input validation schemas
const UserIdSchema = v.object({
  userId: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
});

const RoleAssignmentSchema = v.object({
  roleId: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  expiresAt: v.optional(v.string()), // ISO date string
});

const PermissionCheckSchema = v.object({
  permission: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  resource: v.optional(v.object({
    type: v.string(),
    id: v.string(),
    ownerId: v.optional(v.string()),
  })),
});

const BulkPermissionCheckSchema = v.object({
  permissions: v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(100))),
});

/**
 * User-facing RBAC Routes Handler
 * Handles routes for user permission and role management
 */
export class RBACRoutes {
  private permissionService: PermissionService;
  private roleService: RoleService;

  constructor(db: D1Database, kv: KVNamespace) {
    this.permissionService = new PermissionService(db, kv);
    this.roleService = new RoleService(db, kv);
  }

  /**
   * Route handler for user-facing RBAC endpoints
   */
  async handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    // User role management routes
    if (path.match(/^\/api\/users\/[^\/]+\/roles$/) && method === 'GET') {
      const userId = path.split('/')[3];
      return this.getUserRoles(userId, request, env, ctx);
    }
    if (path.match(/^\/api\/users\/[^\/]+\/roles$/) && method === 'POST') {
      const userId = path.split('/')[3];
      return this.assignRoleToUser(userId, request, env, ctx);
    }
    if (path.match(/^\/api\/users\/[^\/]+\/roles\/[^\/]+$/) && method === 'DELETE') {
      const parts = path.split('/');
      const userId = parts[3];
      const roleId = parts[5];
      return this.removeRoleFromUser(userId, roleId, request, env, ctx);
    }

    // User permission routes
    if (path.match(/^\/api\/users\/[^\/]+\/permissions$/) && method === 'GET') {
      const userId = path.split('/')[3];
      return this.getUserPermissions(userId, request, env, ctx);
    }

    // Permission checking routes
    if (path === '/api/permissions/check' && method === 'POST') {
      return this.checkPermission(request, env, ctx);
    }
    if (path === '/api/permissions/bulk-check' && method === 'POST') {
      return this.bulkCheckPermissions(request, env, ctx);
    }

    // Permission listing route
    if (path === '/api/permissions' && method === 'GET') {
      return this.listPermissions(request, env, ctx);
    }

    return new Response('Not Found', { status: 404 });
  }

  /**
   * GET /api/users/:id/roles - Get user's assigned roles
   */
  private async getUserRoles(
    userId: string,
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      // Verify authentication
      const authContext = await verifyAuth(request, env);

      // Users can view their own roles, admins can view any user's roles
      if (authContext.user.id !== userId && !authContext.isAdmin) {
        // Check if user has permission to view other users' roles
        const hasPermission = await this.permissionService.hasPermission(
          authContext.user.id,
          'users:read:all'
        );

        if (!hasPermission) {
          return createAuthErrorResponse('You can only view your own roles', 403);
        }
      }

      // Validate user ID
      v.parse(UserIdSchema, { userId });

      // Get user's roles
      const roles = await this.roleService.getUserRoles(userId);

      return new Response(JSON.stringify(roles), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to get user roles', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof v.ValiError) {
        return createAuthErrorResponse('Invalid user ID', 400);
      }

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to get user roles',
        500
      );
    }
  }

  /**
   * POST /api/users/:id/roles - Assign role to a user
   */
  private async assignRoleToUser(
    userId: string,
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      // Verify authentication and permission
      const authContext = await verifyAuth(request, env);

      // Check if user has permission to manage roles
      const canManageRoles = await this.permissionService.hasPermission(
        authContext.user.id,
        'users:manage:all'
      );

      if (!canManageRoles) {
        await emitAuditEvent(
          createAuditEvent(
            AuditEventType.UNAUTHORIZED_ACCESS,
            AuditEventSeverity.WARNING,
            {
              userId: authContext.user.id,
              metadata: {
                operation: 'assign_role',
                targetUserId: userId,
              },
              success: false,
            }
          )
        );
        return createAuthErrorResponse('Permission denied: Cannot manage user roles', 403);
      }

      // Rate limiting for role assignments (20 per hour)
      const clientIP = getClientIP(request);
      const rateLimitKey = `role:assign:${clientIP}`;
      const rateLimit = await checkRateLimit(
        env.AUTH_STORAGE,
        rateLimitKey,
        20,
        3600 // 1 hour
      );

      if (!rateLimit.allowed) {
        await emitAuditEvent(
          createSecurityAlertEvent(
            'RATE_LIMIT_EXCEEDED',
            { operation: 'role_assignment', ip: clientIP },
            authContext.user.id,
            clientIP
          )
        );
        return createAuthErrorResponse('Rate limit exceeded. Please try again later.', 429);
      }

      // Validate user ID and request body
      v.parse(UserIdSchema, { userId });
      const body = await request.json();
      const validated = v.parse(RoleAssignmentSchema, body);

      // Get role details for validation
      const role = await this.roleService.getRole(validated.roleId);
      if (!role) {
        return createAuthErrorResponse('Role not found', 404);
      }

      // CRITICAL SECURITY CHECK: Check if the granter has all permissions the role would grant
      const rolePerms = await this.roleService.getRolePermissions(validated.roleId);
      if (rolePerms) {
        for (const perm of rolePerms) {
          const canGrant = await verifyGranterPermission(
            authContext.user.id,
            perm.name,
            env
          );

          if (!canGrant) {
            await emitAuditEvent(
              createSecurityAlertEvent(
                'PRIVILEGE_ESCALATION_ATTEMPT',
                {
                  operation: 'assign_role',
                  roleId: validated.roleId,
                  roleName: role.name,
                  missingPermission: perm.name,
                  targetUserId: userId,
                  granterId: authContext.user.id,
                },
                authContext.user.id,
                clientIP
              )
            );

            logger.warn('Privilege escalation attempt blocked', {
              granterId: authContext.user.id,
              targetUserId: userId,
              roleName: role.name,
              missingPermission: perm.name,
            });

            return createAuthErrorResponse(
              'You cannot assign roles containing permissions you do not have',
              403
            );
          }
        }
      }

      // Parse expiration date if provided
      const expiresAt = validated.expiresAt ? new Date(validated.expiresAt) : undefined;

      // Assign the role
      await this.roleService.assignRoleToUser(
        userId,
        validated.roleId,
        authContext.user.id,
        expiresAt
      );

      // Emit audit event
      await emitAuditEvent(
        createRoleManagementEvent(
          AuditEventType.ROLE_ASSIGNED,
          validated.roleId,
          role.name,
          authContext.user.id,
          {
            targetUserId: userId,
            expiresAt: expiresAt?.toISOString(),
          }
        )
      );

      logger.info('Role assigned to user', {
        userId,
        roleId: validated.roleId,
        roleName: role.name,
        assignedBy: authContext.user.id,
        expiresAt,
      });

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to assign role to user', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof v.ValiError) {
        return createAuthErrorResponse('Invalid request: ' + error.message, 400);
      }

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to assign role',
        500
      );
    }
  }

  /**
   * DELETE /api/users/:id/roles/:roleId - Remove role from a user
   */
  private async removeRoleFromUser(
    userId: string,
    roleId: string,
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      // Verify authentication and permission
      const authContext = await verifyAuth(request, env);

      // Check if user has permission to manage roles
      const canManageRoles = await this.permissionService.hasPermission(
        authContext.user.id,
        'users:manage:all'
      );

      if (!canManageRoles) {
        await emitAuditEvent(
          createAuditEvent(
            AuditEventType.UNAUTHORIZED_ACCESS,
            AuditEventSeverity.WARNING,
            {
              userId: authContext.user.id,
              metadata: {
                operation: 'remove_role',
                targetUserId: userId,
                roleId,
              },
              success: false,
            }
          )
        );
        return createAuthErrorResponse('Permission denied: Cannot manage user roles', 403);
      }

      // Validate IDs
      v.parse(UserIdSchema, { userId });

      // Get role details for audit log
      const role = await this.roleService.getRole(roleId);
      if (!role) {
        return createAuthErrorResponse('Role not found', 404);
      }

      // Remove the role
      await this.roleService.removeRoleFromUser(userId, roleId, authContext.user.id);

      // Emit audit event
      await emitAuditEvent(
        createRoleManagementEvent(
          AuditEventType.ROLE_REMOVED,
          roleId,
          role.name,
          authContext.user.id,
          { targetUserId: userId }
        )
      );

      logger.info('Role removed from user', {
        userId,
        roleId,
        roleName: role.name,
        removedBy: authContext.user.id,
      });

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to remove role from user', {
        userId,
        roleId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof v.ValiError) {
        return createAuthErrorResponse('Invalid request parameters', 400);
      }

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to remove role',
        500
      );
    }
  }

  /**
   * GET /api/users/:id/permissions - Get user's effective permissions
   */
  private async getUserPermissions(
    userId: string,
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      // Verify authentication
      const authContext = await verifyAuth(request, env);

      // Users can view their own permissions, admins can view any user's permissions
      if (authContext.user.id !== userId && !authContext.isAdmin) {
        // Check if user has permission to view other users' permissions
        const hasPermission = await this.permissionService.hasPermission(
          authContext.user.id,
          'users:read:all'
        );

        if (!hasPermission) {
          return createAuthErrorResponse('You can only view your own permissions', 403);
        }
      }

      // Validate user ID
      v.parse(UserIdSchema, { userId });

      // Get user's effective permissions
      const permissions = await this.permissionService.getUserPermissions(userId);

      // Combine all permissions for response
      const allPermissions = [
        ...permissions.permissions,
        ...permissions.directGrants,
      ];

      // Remove duplicates and denied permissions
      const uniquePermissions = Array.from(
        new Set(allPermissions.map(p => p.name))
      ).filter(name => !permissions.directDenies.some(d => d.name === name));

      return new Response(
        JSON.stringify({
          userId,
          roles: permissions.roles.map(r => ({
            id: r.id,
            name: r.name,
            description: r.description,
          })),
          permissions: uniquePermissions.sort(),
          cachedAt: permissions.cachedAt,
          expiresAt: permissions.expiresAt,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } catch (error) {
      logger.error('Failed to get user permissions', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof v.ValiError) {
        return createAuthErrorResponse('Invalid user ID', 400);
      }

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to get user permissions',
        500
      );
    }
  }

  /**
   * POST /api/permissions/check - Check if current user has a permission
   */
  private async checkPermission(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      // Verify authentication
      const authContext = await verifyAuth(request, env);

      // Parse and validate request body
      const body = await request.json();
      const validated = v.parse(PermissionCheckSchema, body);

      // Check permission
      const hasPermission = await this.permissionService.hasPermission(
        authContext.user.id,
        validated.permission,
        validated.resource
      );

      // Log failed permission checks for sensitive resources
      if (!hasPermission && validated.permission.includes('admin')) {
        await emitAuditEvent(
          createAuditEvent(
            AuditEventType.PERMISSION_CHECK_FAILED,
            AuditEventSeverity.WARNING,
            {
              userId: authContext.user.id,
              metadata: {
                permission: validated.permission,
                resource: validated.resource,
              },
              success: false,
            }
          )
        );
      }

      return new Response(
        JSON.stringify({
          userId: authContext.user.id,
          permission: validated.permission,
          hasPermission,
          resource: validated.resource,
          checkedAt: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } catch (error) {
      logger.error('Failed to check permission', {
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof v.ValiError) {
        return createAuthErrorResponse('Invalid request: ' + error.message, 400);
      }

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to check permission',
        500
      );
    }
  }

  /**
   * POST /api/permissions/bulk-check - Check multiple permissions for current user
   */
  private async bulkCheckPermissions(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      // Verify authentication
      const authContext = await verifyAuth(request, env);

      // Parse and validate request body
      const body = await request.json();
      const validated = v.parse(BulkPermissionCheckSchema, body);

      // Check permissions
      const results: Record<string, boolean> = {};

      for (const permission of validated.permissions) {
        results[permission] = await this.permissionService.hasPermission(
          authContext.user.id,
          permission
        );
      }

      const hasAll = Object.values(results).every(v => v);
      const hasAny = Object.values(results).some(v => v);

      return new Response(
        JSON.stringify({
          userId: authContext.user.id,
          permissions: results,
          hasAll,
          hasAny,
          checkedAt: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } catch (error) {
      logger.error('Failed to bulk check permissions', {
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof v.ValiError) {
        return createAuthErrorResponse('Invalid request: ' + error.message, 400);
      }

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to check permissions',
        500
      );
    }
  }

  /**
   * GET /api/permissions - List all available permissions
   */
  private async listPermissions(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      // Verify authentication
      const authContext = await verifyAuth(request, env);

      // Check if user has permission to view permissions
      const canViewPermissions =
        authContext.isAdmin ||
        (await this.permissionService.hasPermission(authContext.user.id, 'roles:read:all'));

      if (!canViewPermissions) {
        // Return only basic permissions for non-admin users
        const basicPermissions = await this.permissionService.getAllPermissions();
        const filtered = basicPermissions.filter(p =>
          p.resource === 'users' && p.scope === 'own'
        );

        return new Response(JSON.stringify(filtered), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Get all permissions for admin users
      const permissions = await this.permissionService.getAllPermissions();

      // Group permissions by resource
      const grouped = permissions.reduce((acc, perm) => {
        if (!acc[perm.resource]) {
          acc[perm.resource] = [];
        }
        acc[perm.resource].push(perm);
        return acc;
      }, {} as Record<string, typeof permissions>);

      return new Response(
        JSON.stringify({
          total: permissions.length,
          permissions: grouped,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } catch (error) {
      logger.error('Failed to list permissions', {
        error: error instanceof Error ? error.message : String(error),
      });

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to list permissions',
        500
      );
    }
  }
}