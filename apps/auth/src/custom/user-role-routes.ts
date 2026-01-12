/**
 * @fileoverview User Role Management Routes
 *
 * Custom role assignment endpoints preserved from the legacy admin implementation.
 * These endpoints include audit event emission and cache invalidation that are not
 * part of OpenAuth's standard API.
 *
 * Features:
 * - Role assignment with expiration support
 * - Role removal with validation
 * - Audit event tracking for role changes
 * - KV cache invalidation on role updates
 * - Support for both session and M2M authentication
 */

import { Hono } from 'hono';
import * as v from 'valibot';
import {
  verifyAdminRequest,
  createAuthErrorResponse,
  isM2MAuth,
  getActorId,
} from '../auth-middleware';
import { logger } from '../logger';
import { emitAuditEvent } from '../audit-emitter-enhanced';
import {
  AuditEventType,
  createRoleManagementEvent,
} from '../audit-events';

// ============================================================================
// Validation Schemas
// ============================================================================

const AssignRoleSchema = v.object({
  roleId: v.pipe(v.string(), v.minLength(1)),
  expiresAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
});

// ============================================================================
// Route Factory
// ============================================================================

/**
 * Creates a Hono router with user role management endpoints
 */
export function userRoleRoutes(db: D1Database, kv: KVNamespace) {
  const app = new Hono();

  /**
   * GET /:userId/roles - Get user's roles
   * Note: Mounted on adminUserApp which handles /admin/users/*
   * The router rewrites /admin/users/* to /* so paths should be without /users prefix
   */
  app.get('/:userId/roles', async (c) => {
    const userId = c.req.param('userId');

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await verifyAdminRequest(c.req.raw, { AUTH_DB: db, AUTH_STORAGE: kv } as any, 'admin:roles');

      const roles = await db.prepare(`
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

      return c.json({
        userId,
        roles: roles.results || [],
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
  });

  /**
   * POST /:userId/roles - Assign role to user
   * Supports both session auth and M2M auth
   */
  app.post('/:userId/roles', async (c) => {
    const userId = c.req.param('userId');

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const authContext = await verifyAdminRequest(c.req.raw, { AUTH_DB: db, AUTH_STORAGE: kv } as any, 'admin:roles');
      const actorId = getActorId(authContext);

      const body = await c.req.json();
      const validated = v.parse(AssignRoleSchema, body);

      // Check user exists
      const user = await db.prepare(
        'SELECT id, email FROM users WHERE id = ?'
      ).bind(userId).first<{ id: string; email: string }>();

      if (!user) {
        return createAuthErrorResponse('User not found', 404);
      }

      // Check role exists
      const role = await db.prepare(
        'SELECT id, name FROM rbac_roles WHERE id = ?'
      ).bind(validated.roleId).first<{ id: string; name: string }>();

      if (!role) {
        return createAuthErrorResponse('Role not found', 404);
      }

      // Check if already assigned
      const existing = await db.prepare(`
        SELECT 1 as exists_flag FROM rbac_user_roles
        WHERE user_id = ? AND role_id = ?
          AND (expires_at IS NULL OR expires_at > unixepoch() * 1000)
      `).bind(userId, validated.roleId).first<{ exists_flag: number }>();

      if (existing) {
        return createAuthErrorResponse('Role already assigned to user', 409);
      }

      // Assign role
      const expiresAt = validated.expiresAt ? new Date(validated.expiresAt).getTime() : null;

      await db.prepare(`
        INSERT INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by, expires_at)
        VALUES (?, ?, 'default', unixepoch() * 1000, ?, ?)
      `).bind(userId, validated.roleId, actorId, expiresAt).run();

      // Invalidate permissions cache
      await kv.delete(`permissions:${userId}`);

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

      return c.json({ success: true });
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
  });

  /**
   * DELETE /:userId/roles/:roleId - Remove role from user
   * Supports both session auth and M2M auth
   */
  app.delete('/:userId/roles/:roleId', async (c) => {
    const userId = c.req.param('userId');
    const roleId = c.req.param('roleId');

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const authContext = await verifyAdminRequest(c.req.raw, { AUTH_DB: db, AUTH_STORAGE: kv } as any, 'admin:roles');
      const actorId = getActorId(authContext);

      // Check user exists
      const user = await db.prepare(
        'SELECT id, email FROM users WHERE id = ?'
      ).bind(userId).first<{ id: string; email: string }>();

      if (!user) {
        return createAuthErrorResponse('User not found', 404);
      }

      // Get role info
      const role = await db.prepare(
        'SELECT id, name FROM rbac_roles WHERE id = ?'
      ).bind(roleId).first<{ id: string; name: string }>();

      if (!role) {
        return createAuthErrorResponse('Role not found', 404);
      }

      // Remove role assignment
      const result = await db.prepare(`
        DELETE FROM rbac_user_roles WHERE user_id = ? AND role_id = ?
      `).bind(userId, roleId).run();

      if (!result.meta?.changes || result.meta.changes === 0) {
        return createAuthErrorResponse('Role not assigned to user', 404);
      }

      // Invalidate permissions cache
      await kv.delete(`permissions:${userId}`);

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

      return c.json({ success: true });
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
  });

  return app;
}
