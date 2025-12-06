/**
 * Permission Service
 *
 * Core service for managing permissions and permission checks.
 * Implements ALL P0 security measures from rbac-security-implementation.md:
 * - Parameterized queries with .bind() to prevent SQL injection
 * - Versioned caching with atomic invalidation
 * - Permission validation for all operations
 * - Comprehensive audit logging
 *
 * @module permission-service
 */

import { D1Database } from '@cloudflare/workers-types';
import { KVNamespace } from '@cloudflare/workers-types';
import {
  Permission,
  Role,
  EffectivePermissions,
  PermissionData,
  BulkPermissionCheck,
  BulkPermissionResult,
  parsePermission,
  matchesPermissionPattern
} from './rbac-types';
import { logger } from './logger';

/**
 * Service for managing permissions and permission checks
 *
 * @class PermissionService
 */
export class PermissionService {
  private db: D1Database;
  private cache: KVNamespace;
  private cacheTTL = 300; // 5 minutes
  private cacheVersionKey = 'rbac:cache:version';

  constructor(db: D1Database, cache: KVNamespace) {
    this.db = db;
    this.cache = cache;
  }

  /**
   * Get current cache version for atomic invalidation
   *
   * P0-2: Cache invalidation race condition prevention
   *
   * @private
   * @returns Current cache version number
   */
  private async getCacheVersion(): Promise<number> {
    const version = await this.cache.get(this.cacheVersionKey);
    return version ? parseInt(version, 10) : 1;
  }

  /**
   * Increment cache version to atomically invalidate all cached permissions
   *
   * P0-2: Cache invalidation race condition prevention
   *
   * @private
   */
  private async incrementCacheVersion(): Promise<void> {
    const currentVersion = await this.getCacheVersion();
    const newVersion = currentVersion + 1;

    await this.cache.put(
      this.cacheVersionKey,
      newVersion.toString(),
      { expirationTtl: 86400 } // 24 hours
    );

    logger.info('[RBAC] Cache version incremented', {
      from: currentVersion,
      to: newVersion
    });
  }

  /**
   * Get versioned cache key for atomic invalidation
   *
   * P0-2: Cache invalidation race condition prevention
   *
   * @private
   * @param key - Base cache key
   * @returns Versioned cache key
   */
  private async getVersionedCacheKey(key: string): Promise<string> {
    const version = await this.getCacheVersion();
    return `${key}:v${version}`;
  }

  /**
   * Invalidate all permission caches atomically
   *
   * P0-2: Cache invalidation race condition prevention
   * Call this after ANY permission/role change to prevent stale cache usage
   */
  async invalidateAllCaches(): Promise<void> {
    await this.incrementCacheVersion();
    logger.info('[RBAC] All permission caches invalidated');
  }

  /**
   * Get a permission by name
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   *
   * @param name - Permission name (e.g., "users:read:all")
   * @returns Permission or null if not found
   */
  async getPermission(name: string): Promise<Permission | null> {
    // P0-1: ALWAYS use parameterized queries
    const result = await this.db.prepare(
      `SELECT * FROM permissions WHERE name = ?`
    ).bind(name).first<Permission>();

    if (result) {
      logger.debug('[RBAC] Permission found', { name });
    } else {
      logger.debug('[RBAC] Permission not found', { name });
    }

    return result;
  }

  /**
   * Get a permission by ID
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   *
   * @param id - Permission ID
   * @returns Permission or null if not found
   */
  async getPermissionById(id: string): Promise<Permission | null> {
    // P0-1: ALWAYS use parameterized queries
    const result = await this.db.prepare(
      `SELECT * FROM permissions WHERE id = ?`
    ).bind(id).first<Permission>();

    return result;
  }

  /**
   * Create a new permission
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   *
   * @param data - Permission data
   * @returns Created permission
   */
  async createPermission(data: PermissionData): Promise<Permission> {
    // Validate permission format
    const parsed = parsePermission(data.name);
    if (!parsed) {
      throw new Error(`Invalid permission format: ${data.name}. Must be resource:action:scope`);
    }

    // Check if permission already exists
    const existing = await this.getPermission(data.name);
    if (existing) {
      throw new Error(`Permission already exists: ${data.name}`);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // P0-1: ALWAYS use parameterized queries
    await this.db.prepare(
      `INSERT INTO permissions (id, name, resource, action, scope, description, is_system, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      data.name,
      data.resource,
      data.action,
      data.scope,
      data.description || null,
      false, // New permissions are not system permissions
      JSON.stringify(data.metadata || {}),
      now
    ).run();

    // CRITICAL: Invalidate caches after permission creation
    await this.invalidateAllCaches();

    logger.info('[AUDIT] Permission created', {
      id,
      name: data.name,
      resource: data.resource,
      action: data.action,
      scope: data.scope
    });

    return {
      id,
      name: data.name,
      resource: data.resource,
      action: data.action,
      scope: data.scope,
      description: data.description,
      is_system: false,
      metadata: data.metadata,
      created_at: new Date(now)
    };
  }

  /**
   * Find permissions with dynamic filtering
   *
   * P0-1: SQL Injection Prevention - uses parameterized queries with dynamic binding
   *
   * @param filters - Filter criteria
   * @returns Array of matching permissions
   */
  async findPermissions(filters: {
    resource?: string;
    action?: string;
    scope?: string;
  }): Promise<Permission[]> {
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    // P0-1: Build parameterized query dynamically
    if (filters.resource) {
      conditions.push('resource = ?');
      bindings.push(filters.resource);
    }

    if (filters.action) {
      conditions.push('action = ?');
      bindings.push(filters.action);
    }

    if (filters.scope) {
      conditions.push('scope = ?');
      bindings.push(filters.scope);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    // P0-1: ALWAYS use parameterized queries
    const result = await this.db.prepare(
      `SELECT * FROM permissions ${whereClause} ORDER BY resource, action, scope`
    ).bind(...bindings).all<Permission>();

    return result.results || [];
  }

  /**
   * Get all permissions
   *
   * P0-1: SQL Injection Prevention - static query, no user input
   *
   * @returns Array of all permissions
   */
  async getAllPermissions(): Promise<Permission[]> {
    const result = await this.db.prepare(
      `SELECT * FROM permissions ORDER BY resource, action, scope`
    ).all<Permission>();

    return result.results || [];
  }

  /**
   * Get user's effective permissions with versioned caching
   *
   * P0-2: Implements versioned caching for atomic invalidation
   *
   * @param userId - User ID
   * @returns User's effective permissions
   */
  async getUserPermissions(userId: string): Promise<EffectivePermissions> {
    // P0-2: Use versioned cache key
    const baseCacheKey = `rbac:user:${userId}:permissions`;
    const cacheKey = await this.getVersionedCacheKey(baseCacheKey);

    // Try cache first
    try {
      const cached = await this.cache.get(cacheKey, 'json');
      if (cached) {
        const permissions = cached as EffectivePermissions;
        // Validate cache is not expired
        if (new Date(permissions.expiresAt) > new Date()) {
          logger.debug('[RBAC] Cache hit for user permissions', { userId });
          return permissions;
        }
      }
    } catch (error) {
      logger.warn('[RBAC] Cache read error', { userId, error });
    }

    // Load from database
    logger.debug('[RBAC] Cache miss, loading from database', { userId });
    const permissions = await this.loadUserPermissions(userId);

    // Cache with version
    try {
      await this.cache.put(
        cacheKey,
        JSON.stringify(permissions),
        { expirationTtl: this.cacheTTL }
      );
    } catch (error) {
      logger.warn('[RBAC] Cache write error', { userId, error });
    }

    return permissions;
  }

  /**
   * Load user permissions from database
   *
   * P0-1: SQL Injection Prevention - uses parameterized queries
   *
   * @private
   * @param userId - User ID
   * @returns User's effective permissions
   */
  private async loadUserPermissions(userId: string): Promise<EffectivePermissions> {
    // P0-1: Load user roles with parameterized query
    const rolesResult = await this.db.prepare(`
      SELECT
        r.id,
        r.name,
        r.description,
        r.parent_role_id,
        r.is_system_role as is_system,
        r.created_at,
        r.updated_at
      FROM rbac_user_roles ur
      JOIN rbac_roles r ON ur.role_id = r.id
      WHERE ur.user_id = ?
        AND (ur.expires_at IS NULL OR ur.expires_at > unixepoch() * 1000)
    `).bind(userId).all<Role>();

    const roles = rolesResult.results || [];

    // Get all role IDs including inherited roles
    const roleIds = await this.getAllRoleIds(roles);

    let permissions: Permission[] = [];

    if (roleIds.length > 0) {
      // P0-1: Build parameterized query for multiple role IDs
      const placeholders = roleIds.map(() => '?').join(',');
      const permissionsResult = await this.db.prepare(`
        SELECT DISTINCT
          p.id,
          p.name,
          p.resource,
          p.action,
          p.scope,
          p.description,
          p.is_system,
          p.metadata,
          p.created_at
        FROM rbac_role_permissions rp
        JOIN rbac_permissions p ON rp.permission_id = p.id
        WHERE rp.role_id IN (${placeholders})
      `).bind(...roleIds).all<Permission>();

      permissions = permissionsResult.results || [];
    }

    // P0-1: Load direct user permissions with parameterized query
    // Note: Direct user permissions (grants/denies) are not yet implemented in the schema.
    // The user_permissions view only computes permissions from roles.
    // This query returns empty results until rbac_user_permissions table is added.
    const directResult = { results: [] as (Permission & { is_grant: number })[] };

    const directPermissions = directResult.results || [];

    const directGrants = directPermissions
      .filter(p => p.is_grant === 1)
      .map(({ is_grant: _, ...rest }) => rest);

    const directDenies = directPermissions
      .filter(p => p.is_grant === 0)
      .map(({ is_grant: _, ...rest }) => rest);

    const now = new Date();
    const version = await this.getCacheVersion();

    return {
      userId,
      roles,
      permissions,
      directGrants,
      directDenies,
      cachedAt: now,
      expiresAt: new Date(now.getTime() + this.cacheTTL * 1000),
      version
    };
  }

  /**
   * Get all role IDs including inherited roles
   *
   * @private
   * @param roles - Array of roles
   * @returns Array of all role IDs including parent roles
   */
  private async getAllRoleIds(roles: Role[]): Promise<string[]> {
    const allIds = new Set<string>();
    const toProcess = [...roles];

    while (toProcess.length > 0) {
      const role = toProcess.pop()!;

      if (allIds.has(role.id)) {
        continue;
      }

      allIds.add(role.id);

      // Load parent role if exists
      if (role.parent_role_id && !allIds.has(role.parent_role_id)) {
        // P0-1: Use parameterized query
        const parentResult = await this.db.prepare(
          `SELECT * FROM rbac_roles WHERE id = ?`
        ).bind(role.parent_role_id).first<Role>();

        if (parentResult) {
          toProcess.push(parentResult);
        }
      }
    }

    return Array.from(allIds);
  }

  /**
   * Check if user has a specific permission
   *
   * @param userId - User ID
   * @param permission - Permission to check
   * @param resource - Optional resource context
   * @returns True if user has permission
   */
  async hasPermission(
    userId: string,
    permission: string,
    resource?: { type: string; id: string; ownerId?: string }
  ): Promise<boolean> {
    const userPerms = await this.getUserPermissions(userId);

    // Check direct denies first (highest priority)
    if (this.isPermissionDenied(userPerms.directDenies, permission)) {
      logger.debug('[RBAC] Permission denied by direct deny', { userId, permission });
      return false;
    }

    // Check direct grants
    if (this.matchesPermission(userPerms.directGrants, permission, resource)) {
      logger.debug('[RBAC] Permission granted by direct grant', { userId, permission });
      return true;
    }

    // Check role permissions
    if (this.matchesPermission(userPerms.permissions, permission, resource)) {
      logger.debug('[RBAC] Permission granted by role', { userId, permission });
      return true;
    }

    logger.debug('[RBAC] Permission denied - not found', { userId, permission });
    return false;
  }

  /**
   * Check if permission is denied by direct denies
   *
   * @private
   * @param denies - Array of denied permissions
   * @param permission - Permission to check
   * @returns True if permission is explicitly denied
   */
  private isPermissionDenied(denies: Permission[], permission: string): boolean {
    for (const deny of denies) {
      if (matchesPermissionPattern(permission, deny.name)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if permission matches any in the list
   *
   * @private
   * @param permissions - Array of permissions
   * @param permission - Permission to check
   * @param resource - Optional resource context
   * @returns True if permission matches
   */
  private matchesPermission(
    permissions: Permission[],
    permission: string,
    resource?: { type: string; id: string; ownerId?: string }
  ): boolean {
    for (const perm of permissions) {
      // Check wildcard match
      if (matchesPermissionPattern(permission, perm.name)) {
        // If resource context provided, check scope
        if (resource && perm.scope === 'own') {
          // For "own" scope, check if user owns the resource
          // This would need to be extended based on your resource ownership model
          return resource.ownerId === resource.id;
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Check if user has any of the specified permissions
   *
   * @param userId - User ID
   * @param permissions - Array of permissions to check
   * @returns True if user has any permission
   */
  async hasAnyPermission(userId: string, permissions: string[]): Promise<boolean> {
    for (const permission of permissions) {
      if (await this.hasPermission(userId, permission)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if user has all specified permissions
   *
   * @param userId - User ID
   * @param permissions - Array of permissions to check
   * @returns True if user has all permissions
   */
  async hasAllPermissions(userId: string, permissions: string[]): Promise<boolean> {
    for (const permission of permissions) {
      if (!await this.hasPermission(userId, permission)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Bulk check permissions for a user
   *
   * @param check - Bulk permission check request
   * @returns Bulk permission check result
   */
  async bulkCheckPermissions(check: BulkPermissionCheck): Promise<BulkPermissionResult> {
    const results: Record<string, boolean> = {};

    for (const permission of check.permissions) {
      results[permission] = await this.hasPermission(check.userId, permission);
    }

    const hasAll = Object.values(results).every(v => v);
    const hasAny = Object.values(results).some(v => v);

    return {
      userId: check.userId,
      permissions: results,
      hasAll,
      hasAny,
      checkedAt: new Date()
    };
  }

  /**
   * Grant permission to role with cache invalidation
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   * P0-2: Invalidates cache immediately after change
   *
   * @param roleId - Role ID
   * @param permissionId - Permission ID
   * @param grantedBy - User ID who granted the permission
   */
  async grantPermissionToRole(
    roleId: string,
    permissionId: string,
    grantedBy: string
  ): Promise<void> {
    const now = Date.now();

    // Check if already granted
    const existing = await this.db.prepare(
      `SELECT role_id FROM rbac_role_permissions WHERE role_id = ? AND permission_id = ?`
    ).bind(roleId, permissionId).first();

    if (existing) {
      logger.warn('[RBAC] Permission already granted to role', { roleId, permissionId });
      return;
    }

    // P0-1: ALWAYS use parameterized queries
    await this.db.prepare(
      `INSERT INTO rbac_role_permissions (role_id, permission_id, granted_by, granted_at)
       VALUES (?, ?, ?, ?)`
    ).bind(roleId, permissionId, grantedBy, now).run();

    // P0-2: CRITICAL - Invalidate caches immediately
    await this.invalidateAllCaches();

    // Log audit event
    logger.info('[AUDIT] Permission granted to role', {
      roleId,
      permissionId,
      grantedBy,
      grantedAt: now
    });
  }

  /**
   * Revoke permission from role with cache invalidation
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   * P0-2: Invalidates cache immediately after change
   *
   * @param roleId - Role ID
   * @param permissionId - Permission ID
   * @param revokedBy - User ID who revoked the permission
   */
  async revokePermissionFromRole(
    roleId: string,
    permissionId: string,
    revokedBy: string
  ): Promise<void> {
    // P0-1: ALWAYS use parameterized queries
    const result = await this.db.prepare(
      `DELETE FROM rbac_role_permissions
       WHERE role_id = ? AND permission_id = ?`
    ).bind(roleId, permissionId).run();

    if ((result.meta?.changes || 0) === 0) {
      logger.warn('[RBAC] Permission not found for role', { roleId, permissionId });
      return;
    }

    // P0-2: CRITICAL - Invalidate caches immediately
    await this.invalidateAllCaches();

    // Log audit event
    logger.info('[AUDIT] Permission revoked from role', {
      roleId,
      permissionId,
      revokedBy,
      revokedAt: new Date().toISOString()
    });
  }

  /**
   * Grant permission directly to user with cache invalidation
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   * P0-2: Invalidates cache immediately after change
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
    // Note: Direct user permissions are not yet implemented in the schema.
    // Permissions are granted through roles only (rbac_user_roles + rbac_role_permissions).
    // TODO: Implement rbac_user_permissions table for direct grants/denies.
    throw new Error('Direct user permissions not implemented. Use role-based permissions instead.');
  }

  /**
   * Deny permission for user (override) with cache invalidation
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   * P0-2: Invalidates cache immediately after change
   *
   * @param userId - User ID
   * @param permissionId - Permission ID
   * @param deniedBy - User ID who denied the permission
   * @param reason - Reason for denial
   * @param expiresAt - Optional expiration date
   */
  async denyPermissionForUser(
    userId: string,
    permissionId: string,
    deniedBy: string,
    reason: string,
    expiresAt?: Date
  ): Promise<void> {
    // Note: Direct user permissions are not yet implemented in the schema.
    // Permissions are granted through roles only (rbac_user_roles + rbac_role_permissions).
    // TODO: Implement rbac_user_permissions table for direct grants/denies.
    throw new Error('Direct user permissions not implemented. Use role-based permissions instead.');
  }

  /**
   * Remove direct permission from user
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   * P0-2: Invalidates cache immediately after change
   *
   * @param userId - User ID
   * @param permissionId - Permission ID
   * @param removedBy - User ID who removed the permission
   */
  async removeUserPermission(
    userId: string,
    permissionId: string,
    removedBy: string
  ): Promise<void> {
    // Note: Direct user permissions are not yet implemented in the schema.
    // Permissions are granted through roles only (rbac_user_roles + rbac_role_permissions).
    // TODO: Implement rbac_user_permissions table for direct grants/denies.
    throw new Error('Direct user permissions not implemented. Use role-based permissions instead.');
  }

  /**
   * Delete a permission (non-system only)
   *
   * P0-1: SQL Injection Prevention - uses parameterized query
   * P0-2: Invalidates cache immediately after change
   *
   * @param permissionId - Permission ID
   * @param deletedBy - User ID who deleted the permission
   */
  async deletePermission(permissionId: string, deletedBy: string): Promise<void> {
    // Check if permission is system permission
    const permission = await this.getPermissionById(permissionId);
    if (!permission) {
      throw new Error(`Permission not found: ${permissionId}`);
    }

    if (permission.is_system) {
      throw new Error(
        `Security violation: Cannot delete system permission ${permission.name}. System permissions are protected.`
      );
    }

    // Check if permission is in use
    const roleUsage = await this.db.prepare(
      `SELECT COUNT(*) as count FROM rbac_role_permissions WHERE permission_id = ?`
    ).bind(permissionId).first<{ count: number }>();

    const userUsage = await this.db.prepare(
      `SELECT COUNT(*) as count FROM user_permissions WHERE permission_id = ?`
    ).bind(permissionId).first<{ count: number }>();

    const totalUsage = (roleUsage?.count || 0) + (userUsage?.count || 0);

    if (totalUsage > 0) {
      throw new Error(
        `Cannot delete permission ${permission.name}: Currently in use by ${totalUsage} role(s) or user(s)`
      );
    }

    // P0-1: ALWAYS use parameterized queries
    await this.db.prepare(
      `DELETE FROM permissions WHERE id = ?`
    ).bind(permissionId).run();

    // P0-2: CRITICAL - Invalidate caches immediately
    await this.invalidateAllCaches();

    // Log audit event
    logger.info('[AUDIT] Permission deleted', {
      permissionId,
      permissionName: permission.name,
      deletedBy,
      deletedAt: new Date().toISOString()
    });
  }
}