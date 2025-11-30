import { PermissionService } from './permission-service';
import { RoleService } from './role-service';
import { verifyAdminAuth, verifyGranterPermission, createAuthErrorResponse } from './auth-middleware';
import { logger } from './logger';
import { emitAuditEvent } from './audit-emitter-enhanced';
import {
  AuditEventType,
  createRoleManagementEvent,
  createPermissionManagementEvent,
  createSecurityAlertEvent
} from './audit-events';
import { checkRateLimit, getClientIP } from './rate-limit';
import * as v from 'valibot';

// Input validation schemas
const RoleIdSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
});

const PermissionIdSchema = v.object({
  permissionId: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
});

const GrantPermissionSchema = v.object({
  permissionId: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
});

const CreateRoleSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  description: v.optional(v.string()),
  parent_role_id: v.optional(v.string()),
  metadata: v.optional(v.record(v.string(), v.any())),
});

const UpdateRoleSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(100))),
  description: v.optional(v.string()),
  parent_role_id: v.optional(v.string()),
  metadata: v.optional(v.record(v.string(), v.any())),
});

/**
 * Admin RBAC Routes Handler
 * Handles all admin routes for role and permission management
 */
export class AdminRBACRoutes {
  private permissionService: PermissionService;
  private roleService: RoleService;

  constructor(db: D1Database, kv: KVNamespace) {
    this.permissionService = new PermissionService(db, kv);
    this.roleService = new RoleService(db, kv);
  }

  /**
   * Route handler for admin RBAC endpoints
   */
  async handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    // Match role management routes
    if (path === '/admin/roles' && method === 'POST') {
      return this.createRole(request, env, ctx);
    }
    if (path === '/admin/roles' && method === 'GET') {
      return this.listRoles(request, env, ctx);
    }
    if (path.match(/^\/admin\/roles\/[^/]+$/) && method === 'GET') {
      const roleId = path.split('/').pop()!;
      return this.getRoleDetails(roleId, request, env, ctx);
    }
    if (path.match(/^\/admin\/roles\/[^/]+$/) && method === 'PUT') {
      const roleId = path.split('/').pop()!;
      return this.updateRole(roleId, request, env, ctx);
    }
    if (path.match(/^\/admin\/roles\/[^/]+$/) && method === 'DELETE') {
      const roleId = path.split('/').pop()!;
      return this.deleteRole(roleId, request, env, ctx);
    }

    // Match permission management routes
    if (path.match(/^\/admin\/roles\/[^/]+\/permissions$/) && method === 'POST') {
      const roleId = path.split('/')[3];
      return this.grantPermissionToRole(roleId, request, env, ctx);
    }
    if (path.match(/^\/admin\/roles\/[^/]+\/permissions\/[^/]+$/) && method === 'DELETE') {
      const parts = path.split('/');
      const roleId = parts[3];
      const permissionId = parts[5];
      return this.revokePermissionFromRole(roleId, permissionId, request, env, ctx);
    }

    return new Response('Not Found', { status: 404 });
  }

  /**
   * POST /admin/roles - Create a new role
   */
  private async createRole(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      // Verify admin authentication
      const authContext = await verifyAdminAuth(request, env);

      // Rate limiting for role creation (10 per hour)
      const clientIP = getClientIP(request);
      const rateLimitKey = `admin:role:create:${clientIP}`;
      const rateLimit = await checkRateLimit(
        env.AUTH_STORAGE,
        rateLimitKey,
        10,
        3600 // 1 hour
      );

      if (!rateLimit.allowed) {
        await emitAuditEvent(
          createSecurityAlertEvent(
            'RATE_LIMIT_EXCEEDED',
            { operation: 'role_creation', ip: clientIP },
            authContext.user.id,
            clientIP
          )
        );
        return createAuthErrorResponse('Rate limit exceeded. Please try again later.', 429);
      }

      // Parse and validate request body
      const body = await request.json();
      const validated = v.parse(CreateRoleSchema, body);

      // Create the role
      const role = await this.roleService.createRole(validated, authContext.user.id);

      // Emit audit event
      await emitAuditEvent(
        createRoleManagementEvent(
          AuditEventType.ROLE_CREATED,
          role.id,
          role.name,
          authContext.user.id,
          { description: role.description }
        )
      );

      logger.info('Role created by admin', {
        roleId: role.id,
        roleName: role.name,
        createdBy: authContext.user.id,
      });

      return new Response(JSON.stringify(role), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to create role', {
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof v.ValiError) {
        return createAuthErrorResponse('Invalid request: ' + error.message, 400);
      }

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to create role',
        500
      );
    }
  }

  /**
   * GET /admin/roles - List all roles
   */
  private async listRoles(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      // Verify admin authentication
      await verifyAdminAuth(request, env);

      // Get all roles
      const roles = await this.roleService.getAllRoles();

      return new Response(JSON.stringify(roles), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to list roles', {
        error: error instanceof Error ? error.message : String(error),
      });

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to list roles',
        500
      );
    }
  }

  /**
   * GET /admin/roles/:id - Get role details with permissions
   */
  private async getRoleDetails(
    roleId: string,
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    try {
      // Verify admin authentication
      await verifyAdminAuth(request, env);

      // Validate role ID
      v.parse(RoleIdSchema, { id: roleId });

      // Get role with permissions
      const role = await this.roleService.getRole(roleId);

      if (!role) {
        return createAuthErrorResponse('Role not found', 404);
      }

      // Get role permissions
      const permissions = await this.roleService.getRolePermissions(roleId);

      return new Response(JSON.stringify({ ...role, permissions }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to get role details', {
        roleId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof v.ValiError) {
        return createAuthErrorResponse('Invalid role ID', 400);
      }

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to get role details',
        500
      );
    }
  }

  /**
   * PUT /admin/roles/:id - Update a role
   */
  private async updateRole(
    roleId: string,
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    try {
      // Verify admin authentication
      const authContext = await verifyAdminAuth(request, env);

      // Rate limiting for role updates (10 per hour)
      const clientIP = getClientIP(request);
      const rateLimitKey = `admin:role:update:${clientIP}`;
      const rateLimit = await checkRateLimit(
        env.AUTH_STORAGE,
        rateLimitKey,
        10,
        3600 // 1 hour
      );

      if (!rateLimit.allowed) {
        await emitAuditEvent(
          createSecurityAlertEvent(
            'RATE_LIMIT_EXCEEDED',
            { operation: 'role_update', ip: clientIP },
            authContext.user.id,
            clientIP
          )
        );
        return createAuthErrorResponse('Rate limit exceeded. Please try again later.', 429);
      }

      // Validate role ID
      v.parse(RoleIdSchema, { id: roleId });

      // Parse and validate request body
      const body = await request.json();
      const validated = v.parse(UpdateRoleSchema, body);

      // Update the role
      const role = await this.roleService.updateRole(roleId, validated, authContext.user.id);

      // Emit audit event
      await emitAuditEvent(
        createRoleManagementEvent(
          AuditEventType.ROLE_UPDATED,
          role.id,
          role.name,
          authContext.user.id,
          { changes: validated }
        )
      );

      logger.info('Role updated by admin', {
        roleId: role.id,
        updatedBy: authContext.user.id,
        changes: validated,
      });

      return new Response(JSON.stringify(role), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to update role', {
        roleId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof v.ValiError) {
        return createAuthErrorResponse('Invalid request: ' + error.message, 400);
      }

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to update role',
        500
      );
    }
  }

  /**
   * DELETE /admin/roles/:id - Delete a role
   */
  private async deleteRole(
    roleId: string,
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    try {
      // Verify admin authentication
      const authContext = await verifyAdminAuth(request, env);

      // Rate limiting for role deletion (5 per hour)
      const clientIP = getClientIP(request);
      const rateLimitKey = `admin:role:delete:${clientIP}`;
      const rateLimit = await checkRateLimit(
        env.AUTH_STORAGE,
        rateLimitKey,
        5,
        3600 // 1 hour
      );

      if (!rateLimit.allowed) {
        await emitAuditEvent(
          createSecurityAlertEvent(
            'RATE_LIMIT_EXCEEDED',
            { operation: 'role_deletion', ip: clientIP },
            authContext.user.id,
            clientIP
          )
        );
        return createAuthErrorResponse('Rate limit exceeded. Please try again later.', 429);
      }

      // Validate role ID
      v.parse(RoleIdSchema, { id: roleId });

      // Get role info for audit log
      const role = await this.roleService.getRole(roleId);
      if (!role) {
        return createAuthErrorResponse('Role not found', 404);
      }

      // Delete the role
      await this.roleService.deleteRole(roleId, authContext.user.id);

      // Emit audit event
      await emitAuditEvent(
        createRoleManagementEvent(
          AuditEventType.ROLE_DELETED,
          roleId,
          role.name,
          authContext.user.id
        )
      );

      logger.info('Role deleted by admin', {
        roleId,
        roleName: role.name,
        deletedBy: authContext.user.id,
      });

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to delete role', {
        roleId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof v.ValiError) {
        return createAuthErrorResponse('Invalid role ID', 400);
      }

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to delete role',
        500
      );
    }
  }

  /**
   * POST /admin/roles/:id/permissions - Grant permission to a role
   */
  private async grantPermissionToRole(
    roleId: string,
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    try {
      // Verify admin authentication
      const authContext = await verifyAdminAuth(request, env);

      // Rate limiting for permission grants (10 per hour)
      const clientIP = getClientIP(request);
      const rateLimitKey = `admin:permission:grant:${clientIP}`;
      const rateLimit = await checkRateLimit(
        env.AUTH_STORAGE,
        rateLimitKey,
        10,
        3600 // 1 hour
      );

      if (!rateLimit.allowed) {
        await emitAuditEvent(
          createSecurityAlertEvent(
            'RATE_LIMIT_EXCEEDED',
            { operation: 'permission_grant', ip: clientIP },
            authContext.user.id,
            clientIP
          )
        );
        return createAuthErrorResponse('Rate limit exceeded. Please try again later.', 429);
      }

      // Validate role ID
      v.parse(RoleIdSchema, { id: roleId });

      // Parse and validate request body
      const body = await request.json();
      const validated = v.parse(GrantPermissionSchema, body);

      // Get permission details for validation
      const permissions = await this.permissionService.getAllPermissions();
      const permission = permissions.find(p => p.id === validated.permissionId);

      if (!permission) {
        return createAuthErrorResponse('Permission not found', 404);
      }

      // CRITICAL SECURITY CHECK: Verify granter has the permission they're granting
      const canGrant = await verifyGranterPermission(
        authContext.user.id,
        permission.name,
        env
      );

      if (!canGrant) {
        await emitAuditEvent(
          createSecurityAlertEvent(
            'PRIVILEGE_ESCALATION_ATTEMPT',
            {
              operation: 'grant_permission_to_role',
              roleId,
              permissionId: validated.permissionId,
              permissionName: permission.name,
              granterId: authContext.user.id,
            },
            authContext.user.id,
            clientIP
          )
        );

        logger.warn('Privilege escalation attempt blocked', {
          granterId: authContext.user.id,
          roleId,
          permissionName: permission.name,
        });

        return createAuthErrorResponse(
          'You cannot grant permissions you do not have',
          403
        );
      }

      // Grant the permission
      await this.roleService.modifyRolePermissions(
        roleId,
        'grant',
        validated.permissionId,
        authContext.user.id
      );

      // Emit audit event
      await emitAuditEvent(
        createPermissionManagementEvent(
          AuditEventType.PERMISSION_GRANTED_TO_ROLE,
          permission.id,
          permission.name,
          authContext.user.id,
          { roleId }
        )
      );

      logger.info('Permission granted to role', {
        roleId,
        permissionId: validated.permissionId,
        permissionName: permission.name,
        grantedBy: authContext.user.id,
      });

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to grant permission to role', {
        roleId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof v.ValiError) {
        return createAuthErrorResponse('Invalid request: ' + error.message, 400);
      }

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to grant permission',
        500
      );
    }
  }

  /**
   * DELETE /admin/roles/:id/permissions/:permissionId - Revoke permission from a role
   */
  private async revokePermissionFromRole(
    roleId: string,
    permissionId: string,
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    try {
      // Verify admin authentication
      const authContext = await verifyAdminAuth(request, env);

      // Rate limiting for permission revocation (10 per hour)
      const clientIP = getClientIP(request);
      const rateLimitKey = `admin:permission:revoke:${clientIP}`;
      const rateLimit = await checkRateLimit(
        env.AUTH_STORAGE,
        rateLimitKey,
        10,
        3600 // 1 hour
      );

      if (!rateLimit.allowed) {
        await emitAuditEvent(
          createSecurityAlertEvent(
            'RATE_LIMIT_EXCEEDED',
            { operation: 'permission_revoke', ip: clientIP },
            authContext.user.id,
            clientIP
          )
        );
        return createAuthErrorResponse('Rate limit exceeded. Please try again later.', 429);
      }

      // Validate IDs
      v.parse(RoleIdSchema, { id: roleId });
      v.parse(PermissionIdSchema, { permissionId });

      // Get permission details for audit log
      const permissions = await this.permissionService.getAllPermissions();
      const permission = permissions.find(p => p.id === permissionId);

      if (!permission) {
        return createAuthErrorResponse('Permission not found', 404);
      }

      // Revoke the permission
      await this.roleService.modifyRolePermissions(
        roleId,
        'revoke',
        permissionId,
        authContext.user.id
      );

      // Emit audit event
      await emitAuditEvent(
        createPermissionManagementEvent(
          AuditEventType.PERMISSION_REVOKED_FROM_ROLE,
          permission.id,
          permission.name,
          authContext.user.id,
          { roleId }
        )
      );

      logger.info('Permission revoked from role', {
        roleId,
        permissionId,
        permissionName: permission.name,
        revokedBy: authContext.user.id,
      });

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to revoke permission from role', {
        roleId,
        permissionId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof v.ValiError) {
        return createAuthErrorResponse('Invalid request parameters', 400);
      }

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to revoke permission',
        500
      );
    }
  }
}