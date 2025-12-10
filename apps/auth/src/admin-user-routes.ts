/**
 * @fileoverview Admin User Management Routes
 *
 * Provides CRUD operations for user management via admin APIs.
 * Supports both session-based auth (user browser) and M2M auth (service-to-service).
 */

import {
  verifyAdminRequest,
  createAuthErrorResponse,
  isM2MAuth,
  getActorId,
  CombinedAuthContext,
} from './auth-middleware';
import { logger } from './logger';
import { emitAuditEvent } from './audit-emitter-enhanced';
import {
  AuditEventType,
  AuditEventSeverity,
  createUserManagementEvent,
  createRoleManagementEvent,
} from './audit-events';
import { checkRateLimit, getClientIP } from './rate-limit';
import * as v from 'valibot';

// ============================================================================
// Validation Schemas
// ============================================================================

const ListUsersQuerySchema = v.object({
  page: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1))),
  limit: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1), v.maxValue(100))),
  search: v.optional(v.string()),
  role: v.optional(v.string()),
});

const CreateUserSchema = v.object({
  email: v.pipe(v.string(), v.email()),
  initialRole: v.optional(v.string()),
  sendInvite: v.optional(v.boolean()),
});

const UpdateUserSchema = v.object({
  email: v.optional(v.pipe(v.string(), v.email())),
});

const AssignRoleSchema = v.object({
  roleId: v.pipe(v.string(), v.minLength(1)),
  expiresAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
});

// ============================================================================
// Type Definitions
// ============================================================================

interface UserRecord {
  id: string;
  email: string;
  created_at: string;
  password_reset_required: boolean;
}

interface UserWithRoles extends UserRecord {
  roles: Array<{
    id: string;
    name: string;
    assigned_at: number;
    expires_at: number | null;
  }>;
}

// ============================================================================
// Route Handler Class
// ============================================================================

export class AdminUserRoutes {
  constructor(private db: D1Database, private kv: KVNamespace) {}

  /**
   * Route handler for admin user endpoints
   */
  async handle(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    // ========================================================================
    // User CRUD Routes
    // ========================================================================
    if (path === '/admin/users' && method === 'GET') {
      return this.listUsers(request, url, env);
    }
    if (path === '/admin/users' && method === 'POST') {
      return this.createUser(request, env);
    }
    if (path.match(/^\/admin\/users\/[^/]+$/) && method === 'GET') {
      const userId = path.split('/').pop()!;
      return this.getUser(userId, request, env);
    }
    if (path.match(/^\/admin\/users\/[^/]+$/) && method === 'PUT') {
      const userId = path.split('/').pop()!;
      return this.updateUser(userId, request, env);
    }
    if (path.match(/^\/admin\/users\/[^/]+$/) && method === 'DELETE') {
      const userId = path.split('/').pop()!;
      return this.deleteUser(userId, request, env);
    }

    // ========================================================================
    // User Role Management Routes
    // ========================================================================
    if (path.match(/^\/admin\/users\/[^/]+\/roles$/) && method === 'GET') {
      const userId = path.split('/')[3];
      return this.getUserRoles(userId, request, env);
    }
    if (path.match(/^\/admin\/users\/[^/]+\/roles$/) && method === 'POST') {
      const userId = path.split('/')[3];
      return this.assignRole(userId, request, env);
    }
    if (path.match(/^\/admin\/users\/[^/]+\/roles\/[^/]+$/) && method === 'DELETE') {
      const parts = path.split('/');
      const userId = parts[3];
      const roleId = parts[5];
      return this.removeRole(userId, roleId, request, env);
    }

    return new Response('Not Found', { status: 404 });
  }

  // ==========================================================================
  // User CRUD Handlers
  // ==========================================================================

  /**
   * GET /admin/users - List all users with pagination and filtering
   */
  private async listUsers(request: Request, url: URL, env: Env): Promise<Response> {
    try {
      await verifyAdminRequest(request, env, 'admin:users');

      // Parse query parameters
      const queryParams = Object.fromEntries(url.searchParams);
      const params = v.parse(ListUsersQuerySchema, queryParams);

      const page = params.page || 1;
      const limit = params.limit || 50;
      const offset = (page - 1) * limit;

      // Build dynamic query
      const whereConditions: string[] = [];
      const bindParams: unknown[] = [];

      if (params.search) {
        whereConditions.push('u.email LIKE ?');
        bindParams.push(`%${params.search}%`);
      }

      if (params.role) {
        whereConditions.push(`
          EXISTS (
            SELECT 1 FROM rbac_user_roles ur
            JOIN rbac_roles r ON ur.role_id = r.id
            WHERE ur.user_id = u.id AND r.name = ?
            AND (ur.expires_at IS NULL OR ur.expires_at > unixepoch() * 1000)
          )
        `);
        bindParams.push(params.role);
      }

      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

      // Count total matching records
      const countQuery = `SELECT COUNT(*) as total FROM user u ${whereClause}`;
      const countResult = await this.db.prepare(countQuery).bind(...bindParams).first<{ total: number }>();
      const total = countResult?.total || 0;

      // Fetch paginated users with roles
      const dataQuery = `
        SELECT
          u.id,
          u.email,
          u.created_at,
          u.password_reset_required,
          GROUP_CONCAT(r.name) as role_names,
          GROUP_CONCAT(r.id) as role_ids
        FROM user u
        LEFT JOIN rbac_user_roles ur ON u.id = ur.user_id
          AND (ur.expires_at IS NULL OR ur.expires_at > unixepoch() * 1000)
        LEFT JOIN rbac_roles r ON ur.role_id = r.id
        ${whereClause}
        GROUP BY u.id
        ORDER BY u.created_at DESC
        LIMIT ? OFFSET ?
      `;

      const result = await this.db.prepare(dataQuery)
        .bind(...bindParams, limit, offset)
        .all<{
          id: string;
          email: string;
          created_at: string;
          password_reset_required: boolean;
          role_names: string | null;
          role_ids: string | null;
        }>();

      // Transform results
      const users = (result.results || []).map(user => {
        const roleNames = user.role_names ? user.role_names.split(',') : [];
        const roleIds = user.role_ids ? user.role_ids.split(',') : [];
        const roles = roleNames.map((name, i) => ({
          id: roleIds[i] || '',
          name,
        }));

        return {
          id: user.id,
          email: user.email,
          created_at: user.created_at,
          password_reset_required: user.password_reset_required,
          roles,
        };
      });

      return new Response(JSON.stringify({
        users,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to list users', {
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof v.ValiError) {
        return createAuthErrorResponse('Invalid query parameters: ' + error.message, 400);
      }

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to list users',
        error instanceof Error && error.message.includes('required') ? 401 : 500
      );
    }
  }

  /**
   * GET /admin/users/:id - Get user details with roles
   */
  private async getUser(userId: string, request: Request, env: Env): Promise<Response> {
    try {
      await verifyAdminRequest(request, env, 'admin:users');

      // Get user
      const user = await this.db.prepare(`
        SELECT id, email, created_at, password_reset_required
        FROM user WHERE id = ?
      `).bind(userId).first<UserRecord>();

      if (!user) {
        return createAuthErrorResponse('User not found', 404);
      }

      // Get user roles
      const rolesResult = await this.db.prepare(`
        SELECT r.id, r.name, ur.assigned_at, ur.expires_at
        FROM rbac_user_roles ur
        JOIN rbac_roles r ON ur.role_id = r.id
        WHERE ur.user_id = ?
          AND (ur.expires_at IS NULL OR ur.expires_at > unixepoch() * 1000)
        ORDER BY ur.assigned_at DESC
      `).bind(userId).all<{
        id: string;
        name: string;
        assigned_at: number;
        expires_at: number | null;
      }>();

      const userWithRoles: UserWithRoles = {
        ...user,
        roles: rolesResult.results || [],
      };

      return new Response(JSON.stringify(userWithRoles), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to get user', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to get user',
        error instanceof Error && error.message.includes('required') ? 401 : 500
      );
    }
  }

  /**
   * POST /admin/users - Create a new user
   * Supports both session auth and M2M auth
   */
  private async createUser(request: Request, env: Env): Promise<Response> {
    try {
      const authContext = await verifyAdminRequest(request, env, 'admin:users');
      const actorId = getActorId(authContext);

      // Rate limiting
      const clientIP = getClientIP(request);
      const rateLimit = await checkRateLimit(this.kv, `admin:user:create:${clientIP}`, 10, 3600);
      if (!rateLimit.allowed) {
        return createAuthErrorResponse('Rate limit exceeded', 429);
      }

      const body = await request.json();
      const validated = v.parse(CreateUserSchema, body);

      // Check if user already exists
      const existing = await this.db.prepare(
        'SELECT id FROM user WHERE email = ?'
      ).bind(validated.email).first<{ id: string }>();

      if (existing) {
        return createAuthErrorResponse('User with this email already exists', 409);
      }

      // Create user (admin-initiated, requires password reset)
      const result = await this.db.prepare(`
        INSERT INTO user (email, password_reset_required)
        VALUES (?, TRUE)
        RETURNING id, email, created_at
      `).bind(validated.email).first<{ id: string; email: string; created_at: string }>();

      if (!result) {
        throw new Error('Failed to create user');
      }

      // Assign initial role if specified
      const roleId = validated.initialRole === 'admin' ? 'role_admin_default' : 'role_member_default';
      await this.db.prepare(`
        INSERT INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by)
        VALUES (?, ?, 'default', unixepoch() * 1000, ?)
      `).bind(result.id, roleId, actorId).run();

      // Emit audit event
      await emitAuditEvent(
        createUserManagementEvent(
          AuditEventType.USER_CREATED,
          result.id,
          result.email,
          actorId,
          {
            initialRole: validated.initialRole || 'member',
            authType: isM2MAuth(authContext) ? 'm2m' : 'session',
          }
        )
      );

      logger.info('User created by admin', {
        userId: result.id,
        email: result.email,
        createdBy: actorId,
        authType: isM2MAuth(authContext) ? 'm2m' : 'session',
      });

      return new Response(JSON.stringify({
        id: result.id,
        email: result.email,
        created_at: result.created_at,
        password_reset_required: true,
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to create user', {
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof v.ValiError) {
        return createAuthErrorResponse('Invalid request: ' + error.message, 400);
      }

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to create user',
        500
      );
    }
  }

  /**
   * PUT /admin/users/:id - Update user
   * Supports both session auth and M2M auth
   */
  private async updateUser(userId: string, request: Request, env: Env): Promise<Response> {
    try {
      const authContext = await verifyAdminRequest(request, env, 'admin:users');
      const actorId = getActorId(authContext);

      const body = await request.json();
      const validated = v.parse(UpdateUserSchema, body);

      if (!validated.email) {
        return createAuthErrorResponse('No updates provided', 400);
      }

      // Check user exists
      const existing = await this.db.prepare(
        'SELECT id, email FROM user WHERE id = ?'
      ).bind(userId).first<{ id: string; email: string }>();

      if (!existing) {
        return createAuthErrorResponse('User not found', 404);
      }

      // Check email uniqueness if changing
      if (validated.email && validated.email !== existing.email) {
        const emailTaken = await this.db.prepare(
          'SELECT id FROM user WHERE email = ? AND id != ?'
        ).bind(validated.email, userId).first<{ id: string }>();

        if (emailTaken) {
          return createAuthErrorResponse('Email already in use', 409);
        }
      }

      // Update user
      const result = await this.db.prepare(`
        UPDATE user SET email = ? WHERE id = ?
        RETURNING id, email, created_at, password_reset_required
      `).bind(validated.email, userId).first<UserRecord>();

      // Emit audit event
      await emitAuditEvent(
        createUserManagementEvent(
          AuditEventType.USER_UPDATED,
          userId,
          validated.email,
          actorId,
          {
            previousEmail: existing.email,
            authType: isM2MAuth(authContext) ? 'm2m' : 'session',
          }
        )
      );

      logger.info('User updated by admin', {
        userId,
        updatedBy: actorId,
        authType: isM2MAuth(authContext) ? 'm2m' : 'session',
      });

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to update user', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof v.ValiError) {
        return createAuthErrorResponse('Invalid request: ' + error.message, 400);
      }

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to update user',
        500
      );
    }
  }

  /**
   * DELETE /admin/users/:id - Delete user
   * Supports both session auth and M2M auth
   */
  private async deleteUser(userId: string, request: Request, env: Env): Promise<Response> {
    try {
      const authContext = await verifyAdminRequest(request, env, 'admin:users');
      const actorId = getActorId(authContext);

      // Rate limiting for destructive operations
      const clientIP = getClientIP(request);
      const rateLimit = await checkRateLimit(this.kv, `admin:user:delete:${clientIP}`, 5, 3600);
      if (!rateLimit.allowed) {
        return createAuthErrorResponse('Rate limit exceeded', 429);
      }

      // Check user exists
      const user = await this.db.prepare(
        'SELECT id, email FROM user WHERE id = ?'
      ).bind(userId).first<{ id: string; email: string }>();

      if (!user) {
        return createAuthErrorResponse('User not found', 404);
      }

      // Prevent self-deletion (only for session auth)
      if (!isM2MAuth(authContext) && userId === authContext.user.id) {
        return createAuthErrorResponse('Cannot delete your own account', 400);
      }

      // Delete user (cascades to roles, sessions, tokens via foreign keys)
      await this.db.prepare('DELETE FROM user WHERE id = ?').bind(userId).run();

      // Emit audit event
      await emitAuditEvent(
        createUserManagementEvent(
          AuditEventType.USER_DELETED,
          userId,
          user.email,
          actorId,
          { authType: isM2MAuth(authContext) ? 'm2m' : 'session' }
        )
      );

      logger.warn('User deleted by admin', {
        userId,
        email: user.email,
        deletedBy: actorId,
        authType: isM2MAuth(authContext) ? 'm2m' : 'session',
      });

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to delete user', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to delete user',
        500
      );
    }
  }

  // ==========================================================================
  // User Role Management Handlers
  // ==========================================================================

  /**
   * GET /admin/users/:id/roles - Get user's roles
   */
  private async getUserRoles(userId: string, request: Request, env: Env): Promise<Response> {
    try {
      await verifyAdminRequest(request, env, 'admin:roles');

      const roles = await this.db.prepare(`
        SELECT
          r.id,
          r.name,
          r.description,
          r.is_system,
          ur.assigned_at,
          ur.expires_at,
          ur.assigned_by
        FROM rbac_user_roles ur
        JOIN rbac_roles r ON ur.role_id = r.id
        WHERE ur.user_id = ?
        ORDER BY ur.assigned_at DESC
      `).bind(userId).all<{
        id: string;
        name: string;
        description: string | null;
        is_system: boolean;
        assigned_at: number;
        expires_at: number | null;
        assigned_by: string;
      }>();

      return new Response(JSON.stringify({
        userId,
        roles: roles.results || [],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to get user roles', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to get user roles',
        500
      );
    }
  }

  /**
   * POST /admin/users/:id/roles - Assign role to user
   * Supports both session auth and M2M auth
   */
  private async assignRole(userId: string, request: Request, env: Env): Promise<Response> {
    try {
      const authContext = await verifyAdminRequest(request, env, 'admin:roles');
      const actorId = getActorId(authContext);

      const body = await request.json();
      const validated = v.parse(AssignRoleSchema, body);

      // Check user exists
      const user = await this.db.prepare(
        'SELECT id, email FROM user WHERE id = ?'
      ).bind(userId).first<{ id: string; email: string }>();

      if (!user) {
        return createAuthErrorResponse('User not found', 404);
      }

      // Check role exists
      const role = await this.db.prepare(
        'SELECT id, name FROM rbac_roles WHERE id = ?'
      ).bind(validated.roleId).first<{ id: string; name: string }>();

      if (!role) {
        return createAuthErrorResponse('Role not found', 404);
      }

      // Check if already assigned
      const existing = await this.db.prepare(`
        SELECT id FROM rbac_user_roles
        WHERE user_id = ? AND role_id = ?
          AND (expires_at IS NULL OR expires_at > unixepoch() * 1000)
      `).bind(userId, validated.roleId).first<{ id: string }>();

      if (existing) {
        return createAuthErrorResponse('Role already assigned to user', 409);
      }

      // Assign role
      const expiresAt = validated.expiresAt ? new Date(validated.expiresAt).getTime() : null;

      await this.db.prepare(`
        INSERT INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by, expires_at)
        VALUES (?, ?, 'default', unixepoch() * 1000, ?, ?)
      `).bind(userId, validated.roleId, actorId, expiresAt).run();

      // Invalidate permissions cache
      await this.kv.delete(`permissions:${userId}`);

      // Emit audit event
      await emitAuditEvent(
        createRoleManagementEvent(
          AuditEventType.ROLE_ASSIGNED,
          role.id,
          role.name,
          actorId,
          {
            userId,
            userEmail: user.email,
            expiresAt: validated.expiresAt,
            authType: isM2MAuth(authContext) ? 'm2m' : 'session',
          }
        )
      );

      logger.info('Role assigned to user', {
        userId,
        roleId: validated.roleId,
        roleName: role.name,
        assignedBy: actorId,
        authType: isM2MAuth(authContext) ? 'm2m' : 'session',
      });

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to assign role', {
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
   * DELETE /admin/users/:id/roles/:roleId - Remove role from user
   * Supports both session auth and M2M auth
   */
  private async removeRole(userId: string, roleId: string, request: Request, env: Env): Promise<Response> {
    try {
      const authContext = await verifyAdminRequest(request, env, 'admin:roles');
      const actorId = getActorId(authContext);

      // Check user exists
      const user = await this.db.prepare(
        'SELECT id, email FROM user WHERE id = ?'
      ).bind(userId).first<{ id: string; email: string }>();

      if (!user) {
        return createAuthErrorResponse('User not found', 404);
      }

      // Get role info
      const role = await this.db.prepare(
        'SELECT id, name FROM rbac_roles WHERE id = ?'
      ).bind(roleId).first<{ id: string; name: string }>();

      if (!role) {
        return createAuthErrorResponse('Role not found', 404);
      }

      // Remove role assignment
      const result = await this.db.prepare(`
        DELETE FROM rbac_user_roles WHERE user_id = ? AND role_id = ?
      `).bind(userId, roleId).run();

      if (!result.meta?.changes || result.meta.changes === 0) {
        return createAuthErrorResponse('Role not assigned to user', 404);
      }

      // Invalidate permissions cache
      await this.kv.delete(`permissions:${userId}`);

      // Emit audit event
      await emitAuditEvent(
        createRoleManagementEvent(
          AuditEventType.ROLE_REMOVED,
          role.id,
          role.name,
          actorId,
          {
            userId,
            userEmail: user.email,
            authType: isM2MAuth(authContext) ? 'm2m' : 'session',
          }
        )
      );

      logger.info('Role removed from user', {
        userId,
        roleId,
        roleName: role.name,
        removedBy: actorId,
        authType: isM2MAuth(authContext) ? 'm2m' : 'session',
      });

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to remove role', {
        userId,
        roleId,
        error: error instanceof Error ? error.message : String(error),
      });

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to remove role',
        500
      );
    }
  }
}
