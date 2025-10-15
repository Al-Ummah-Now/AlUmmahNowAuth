/**
 * Role Service
 *
 * Core service for managing roles and role assignments.
 * Implements ALL P0 security measures from rbac-security-implementation.md:
 * - System role protection (prevent modification/deletion)
 * - Privilege escalation prevention checks
 * - canGrantPermissions() validation
 * - Parameterized queries with .bind() to prevent SQL injection
 * - Comprehensive audit logging
 *
 * @module role-service
 */

import { D1Database } from '@cloudflare/workers-types';
import { KVNamespace } from '@cloudflare/workers-types';
import {
  Role,
  RoleData,
  Permission,
  PermissionGrantCheck,
  UserRole,
  SYSTEM_ROLES,
  isSystemRoleName
} from './rbac-types';
import { PermissionService } from './permission-service';
import { logger } from './logger';

/**
 * Service for managing roles and role assignments
 *
 * @class RoleService
 */
export class RoleService {
  private db: D1Database;
  private cache: KVNamespace;
  private permissionService: PermissionService;

  constructor(db: D1Database, cache: KVNamespace) {
    this.db = db;
    this.cache = cache;
    this.permissionService = new PermissionService(db, cache);
  }

  /**
   * Check if role is a system role
   *
   * P0-4: System role protection
   *
   * @private
   * @param roleId - Role ID to check
   * @returns True if role is a system role
   */
  private async isSystemRole(roleId: string): Promise<boolean> {
    // P0-1: Use parameterized query
    const role = await this.db.prepare(
      `SELECT is_system FROM roles WHERE id = ?`
    ).bind(roleId).first<{ is_system: boolean }>();

    return role?.is_system === true || role?.is_system === 1;
  }

  /**
   * Check if role name is a system role name
   *
   * P0-4: System role protection
   *
   * @private
   * @param roleName - Role name to check
   * @returns True if role name is a system role
   */
  private async isSystemRoleByName(roleName: string): Promise<boolean> {
    // P0-1: Use parameterized query
    const role = await this.db.prepare(
      `SELECT is_system FROM roles WHERE name = ?`
    ).bind(roleName).first<{ is_system: boolean }>();

    return role?.is_system === true || role?.is_system === 1;
  }

  /**
   * Check if granter can grant specific permissions
   *
   * P0-3: Privilege escalation prevention
   * Enforces "you can only grant what you have" rule
   *
   * @private
   * @param granterId - ID of user attempting to grant permissions
   * @param permissionIds - Array of permission IDs to grant
   * @returns Grant check result with allowed status and missing permissions
   */
  async canGrantPermissions(
    granterId: string,
    permissionIds: string[]
  ): Promise<PermissionGrantCheck> {
    // Get granter's effective permissions
    const granterPerms = await this.permissionService.getUserPermissions(granterId);

    // Get the permissions being granted
    if (permissionIds.length === 0) {
      return { allowed: true, missingPermissions: [] };
    }

    // P0-1: Build parameterized query for multiple permission IDs
    const placeholders = permissionIds.map(() => '?').join(',');
    const permissions = await this.db.prepare(
      `SELECT id, name FROM permissions WHERE id IN (${placeholders})`
    ).bind(...permissionIds).all<Permission>();

    const missingPermissions: string[] = [];

    for (const perm of permissions.results || []) {
      // P0-3: Special case - super admin permission can only be granted by existing super admin
      if (perm.name === '*:*:*') {
        const hasSuperAdmin = await this.permissionService.hasPermission(
          granterId,
          '*:*:*'
        );
        if (!hasSuperAdmin) {
          missingPermissions.push(perm.name);
          logger.warn('[RBAC] Privilege escalation attempt - super admin', {
            granterId,
            attemptedPermission: perm.name
          });
        }
        continue;
      }

      // Check if granter has this specific permission
      const hasPermission = await this.permissionService.hasPermission(
        granterId,
        perm.name
      );

      if (!hasPermission) {
        missingPermissions.push(perm.name);
        logger.warn('[RBAC] Privilege escalation attempt', {
          granterId,
          attemptedPermission: perm.name
        });
      }
    }

    const allowed = missingPermissions.length === 0;

    if (!allowed) {
      logger.error('[AUDIT] Privilege escalation prevented', {
        granterId,
        missingPermissions,
        attemptedCount: permissionIds.length
      });
    }

    return {
      allowed,
      missingPermissions
    };
  }

  /**
   * Get role by ID
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   *
   * @param roleId - Role ID
   * @returns Role or null if not found
   */
  async getRole(roleId: string): Promise<Role | null> {
    // P0-1: ALWAYS use parameterized queries
    const result = await this.db.prepare(
      `SELECT * FROM roles WHERE id = ?`
    ).bind(roleId).first<Role>();

    return result;
  }

  /**
   * Get role by name
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   *
   * @param name - Role name
   * @returns Role or null if not found
   */
  async getRoleByName(name: string): Promise<Role | null> {
    // P0-1: ALWAYS use parameterized queries
    const result = await this.db.prepare(
      `SELECT * FROM roles WHERE name = ?`
    ).bind(name).first<Role>();

    return result;
  }

  /**
   * Get all roles
   *
   * P0-1: SQL Injection Prevention - static query
   *
   * @returns Array of all roles
   */
  async getAllRoles(): Promise<Role[]> {
    const result = await this.db.prepare(
      `SELECT * FROM roles ORDER BY name`
    ).all<Role>();

    return result.results || [];
  }

  /**
   * Create a new role
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   *
   * @param data - Role data
   * @param createdBy - User ID who created the role
   * @returns Created role
   */
  async createRole(data: RoleData, createdBy: string): Promise<Role> {
    // Check if role name already exists
    const existing = await this.getRoleByName(data.name);
    if (existing) {
      throw new Error(`Role already exists: ${data.name}`);
    }

    // Check if trying to create a system role name
    if (isSystemRoleName(data.name)) {
      throw new Error(
        `Security violation: Cannot create role with system role name: ${data.name}`
      );
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Validate parent role exists if specified
    if (data.parent_role_id) {
      const parentRole = await this.getRole(data.parent_role_id);
      if (!parentRole) {
        throw new Error(`Parent role not found: ${data.parent_role_id}`);
      }
    }

    // P0-1: ALWAYS use parameterized queries
    await this.db.prepare(
      `INSERT INTO roles (id, name, description, parent_role_id, is_system, metadata, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      data.name,
      data.description || null,
      data.parent_role_id || null,
      false, // New roles are not system roles
      JSON.stringify(data.metadata || {}),
      now,
      now,
      createdBy,
      createdBy
    ).run();

    // Invalidate caches
    await this.permissionService.invalidateAllCaches();

    logger.info('[AUDIT] Role created', {
      id,
      name: data.name,
      createdBy,
      createdAt: now
    });

    return {
      id,
      name: data.name,
      description: data.description,
      parent_role_id: data.parent_role_id,
      is_system: false,
      metadata: data.metadata,
      created_at: new Date(now),
      updated_at: new Date(now),
      created_by: createdBy,
      updated_by: createdBy
    };
  }

  /**
   * Update role with system role protection
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   * P0-4: System role protection
   *
   * @param roleId - Role ID to update
   * @param updates - Partial role data to update
   * @param updatedBy - User ID who updated the role
   * @returns Updated role or throws error
   */
  async updateRole(
    roleId: string,
    updates: Partial<RoleData>,
    updatedBy: string
  ): Promise<Role> {
    // P0-4: CRITICAL - Prevent modification of system roles
    if (await this.isSystemRole(roleId)) {
      throw new Error(
        `Security violation: Cannot modify system role ${roleId}. System roles are protected.`
      );
    }

    // P0-4: Prevent setting is_system flag
    if ('is_system' in updates) {
      throw new Error(
        `Security violation: Cannot modify is_system flag. This is a protected field.`
      );
    }

    // Check if trying to rename to a system role name
    if (updates.name && isSystemRoleName(updates.name)) {
      throw new Error(
        `Security violation: Cannot rename role to system role name: ${updates.name}`
      );
    }

    // Build update query
    const fields: string[] = [];
    const bindings: any[] = [];

    if (updates.name !== undefined) {
      // Check if new name already exists
      const existing = await this.getRoleByName(updates.name);
      if (existing && existing.id !== roleId) {
        throw new Error(`Role name already exists: ${updates.name}`);
      }
      fields.push('name = ?');
      bindings.push(updates.name);
    }

    if (updates.description !== undefined) {
      fields.push('description = ?');
      bindings.push(updates.description);
    }

    if (updates.parent_role_id !== undefined) {
      // Validate parent role exists
      if (updates.parent_role_id) {
        const parentRole = await this.getRole(updates.parent_role_id);
        if (!parentRole) {
          throw new Error(`Parent role not found: ${updates.parent_role_id}`);
        }
        // Prevent circular hierarchy
        if (updates.parent_role_id === roleId) {
          throw new Error('Role cannot be its own parent');
        }
      }
      fields.push('parent_role_id = ?');
      bindings.push(updates.parent_role_id);
    }

    if (updates.metadata !== undefined) {
      fields.push('metadata = ?');
      bindings.push(JSON.stringify(updates.metadata));
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    fields.push('updated_by = ?');
    bindings.push(updatedBy);
    bindings.push(roleId);

    // P0-1: ALWAYS use parameterized queries
    await this.db.prepare(
      `UPDATE roles SET ${fields.join(', ')} WHERE id = ?`
    ).bind(...bindings).run();

    // Invalidate caches
    await this.permissionService.invalidateAllCaches();

    logger.info('[AUDIT] Role updated', {
      roleId,
      updatedBy,
      changes: Object.keys(updates)
    });

    const updatedRole = await this.getRole(roleId);
    if (!updatedRole) {
      throw new Error(`Failed to retrieve updated role: ${roleId}`);
    }

    return updatedRole;
  }

  /**
   * Delete role with system role protection
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   * P0-4: System role protection
   *
   * @param roleId - Role ID to delete
   * @param deletedBy - User ID who deleted the role
   */
  async deleteRole(roleId: string, deletedBy: string): Promise<void> {
    // P0-4: CRITICAL - Prevent deletion of system roles
    if (await this.isSystemRole(roleId)) {
      throw new Error(
        `Security violation: Cannot delete system role ${roleId}. System roles are protected.`
      );
    }

    // Check if role is in use
    const usageCount = await this.db.prepare(
      `SELECT COUNT(*) as count FROM user_roles WHERE role_id = ?`
    ).bind(roleId).first<{ count: number }>();

    if (usageCount && usageCount.count > 0) {
      throw new Error(
        `Cannot delete role ${roleId}: Currently assigned to ${usageCount.count} user(s)`
      );
    }

    // Check if role has child roles
    const childCount = await this.db.prepare(
      `SELECT COUNT(*) as count FROM roles WHERE parent_role_id = ?`
    ).bind(roleId).first<{ count: number }>();

    if (childCount && childCount.count > 0) {
      throw new Error(
        `Cannot delete role ${roleId}: Has ${childCount.count} child role(s)`
      );
    }

    // P0-1: ALWAYS use parameterized queries
    await this.db.prepare(
      `DELETE FROM roles WHERE id = ?`
    ).bind(roleId).run();

    // Invalidate caches
    await this.permissionService.invalidateAllCaches();

    logger.info('[AUDIT] Role deleted', {
      roleId,
      deletedBy,
      deletedAt: new Date().toISOString()
    });
  }

  /**
   * Assign role to user with privilege escalation check
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   * P0-3: Privilege escalation prevention
   *
   * @param userId - User ID to assign role to
   * @param roleId - Role ID to assign
   * @param grantedBy - User ID who granted the role
   * @param expiresAt - Optional expiration date
   */
  async assignRoleToUser(
    userId: string,
    roleId: string,
    grantedBy: string,
    expiresAt?: Date
  ): Promise<void> {
    // Check if role exists
    const role = await this.getRole(roleId);
    if (!role) {
      throw new Error(`Role not found: ${roleId}`);
    }

    // Get all permissions in the role
    const rolePermissions = await this.db.prepare(
      `SELECT permission_id FROM role_permissions WHERE role_id = ?`
    ).bind(roleId).all<{ permission_id: string }>();

    const permissionIds = (rolePermissions.results || []).map(rp => rp.permission_id);

    // P0-3: CRITICAL - Check if granter can grant these permissions
    const check = await this.canGrantPermissions(grantedBy, permissionIds);

    if (!check.allowed) {
      throw new Error(
        `Privilege escalation prevented: You cannot grant permissions you don't have: ${check.missingPermissions.join(', ')}`
      );
    }

    // Check if user already has this role
    const existing = await this.db.prepare(
      `SELECT id FROM user_roles WHERE user_id = ? AND role_id = ?`
    ).bind(userId, roleId).first();

    if (existing) {
      logger.warn('[RBAC] User already has role', { userId, roleId });
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const expires = expiresAt ? expiresAt.toISOString() : null;

    // P0-1: ALWAYS use parameterized queries
    await this.db.prepare(
      `INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, expires_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    ).bind(id, userId, roleId, grantedBy, now, expires).run();

    // Invalidate caches
    await this.permissionService.invalidateAllCaches();

    logger.info('[AUDIT] Role assigned to user', {
      userId,
      roleId,
      roleName: role.name,
      grantedBy,
      expiresAt: expires,
      grantedAt: now
    });
  }

  /**
   * Remove role from user
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   *
   * @param userId - User ID to remove role from
   * @param roleId - Role ID to remove
   * @param removedBy - User ID who removed the role
   */
  async removeRoleFromUser(
    userId: string,
    roleId: string,
    removedBy: string
  ): Promise<void> {
    // P0-1: ALWAYS use parameterized queries
    const result = await this.db.prepare(
      `DELETE FROM user_roles WHERE user_id = ? AND role_id = ?`
    ).bind(userId, roleId).run();

    if ((result.meta?.changes || 0) === 0) {
      logger.warn('[RBAC] User role not found', { userId, roleId });
      return;
    }

    // Invalidate caches
    await this.permissionService.invalidateAllCaches();

    logger.info('[AUDIT] Role removed from user', {
      userId,
      roleId,
      removedBy,
      removedAt: new Date().toISOString()
    });
  }

  /**
   * Get user's roles
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   *
   * @param userId - User ID
   * @returns Array of user's active roles
   */
  async getUserRoles(userId: string): Promise<UserRole[]> {
    // P0-1: ALWAYS use parameterized queries
    const result = await this.db.prepare(`
      SELECT
        ur.id,
        ur.user_id,
        ur.role_id,
        ur.granted_by,
        ur.granted_at,
        ur.expires_at,
        ur.is_active,
        r.name as role_name,
        r.description as role_description,
        r.is_system as role_is_system
      FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE ur.user_id = ?
        AND ur.is_active = 1
        AND (ur.expires_at IS NULL OR ur.expires_at > datetime('now'))
      ORDER BY r.name
    `).bind(userId).all<any>();

    return (result.results || []).map(row => ({
      userId: row.user_id,
      roleId: row.role_id,
      grantedBy: row.granted_by,
      grantedAt: new Date(row.granted_at),
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      isActive: row.is_active === 1,
      role: {
        id: row.role_id,
        name: row.role_name,
        description: row.role_description,
        is_system: row.role_is_system === 1
      }
    }));
  }

  /**
   * Get role permissions
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   *
   * @param roleId - Role ID
   * @returns Array of permissions assigned to the role
   */
  async getRolePermissions(roleId: string): Promise<Permission[]> {
    // P0-1: ALWAYS use parameterized queries
    const result = await this.db.prepare(`
      SELECT
        p.id,
        p.name,
        p.resource,
        p.action,
        p.scope,
        p.description,
        p.is_system,
        p.metadata,
        p.created_at
      FROM role_permissions rp
      JOIN permissions p ON rp.permission_id = p.id
      WHERE rp.role_id = ?
      ORDER BY p.resource, p.action, p.scope
    `).bind(roleId).all<Permission>();

    return result.results || [];
  }

  /**
   * Modify role permissions with system role protection and privilege escalation check
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   * P0-3: Privilege escalation prevention
   * P0-4: System role protection
   *
   * @param roleId - Role ID
   * @param operation - Grant or revoke operation
   * @param permissionId - Permission ID
   * @param modifiedBy - User ID who modified the permissions
   */
  async modifyRolePermissions(
    roleId: string,
    operation: 'grant' | 'revoke',
    permissionId: string,
    modifiedBy: string
  ): Promise<void> {
    // P0-4: CRITICAL - Prevent modification of system role permissions
    if (await this.isSystemRole(roleId)) {
      throw new Error(
        `Security violation: Cannot modify permissions for system role ${roleId}. System roles are protected.`
      );
    }

    // P0-3: Check privilege escalation
    const check = await this.canGrantPermissions(modifiedBy, [permissionId]);
    if (!check.allowed) {
      throw new Error(
        `Privilege escalation prevented: You cannot modify permission '${check.missingPermissions[0]}' that you don't have`
      );
    }

    // Proceed with operation
    if (operation === 'grant') {
      await this.permissionService.grantPermissionToRole(
        roleId,
        permissionId,
        modifiedBy
      );
    } else {
      await this.permissionService.revokePermissionFromRole(
        roleId,
        permissionId,
        modifiedBy
      );
    }
  }

  /**
   * Grant permission directly to user with privilege escalation check
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   * P0-3: Privilege escalation prevention
   *
   * @param userId - User ID
   * @param permissionId - Permission ID
   * @param grantedBy - User ID who granted the permission
   * @param reason - Reason for direct grant
   * @param expiresAt - Optional expiration date
   */
  async grantPermissionToUser(
    userId: string,
    permissionId: string,
    grantedBy: string,
    reason: string,
    expiresAt?: Date
  ): Promise<void> {
    // P0-3: CRITICAL - Check if granter can grant this permission
    const check = await this.canGrantPermissions(grantedBy, [permissionId]);

    if (!check.allowed) {
      throw new Error(
        `Privilege escalation prevented: You cannot grant permission '${check.missingPermissions[0]}' that you don't have`
      );
    }

    // Proceed with permission grant
    await this.permissionService.grantPermissionToUser(
      userId,
      permissionId,
      grantedBy,
      reason,
      expiresAt
    );
  }

  /**
   * Bulk assign multiple roles to a user with privilege escalation check
   *
   * P0-3: Privilege escalation prevention
   *
   * @param userId - User ID
   * @param roleIds - Array of role IDs to assign
   * @param grantedBy - User ID who granted the roles
   */
  async bulkAssignRolesToUser(
    userId: string,
    roleIds: string[],
    grantedBy: string
  ): Promise<{ success: string[]; failed: string[] }> {
    const success: string[] = [];
    const failed: string[] = [];

    for (const roleId of roleIds) {
      try {
        await this.assignRoleToUser(userId, roleId, grantedBy);
        success.push(roleId);
      } catch (error) {
        logger.error('[RBAC] Failed to assign role', {
          userId,
          roleId,
          grantedBy,
          error: error instanceof Error ? error.message : String(error)
        });
        failed.push(roleId);
      }
    }

    return { success, failed };
  }

  /**
   * Get users with a specific role
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   *
   * @param roleId - Role ID
   * @returns Array of user IDs with the role
   */
  async getUsersWithRole(roleId: string): Promise<string[]> {
    // P0-1: ALWAYS use parameterized queries
    const result = await this.db.prepare(`
      SELECT DISTINCT user_id
      FROM user_roles
      WHERE role_id = ?
        AND is_active = 1
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY user_id
    `).bind(roleId).all<{ user_id: string }>();

    return (result.results || []).map(row => row.user_id);
  }

  /**
   * Deactivate expired role assignments
   *
   * @returns Number of deactivated assignments
   */
  async deactivateExpiredRoles(): Promise<number> {
    const result = await this.db.prepare(`
      UPDATE user_roles
      SET is_active = 0
      WHERE is_active = 1
        AND expires_at IS NOT NULL
        AND expires_at <= datetime('now')
    `).run();

    const deactivated = result.meta?.changes || 0;

    if (deactivated > 0) {
      // Invalidate caches
      await this.permissionService.invalidateAllCaches();

      logger.info('[AUDIT] Expired roles deactivated', {
        count: deactivated,
        deactivatedAt: new Date().toISOString()
      });
    }

    return deactivated;
  }
}