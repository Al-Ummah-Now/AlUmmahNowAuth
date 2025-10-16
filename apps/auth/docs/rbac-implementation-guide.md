# RBAC Implementation Guide

## Table of Contents
1. [Introduction](#introduction)
2. [System Architecture](#system-architecture)
3. [Database Design](#database-design)
4. [Core Components](#core-components)
5. [API Implementation](#api-implementation)
6. [Permission Checking](#permission-checking)
7. [Caching Strategy](#caching-strategy)
8. [Migration Process](#migration-process)
9. [Admin Interface](#admin-interface)
10. [Security Considerations](#security-considerations)
11. [Testing Strategy](#testing-strategy)
12. [Performance Optimization](#performance-optimization)
13. [Troubleshooting](#troubleshooting)
14. [Code Examples](#code-examples)
15. [Deployment Guide](#deployment-guide)

## 1. Introduction

This guide provides a complete implementation roadmap for the Role-Based Access Control (RBAC) system in the Al Ummah Now platform. The system is designed to work with Cloudflare Workers, D1 database, and KV storage.

### Goals
- Replace binary admin/user roles with flexible RBAC
- Support fine-grained permissions
- Enable resource-based access control
- Maintain backward compatibility
- Optimize for edge performance
- Integrate with existing audit system

### Key Concepts
- **Role**: A collection of permissions assigned to users
- **Permission**: An authorization to perform an action on a resource
- **Resource**: An entity in the system (users, content, settings)
- **Action**: An operation (read, write, delete, manage)
- **Scope**: The boundary of the permission (own, team, all)

## 2. System Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         Client Apps                          │
│                    (Web, Admin, Mobile)                      │
└─────────────┬───────────────────────────────┬───────────────┘
              │                               │
              ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────────┐
│     Auth Service        │     │      Application APIs        │
│  (OpenAuth + RBAC)      │────▶│   (Protected Endpoints)      │
└────────┬────────────────┘     └──────────┬──────────────────┘
         │                                  │
         ▼                                  ▼
┌─────────────────────────────────────────────────────────────┐
│                    RBAC Middleware Layer                     │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  Permission  │  │   Context    │  │    Cache     │      │
│  │   Checker    │  │   Builder    │  │   Manager    │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────┬────────────────────────────┬──────────────────┘
              │                            │
              ▼                            ▼
┌─────────────────────────┐     ┌────────────────────────────┐
│      D1 Database        │     │       KV Storage           │
│   (Roles, Permissions)  │     │   (Permission Cache)       │
└─────────────────────────┘     └────────────────────────────┘
```

### Data Flow

1. **Authentication Flow**
   ```
   User Login → OpenAuth → JWT with User ID → Session Creation
   ```

2. **Authorization Flow**
   ```
   Request → Extract User ID → Load Permissions → Check Access → Allow/Deny
   ```

3. **Permission Loading**
   ```
   Check KV Cache → If Miss → Load from D1 → Cache in KV → Return Permissions
   ```

## 3. Database Design

### Schema Definition

```sql
-- 1. Roles table: Defines available roles
CREATE TABLE roles (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  parent_role_id TEXT REFERENCES roles(id) ON DELETE SET NULL,
  is_system BOOLEAN DEFAULT FALSE, -- System roles cannot be deleted
  metadata TEXT DEFAULT '{}', -- JSON for additional properties
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES user(id),
  updated_by TEXT REFERENCES user(id)
);

-- 2. Permissions table: Defines available permissions
CREATE TABLE permissions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT UNIQUE NOT NULL, -- Format: resource:action:scope
  resource TEXT NOT NULL,
  action TEXT NOT NULL,
  scope TEXT DEFAULT '*',
  description TEXT,
  is_system BOOLEAN DEFAULT FALSE,
  metadata TEXT DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Role-Permission mapping
CREATE TABLE role_permissions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_by TEXT REFERENCES user(id),
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(role_id, permission_id)
);

-- 4. User-Role mapping (users can have multiple roles)
CREATE TABLE user_roles (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_by TEXT REFERENCES user(id),
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP, -- For temporary role assignments
  is_active BOOLEAN DEFAULT TRUE,
  UNIQUE(user_id, role_id)
);

-- 5. Direct user permissions (override roles)
CREATE TABLE user_permissions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  is_grant BOOLEAN DEFAULT TRUE, -- TRUE = grant, FALSE = deny (override)
  granted_by TEXT REFERENCES user(id),
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,
  reason TEXT, -- Why this direct permission was granted/denied
  UNIQUE(user_id, permission_id)
);

-- 6. Resource permissions (future enhancement)
CREATE TABLE resource_permissions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  user_id TEXT REFERENCES user(id),
  role_id TEXT REFERENCES roles(id),
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_by TEXT REFERENCES user(id),
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,
  CHECK ((user_id IS NOT NULL AND role_id IS NULL) OR
         (user_id IS NULL AND role_id IS NOT NULL))
);

-- 7. Permission policies (complex rules)
CREATE TABLE permission_policies (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  policy_type TEXT NOT NULL, -- 'condition', 'time_based', 'attribute_based'
  conditions TEXT NOT NULL, -- JSON policy definition
  priority INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Essential Indexes

```sql
-- Performance indexes
CREATE INDEX idx_user_roles_user ON user_roles(user_id, is_active);
CREATE INDEX idx_user_roles_expires ON user_roles(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_role_permissions_role ON role_permissions(role_id);
CREATE INDEX idx_permissions_resource ON permissions(resource, action, scope);
CREATE INDEX idx_user_permissions_user ON user_permissions(user_id);
CREATE INDEX idx_resource_permissions_lookup ON resource_permissions(resource_type, resource_id);
CREATE INDEX idx_roles_parent ON roles(parent_role_id) WHERE parent_role_id IS NOT NULL;

-- Audit indexes
CREATE INDEX idx_user_roles_granted_by ON user_roles(granted_by, granted_at);
CREATE INDEX idx_role_permissions_granted_by ON role_permissions(granted_by, granted_at);
```

### Views for Optimization

```sql
-- Materialized view for user's effective permissions
CREATE VIEW user_effective_permissions AS
SELECT
  ur.user_id,
  p.id as permission_id,
  p.name as permission_name,
  p.resource,
  p.action,
  p.scope,
  'role' as source,
  r.name as source_name
FROM user_roles ur
JOIN roles r ON ur.role_id = r.id
JOIN role_permissions rp ON r.id = rp.role_id
JOIN permissions p ON rp.permission_id = p.id
WHERE ur.is_active = TRUE
  AND (ur.expires_at IS NULL OR ur.expires_at > CURRENT_TIMESTAMP)

UNION ALL

-- Include inherited permissions from parent roles
SELECT
  ur.user_id,
  p.id as permission_id,
  p.name as permission_name,
  p.resource,
  p.action,
  p.scope,
  'inherited' as source,
  parent_r.name as source_name
FROM user_roles ur
JOIN roles r ON ur.role_id = r.id
JOIN roles parent_r ON r.parent_role_id = parent_r.id
JOIN role_permissions rp ON parent_r.id = rp.role_id
JOIN permissions p ON rp.permission_id = p.id
WHERE ur.is_active = TRUE
  AND (ur.expires_at IS NULL OR ur.expires_at > CURRENT_TIMESTAMP)

UNION ALL

-- Direct user permissions (grants)
SELECT
  up.user_id,
  p.id as permission_id,
  p.name as permission_name,
  p.resource,
  p.action,
  p.scope,
  'direct_grant' as source,
  'Direct Grant' as source_name
FROM user_permissions up
JOIN permissions p ON up.permission_id = p.id
WHERE up.is_grant = TRUE
  AND (up.expires_at IS NULL OR up.expires_at > CURRENT_TIMESTAMP);
```

## 4. Core Components

### 4.1 Permission Model

```typescript
// types/rbac.ts
export interface Permission {
  id: string;
  name: string; // Format: resource:action:scope
  resource: string;
  action: string;
  scope: string;
  description?: string;
  isSystem: boolean;
  metadata?: Record<string, any>;
}

export interface Role {
  id: string;
  name: string;
  description?: string;
  parentRoleId?: string;
  isSystem: boolean;
  permissions?: Permission[];
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserRole {
  userId: string;
  roleId: string;
  role?: Role;
  grantedBy: string;
  grantedAt: Date;
  expiresAt?: Date;
  isActive: boolean;
}

export interface PermissionCheck {
  userId: string;
  permission: string;
  resource?: {
    type: string;
    id: string;
    ownerId?: string;
  };
  context?: Record<string, any>;
}

export interface EffectivePermissions {
  userId: string;
  roles: Role[];
  permissions: Permission[];
  directGrants: Permission[];
  directDenies: Permission[];
  cachedAt: Date;
  expiresAt: Date;
}
```

### 4.2 Permission Service

```typescript
// services/permission.service.ts
import { D1Database } from '@cloudflare/workers-types';
import { KVNamespace } from '@cloudflare/workers-types';
import { Permission, Role, EffectivePermissions } from '../types/rbac';

export class PermissionService {
  private db: D1Database;
  private cache: KVNamespace;
  private cachePrefix = 'perms:';
  private cacheTTL = 300; // 5 minutes

  constructor(db: D1Database, cache: KVNamespace) {
    this.db = db;
    this.cache = cache;
  }

  /**
   * Get all effective permissions for a user
   */
  async getUserPermissions(userId: string): Promise<EffectivePermissions> {
    // Try cache first
    const cacheKey = `${this.cachePrefix}${userId}`;
    const cached = await this.cache.get(cacheKey, 'json');

    if (cached && this.isCacheValid(cached as EffectivePermissions)) {
      return cached as EffectivePermissions;
    }

    // Load from database
    const permissions = await this.loadUserPermissions(userId);

    // Cache the result
    await this.cache.put(
      cacheKey,
      JSON.stringify(permissions),
      { expirationTtl: this.cacheTTL }
    );

    return permissions;
  }

  /**
   * Check if user has a specific permission
   */
  async hasPermission(
    userId: string,
    permission: string,
    resource?: { type: string; id: string; ownerId?: string }
  ): Promise<boolean> {
    const userPerms = await this.getUserPermissions(userId);

    // Check direct denies first (highest priority)
    if (this.isPermissionDenied(userPerms.directDenies, permission)) {
      return false;
    }

    // Check direct grants
    if (this.matchesPermission(userPerms.directGrants, permission, resource)) {
      return true;
    }

    // Check role permissions
    if (this.matchesPermission(userPerms.permissions, permission, resource)) {
      return true;
    }

    return false;
  }

  /**
   * Check multiple permissions at once
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
   * Load user permissions from database
   */
  private async loadUserPermissions(userId: string): Promise<EffectivePermissions> {
    // Load user roles
    const rolesResult = await this.db.prepare(`
      SELECT
        r.id,
        r.name,
        r.description,
        r.parent_role_id,
        r.is_system,
        r.metadata
      FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE ur.user_id = ?
        AND ur.is_active = TRUE
        AND (ur.expires_at IS NULL OR ur.expires_at > datetime('now'))
    `).bind(userId).all<Role>();

    // Load permissions for all roles (including inherited)
    const roleIds = this.getAllRoleIds(rolesResult.results);

    const permissionsResult = await this.db.prepare(`
      SELECT DISTINCT
        p.id,
        p.name,
        p.resource,
        p.action,
        p.scope,
        p.description,
        p.is_system,
        p.metadata
      FROM role_permissions rp
      JOIN permissions p ON rp.permission_id = p.id
      WHERE rp.role_id IN (${roleIds.map(() => '?').join(',')})
    `).bind(...roleIds).all<Permission>();

    // Load direct user permissions
    const directResult = await this.db.prepare(`
      SELECT
        p.*,
        up.is_grant
      FROM user_permissions up
      JOIN permissions p ON up.permission_id = p.id
      WHERE up.user_id = ?
        AND (up.expires_at IS NULL OR up.expires_at > datetime('now'))
    `).bind(userId).all<any>();

    const directGrants = directResult.results
      .filter(p => p.is_grant)
      .map(({ is_grant, ...rest }) => rest);

    const directDenies = directResult.results
      .filter(p => !p.is_grant)
      .map(({ is_grant, ...rest }) => rest);

    return {
      userId,
      roles: rolesResult.results,
      permissions: permissionsResult.results,
      directGrants,
      directDenies,
      cachedAt: new Date(),
      expiresAt: new Date(Date.now() + this.cacheTTL * 1000)
    };
  }

  /**
   * Get all role IDs including inherited roles
   */
  private getAllRoleIds(roles: Role[]): string[] {
    const allIds = new Set<string>();

    const addRoleAndParents = async (roleId: string) => {
      if (allIds.has(roleId)) return;

      allIds.add(roleId);

      const role = roles.find(r => r.id === roleId);
      if (role?.parentRoleId) {
        await addRoleAndParents(role.parentRoleId);
      }
    };

    for (const role of roles) {
      addRoleAndParents(role.id);
    }

    return Array.from(allIds);
  }

  /**
   * Check if permission matches request
   */
  private matchesPermission(
    permissions: Permission[],
    requested: string,
    resource?: { type: string; id: string; ownerId?: string }
  ): boolean {
    const [reqResource, reqAction, reqScope] = requested.split(':');

    for (const perm of permissions) {
      // Check for wildcard permission
      if (perm.name === '*:*:*' || perm.name === 'super_admin') {
        return true;
      }

      // Check resource match (with wildcards)
      if (!this.matchesPattern(perm.resource, reqResource)) {
        continue;
      }

      // Check action match (with wildcards)
      if (!this.matchesPattern(perm.action, reqAction)) {
        continue;
      }

      // Check scope match
      if (!this.matchesScope(perm.scope, reqScope, resource)) {
        continue;
      }

      return true;
    }

    return false;
  }

  /**
   * Check if permission is explicitly denied
   */
  private isPermissionDenied(denies: Permission[], requested: string): boolean {
    return this.matchesPermission(denies, requested);
  }

  /**
   * Pattern matching with wildcard support
   */
  private matchesPattern(pattern: string, value: string): boolean {
    if (pattern === '*' || pattern === value) {
      return true;
    }

    // Convert pattern to regex (e.g., "user:*" matches "user:read", "user:write")
    const regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special chars
      .replace(/\*/g, '.*'); // Convert * to .*

    return new RegExp(`^${regexPattern}$`).test(value);
  }

  /**
   * Check scope constraints
   */
  private matchesScope(
    permScope: string,
    requestedScope: string,
    resource?: { type: string; id: string; ownerId?: string }
  ): boolean {
    // Wildcard scope matches everything
    if (permScope === '*' || requestedScope === '*') {
      return true;
    }

    // Exact match
    if (permScope === requestedScope) {
      return true;
    }

    // Hierarchical scope check
    const scopeHierarchy = ['own', 'team', 'org', 'all'];
    const permLevel = scopeHierarchy.indexOf(permScope);
    const reqLevel = scopeHierarchy.indexOf(requestedScope);

    // Higher level permission grants lower level access
    if (permLevel >= 0 && reqLevel >= 0 && permLevel >= reqLevel) {
      return true;
    }

    // Resource-specific scope check
    if (resource && permScope === 'own' && requestedScope === 'own') {
      // User can only access their own resources
      // This would need the current user ID to properly validate
      return true; // Simplified for example
    }

    return false;
  }

  /**
   * Invalidate user permission cache
   */
  async invalidateUserCache(userId: string): Promise<void> {
    const cacheKey = `${this.cachePrefix}${userId}`;
    await this.cache.delete(cacheKey);
  }

  /**
   * Check if cache is still valid
   */
  private isCacheValid(cached: EffectivePermissions): boolean {
    return cached.expiresAt > new Date();
  }
}
```

### 4.3 Role Service

```typescript
// services/role.service.ts
export class RoleService {
  private db: D1Database;
  private auditService: AuditService;

  constructor(db: D1Database, auditService: AuditService) {
    this.db = db;
    this.auditService = auditService;
  }

  /**
   * Create a new role
   */
  async createRole(
    role: Omit<Role, 'id' | 'createdAt' | 'updatedAt'>,
    createdBy: string
  ): Promise<Role> {
    const id = crypto.randomUUID();

    const result = await this.db.prepare(`
      INSERT INTO roles (
        id, name, description, parent_role_id,
        is_system, metadata, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).bind(
      id,
      role.name,
      role.description || null,
      role.parentRoleId || null,
      role.isSystem || false,
      JSON.stringify(role.metadata || {}),
      createdBy,
      createdBy
    ).first<Role>();

    await this.auditService.log({
      eventType: 'role.created',
      userId: createdBy,
      metadata: { roleId: id, roleName: role.name },
      severity: 'info',
      success: true
    });

    return result!;
  }

  /**
   * Assign permissions to a role
   */
  async assignPermissions(
    roleId: string,
    permissionIds: string[],
    grantedBy: string
  ): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO role_permissions (role_id, permission_id, granted_by)
      VALUES (?, ?, ?)
    `);

    const batch = permissionIds.map(permId =>
      stmt.bind(roleId, permId, grantedBy)
    );

    await this.db.batch(batch);

    await this.auditService.log({
      eventType: 'role.permissions_assigned',
      userId: grantedBy,
      metadata: { roleId, permissionCount: permissionIds.length },
      severity: 'info',
      success: true
    });

    // Invalidate cache for all users with this role
    await this.invalidateRoleUsersCache(roleId);
  }

  /**
   * Revoke permissions from a role
   */
  async revokePermissions(
    roleId: string,
    permissionIds: string[],
    revokedBy: string
  ): Promise<void> {
    await this.db.prepare(`
      DELETE FROM role_permissions
      WHERE role_id = ? AND permission_id IN (${permissionIds.map(() => '?').join(',')})
    `).bind(roleId, ...permissionIds).run();

    await this.auditService.log({
      eventType: 'role.permissions_revoked',
      userId: revokedBy,
      metadata: { roleId, permissionCount: permissionIds.length },
      severity: 'warning',
      success: true
    });

    await this.invalidateRoleUsersCache(roleId);
  }

  /**
   * Assign role to user
   */
  async assignUserRole(
    userId: string,
    roleId: string,
    grantedBy: string,
    expiresAt?: Date
  ): Promise<void> {
    await this.db.prepare(`
      INSERT INTO user_roles (user_id, role_id, granted_by, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, role_id) DO UPDATE SET
        granted_by = excluded.granted_by,
        granted_at = CURRENT_TIMESTAMP,
        expires_at = excluded.expires_at,
        is_active = TRUE
    `).bind(
      userId,
      roleId,
      grantedBy,
      expiresAt ? expiresAt.toISOString() : null
    ).run();

    await this.auditService.log({
      eventType: 'user.role_assigned',
      userId: grantedBy,
      metadata: { targetUserId: userId, roleId, expiresAt },
      severity: 'info',
      success: true
    });

    // Invalidate user's permission cache
    const permService = new PermissionService(this.db, this.cache);
    await permService.invalidateUserCache(userId);
  }

  /**
   * Revoke role from user
   */
  async revokeUserRole(
    userId: string,
    roleId: string,
    revokedBy: string
  ): Promise<void> {
    await this.db.prepare(`
      UPDATE user_roles
      SET is_active = FALSE
      WHERE user_id = ? AND role_id = ?
    `).bind(userId, roleId).run();

    await this.auditService.log({
      eventType: 'user.role_revoked',
      userId: revokedBy,
      metadata: { targetUserId: userId, roleId },
      severity: 'warning',
      success: true
    });

    const permService = new PermissionService(this.db, this.cache);
    await permService.invalidateUserCache(userId);
  }

  /**
   * Get all users with a specific role
   */
  async getRoleUsers(roleId: string): Promise<string[]> {
    const result = await this.db.prepare(`
      SELECT DISTINCT user_id
      FROM user_roles
      WHERE role_id = ? AND is_active = TRUE
    `).bind(roleId).all<{ user_id: string }>();

    return result.results.map(r => r.user_id);
  }

  /**
   * Invalidate cache for all users with a role
   */
  private async invalidateRoleUsersCache(roleId: string): Promise<void> {
    const userIds = await this.getRoleUsers(roleId);
    const permService = new PermissionService(this.db, this.cache);

    await Promise.all(
      userIds.map(userId => permService.invalidateUserCache(userId))
    );
  }
}
```

## 5. API Implementation

### 5.1 RBAC API Endpoints

```typescript
// api/rbac.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { PermissionService } from '../services/permission.service';
import { RoleService } from '../services/role.service';
import { requireAuth, requirePermission } from '../middleware/auth';

const app = new Hono();

// Permission check endpoint
app.post('/permissions/check',
  requireAuth(),
  async (c) => {
    const schema = z.object({
      permission: z.string(),
      resource: z.object({
        type: z.string(),
        id: z.string(),
        ownerId: z.string().optional()
      }).optional()
    });

    const body = await c.req.json();
    const { permission, resource } = schema.parse(body);
    const userId = c.get('userId');

    const permService = new PermissionService(c.env.AUTH_DB, c.env.AUTH_STORAGE);
    const hasPermission = await permService.hasPermission(userId, permission, resource);

    return c.json({ hasPermission });
  }
);

// Bulk permission check
app.post('/permissions/bulk-check',
  requireAuth(),
  async (c) => {
    const schema = z.object({
      permissions: z.array(z.string())
    });

    const body = await c.req.json();
    const { permissions } = schema.parse(body);
    const userId = c.get('userId');

    const permService = new PermissionService(c.env.AUTH_DB, c.env.AUTH_STORAGE);
    const results: Record<string, boolean> = {};

    for (const permission of permissions) {
      results[permission] = await permService.hasPermission(userId, permission);
    }

    return c.json({ permissions: results });
  }
);

// Get user's effective permissions
app.get('/users/:userId/permissions',
  requireAuth(),
  requirePermission('users:read:all'),
  async (c) => {
    const userId = c.req.param('userId');
    const permService = new PermissionService(c.env.AUTH_DB, c.env.AUTH_STORAGE);
    const permissions = await permService.getUserPermissions(userId);

    return c.json(permissions);
  }
);

// Role management endpoints
app.get('/roles',
  requireAuth(),
  requirePermission('roles:read:all'),
  async (c) => {
    const result = await c.env.AUTH_DB.prepare(`
      SELECT * FROM roles ORDER BY name
    `).all();

    return c.json({ roles: result.results });
  }
);

app.post('/roles',
  requireAuth(),
  requirePermission('roles:create:all'),
  async (c) => {
    const schema = z.object({
      name: z.string().min(1).max(50),
      description: z.string().optional(),
      parentRoleId: z.string().uuid().optional(),
      permissions: z.array(z.string()).optional()
    });

    const body = await c.req.json();
    const data = schema.parse(body);
    const createdBy = c.get('userId');

    const roleService = new RoleService(c.env.AUTH_DB, c.get('auditService'));
    const role = await roleService.createRole(
      {
        name: data.name,
        description: data.description,
        parentRoleId: data.parentRoleId,
        isSystem: false
      },
      createdBy
    );

    if (data.permissions?.length) {
      await roleService.assignPermissions(role.id, data.permissions, createdBy);
    }

    return c.json(role, 201);
  }
);

app.put('/roles/:roleId',
  requireAuth(),
  requirePermission('roles:update:all'),
  async (c) => {
    const roleId = c.req.param('roleId');
    const schema = z.object({
      name: z.string().min(1).max(50).optional(),
      description: z.string().optional(),
      parentRoleId: z.string().uuid().optional()
    });

    const body = await c.req.json();
    const data = schema.parse(body);
    const updatedBy = c.get('userId');

    // Check if role is system role
    const role = await c.env.AUTH_DB.prepare(
      `SELECT is_system FROM roles WHERE id = ?`
    ).bind(roleId).first<{ is_system: boolean }>();

    if (role?.is_system) {
      return c.json({ error: 'Cannot modify system role' }, 403);
    }

    await c.env.AUTH_DB.prepare(`
      UPDATE roles
      SET name = COALESCE(?, name),
          description = COALESCE(?, description),
          parent_role_id = COALESCE(?, parent_role_id),
          updated_at = CURRENT_TIMESTAMP,
          updated_by = ?
      WHERE id = ?
    `).bind(
      data.name || null,
      data.description || null,
      data.parentRoleId || null,
      updatedBy,
      roleId
    ).run();

    return c.json({ success: true });
  }
);

app.delete('/roles/:roleId',
  requireAuth(),
  requirePermission('roles:delete:all'),
  async (c) => {
    const roleId = c.req.param('roleId');

    // Check if role is system role or has users
    const checks = await c.env.AUTH_DB.prepare(`
      SELECT
        r.is_system,
        COUNT(ur.user_id) as user_count
      FROM roles r
      LEFT JOIN user_roles ur ON r.id = ur.role_id AND ur.is_active = TRUE
      WHERE r.id = ?
      GROUP BY r.id
    `).bind(roleId).first<{ is_system: boolean; user_count: number }>();

    if (checks?.is_system) {
      return c.json({ error: 'Cannot delete system role' }, 403);
    }

    if (checks?.user_count > 0) {
      return c.json({
        error: `Cannot delete role with ${checks.user_count} active users`
      }, 400);
    }

    await c.env.AUTH_DB.prepare(
      `DELETE FROM roles WHERE id = ?`
    ).bind(roleId).run();

    return c.json({ success: true });
  }
);

// Role permission management
app.post('/roles/:roleId/permissions',
  requireAuth(),
  requirePermission('roles:manage:all'),
  async (c) => {
    const roleId = c.req.param('roleId');
    const schema = z.object({
      permissions: z.array(z.string())
    });

    const body = await c.req.json();
    const { permissions } = schema.parse(body);
    const grantedBy = c.get('userId');

    const roleService = new RoleService(c.env.AUTH_DB, c.get('auditService'));
    await roleService.assignPermissions(roleId, permissions, grantedBy);

    return c.json({ success: true });
  }
);

app.delete('/roles/:roleId/permissions',
  requireAuth(),
  requirePermission('roles:manage:all'),
  async (c) => {
    const roleId = c.req.param('roleId');
    const schema = z.object({
      permissions: z.array(z.string())
    });

    const body = await c.req.json();
    const { permissions } = schema.parse(body);
    const revokedBy = c.get('userId');

    const roleService = new RoleService(c.env.AUTH_DB, c.get('auditService'));
    await roleService.revokePermissions(roleId, permissions, revokedBy);

    return c.json({ success: true });
  }
);

// User role management
app.get('/users/:userId/roles',
  requireAuth(),
  requirePermission('users:read:all'),
  async (c) => {
    const userId = c.req.param('userId');

    const result = await c.env.AUTH_DB.prepare(`
      SELECT
        ur.*,
        r.name as role_name,
        r.description as role_description
      FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE ur.user_id = ? AND ur.is_active = TRUE
      ORDER BY r.name
    `).bind(userId).all();

    return c.json({ roles: result.results });
  }
);

app.post('/users/:userId/roles',
  requireAuth(),
  requirePermission('users:manage:all'),
  async (c) => {
    const userId = c.req.param('userId');
    const schema = z.object({
      roleId: z.string(),
      expiresAt: z.string().datetime().optional()
    });

    const body = await c.req.json();
    const { roleId, expiresAt } = schema.parse(body);
    const grantedBy = c.get('userId');

    const roleService = new RoleService(c.env.AUTH_DB, c.get('auditService'));
    await roleService.assignUserRole(
      userId,
      roleId,
      grantedBy,
      expiresAt ? new Date(expiresAt) : undefined
    );

    return c.json({ success: true });
  }
);

app.delete('/users/:userId/roles/:roleId',
  requireAuth(),
  requirePermission('users:manage:all'),
  async (c) => {
    const userId = c.req.param('userId');
    const roleId = c.req.param('roleId');
    const revokedBy = c.get('userId');

    const roleService = new RoleService(c.env.AUTH_DB, c.get('auditService'));
    await roleService.revokeUserRole(userId, roleId, revokedBy);

    return c.json({ success: true });
  }
);

export default app;
```

## 6. Permission Checking

### 6.1 Middleware Implementation

```typescript
// middleware/auth.ts
import { Context, Next } from 'hono';
import { PermissionService } from '../services/permission.service';

/**
 * Require specific permission(s)
 */
export function requirePermission(...permissions: string[]) {
  return async (c: Context, next: Next) => {
    const userId = c.get('userId');

    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const permService = new PermissionService(
      c.env.AUTH_DB,
      c.env.AUTH_STORAGE
    );

    // Check if user has at least one of the required permissions
    const hasPermission = await permService.hasAnyPermission(userId, permissions);

    if (!hasPermission) {
      // Log failed permission check
      await c.get('auditService').log({
        eventType: 'permission.denied',
        userId,
        metadata: {
          required: permissions,
          path: c.req.path,
          method: c.req.method
        },
        severity: 'warning',
        success: false
      });

      return c.json({
        error: 'Insufficient permissions',
        required: permissions
      }, 403);
    }

    await next();
  };
}

/**
 * Require all specified permissions
 */
export function requireAllPermissions(...permissions: string[]) {
  return async (c: Context, next: Next) => {
    const userId = c.get('userId');

    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const permService = new PermissionService(
      c.env.AUTH_DB,
      c.env.AUTH_STORAGE
    );

    const hasAllPermissions = await permService.hasAllPermissions(userId, permissions);

    if (!hasAllPermissions) {
      return c.json({
        error: 'Insufficient permissions',
        required: permissions
      }, 403);
    }

    await next();
  };
}

/**
 * Resource-based permission check
 */
export function requireResourcePermission(
  permissionTemplate: string,
  getResource: (c: Context) => Promise<{ type: string; id: string; ownerId?: string }>
) {
  return async (c: Context, next: Next) => {
    const userId = c.get('userId');

    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const resource = await getResource(c);
    const permission = permissionTemplate.replace(':resource', resource.type);

    const permService = new PermissionService(
      c.env.AUTH_DB,
      c.env.AUTH_STORAGE
    );

    const hasPermission = await permService.hasPermission(
      userId,
      permission,
      resource
    );

    if (!hasPermission) {
      return c.json({
        error: 'Insufficient permissions for this resource'
      }, 403);
    }

    await next();
  };
}
```

### 6.2 Usage Examples

```typescript
// Example: Protecting endpoints with permissions
app.get('/admin/users',
  requireAuth(),
  requirePermission('users:read:all'),
  async (c) => {
    // Only users with 'users:read:all' permission can access
    const users = await getAllUsers(c.env.AUTH_DB);
    return c.json(users);
  }
);

app.delete('/content/:id',
  requireAuth(),
  requireResourcePermission(
    'content:delete::scope',
    async (c) => {
      const contentId = c.req.param('id');
      const content = await getContent(c.env.AUTH_DB, contentId);
      return {
        type: 'content',
        id: contentId,
        ownerId: content.userId
      };
    }
  ),
  async (c) => {
    // User can delete if they have 'content:delete:own' (for their content)
    // or 'content:delete:all' (for any content)
    await deleteContent(c.env.AUTH_DB, c.req.param('id'));
    return c.json({ success: true });
  }
);

// Multiple permission options (OR logic)
app.post('/reports',
  requireAuth(),
  requirePermission('reports:create:all', 'analytics:manage:all'),
  async (c) => {
    // User needs either permission
  }
);

// Require all permissions (AND logic)
app.post('/system/reset',
  requireAuth(),
  requireAllPermissions('system:manage:all', 'admin:super'),
  async (c) => {
    // User needs both permissions
  }
);
```

## 7. Caching Strategy

### 7.1 Cache Design

```typescript
// cache/permission-cache.ts
export class PermissionCache {
  private kv: KVNamespace;
  private ttl: number = 300; // 5 minutes default
  private version: string = 'v1';

  constructor(kv: KVNamespace, ttl?: number) {
    this.kv = kv;
    if (ttl) this.ttl = ttl;
  }

  /**
   * Cache key format: perms:v1:userId
   */
  private getCacheKey(userId: string): string {
    return `perms:${this.version}:${userId}`;
  }

  /**
   * Store permissions in cache
   */
  async set(userId: string, permissions: EffectivePermissions): Promise<void> {
    const key = this.getCacheKey(userId);
    const data = {
      ...permissions,
      cachedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.ttl * 1000).toISOString(),
      version: this.version
    };

    await this.kv.put(
      key,
      JSON.stringify(data),
      {
        expirationTtl: this.ttl,
        metadata: {
          userId,
          roleCount: permissions.roles.length,
          permissionCount: permissions.permissions.length
        }
      }
    );
  }

  /**
   * Get permissions from cache
   */
  async get(userId: string): Promise<EffectivePermissions | null> {
    const key = this.getCacheKey(userId);
    const cached = await this.kv.get(key, 'json');

    if (!cached) {
      return null;
    }

    const data = cached as any;

    // Check version
    if (data.version !== this.version) {
      await this.invalidate(userId);
      return null;
    }

    // Check expiration
    if (new Date(data.expiresAt) < new Date()) {
      await this.invalidate(userId);
      return null;
    }

    return data as EffectivePermissions;
  }

  /**
   * Invalidate user's permission cache
   */
  async invalidate(userId: string): Promise<void> {
    const key = this.getCacheKey(userId);
    await this.kv.delete(key);
  }

  /**
   * Invalidate multiple users' caches
   */
  async invalidateMany(userIds: string[]): Promise<void> {
    await Promise.all(userIds.map(id => this.invalidate(id)));
  }

  /**
   * Clear all permission caches (use sparingly)
   */
  async clearAll(): Promise<void> {
    // List all keys with the permission prefix
    const prefix = `perms:${this.version}:`;
    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const listResult = await this.kv.list({ prefix, cursor });

      // Delete all keys in this batch
      await Promise.all(
        listResult.keys.map(key => this.kv.delete(key.name))
      );

      hasMore = !listResult.list_complete;
      cursor = listResult.cursor;
    }
  }

  /**
   * Warm cache for a user
   */
  async warm(userId: string, loader: () => Promise<EffectivePermissions>): Promise<EffectivePermissions> {
    // Try cache first
    const cached = await this.get(userId);
    if (cached) {
      return cached;
    }

    // Load and cache
    const permissions = await loader();
    await this.set(userId, permissions);
    return permissions;
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    totalKeys: number;
    oldestCache: Date | null;
    newestCache: Date | null;
  }> {
    const prefix = `perms:${this.version}:`;
    const listResult = await this.kv.list({ prefix, limit: 1000 });

    let oldest: Date | null = null;
    let newest: Date | null = null;

    for (const key of listResult.keys) {
      if (key.metadata) {
        const meta = key.metadata as any;
        const cachedAt = new Date(meta.cachedAt);

        if (!oldest || cachedAt < oldest) oldest = cachedAt;
        if (!newest || cachedAt > newest) newest = cachedAt;
      }
    }

    return {
      totalKeys: listResult.keys.length,
      oldestCache: oldest,
      newestCache: newest
    };
  }
}
```

### 7.2 Cache Invalidation Strategy

```typescript
// cache/invalidation.ts
export class CacheInvalidationService {
  private cache: PermissionCache;
  private db: D1Database;

  constructor(cache: PermissionCache, db: D1Database) {
    this.cache = cache;
    this.db = db;
  }

  /**
   * Invalidate caches when role permissions change
   */
  async onRolePermissionChange(roleId: string): Promise<void> {
    // Get all users with this role
    const users = await this.db.prepare(`
      SELECT DISTINCT user_id
      FROM user_roles
      WHERE role_id = ? AND is_active = TRUE
    `).bind(roleId).all<{ user_id: string }>();

    const userIds = users.results.map(u => u.user_id);
    await this.cache.invalidateMany(userIds);
  }

  /**
   * Invalidate when user roles change
   */
  async onUserRoleChange(userId: string): Promise<void> {
    await this.cache.invalidate(userId);

    // Also invalidate any sessions
    await this.invalidateUserSessions(userId);
  }

  /**
   * Invalidate when permissions are directly granted/revoked
   */
  async onDirectPermissionChange(userId: string): Promise<void> {
    await this.cache.invalidate(userId);
  }

  /**
   * Invalidate when role hierarchy changes
   */
  async onRoleHierarchyChange(roleId: string): Promise<void> {
    // Get all child roles
    const childRoles = await this.getChildRoles(roleId);

    // Get all users with any of these roles
    const users = await this.db.prepare(`
      SELECT DISTINCT user_id
      FROM user_roles
      WHERE role_id IN (${childRoles.map(() => '?').join(',')})
        AND is_active = TRUE
    `).bind(...childRoles).all<{ user_id: string }>();

    const userIds = users.results.map(u => u.user_id);
    await this.cache.invalidateMany(userIds);
  }

  /**
   * Get all child roles recursively
   */
  private async getChildRoles(parentId: string): Promise<string[]> {
    const children: string[] = [];

    const directChildren = await this.db.prepare(`
      SELECT id FROM roles WHERE parent_role_id = ?
    `).bind(parentId).all<{ id: string }>();

    for (const child of directChildren.results) {
      children.push(child.id);
      const grandChildren = await this.getChildRoles(child.id);
      children.push(...grandChildren);
    }

    return children;
  }

  /**
   * Invalidate user sessions (force re-authentication)
   */
  private async invalidateUserSessions(userId: string): Promise<void> {
    // Implementation depends on session storage
    // This is a placeholder
    console.log(`Invalidating sessions for user ${userId}`);
  }
}
```

## 8. Migration Process

### 8.1 Migration Plan

```typescript
// migration/rbac-migration.ts
export class RBACMigration {
  private db: D1Database;
  private isDryRun: boolean;

  constructor(db: D1Database, isDryRun = true) {
    this.db = db;
    this.isDryRun = isDryRun;
  }

  /**
   * Main migration entry point
   */
  async migrate(): Promise<void> {
    console.log(`Starting RBAC migration (dry run: ${this.isDryRun})`);

    try {
      // Step 1: Create RBAC tables
      await this.createTables();

      // Step 2: Insert default permissions
      await this.insertDefaultPermissions();

      // Step 3: Create default roles
      await this.createDefaultRoles();

      // Step 4: Migrate existing users
      await this.migrateExistingUsers();

      // Step 5: Verify migration
      await this.verifyMigration();

      console.log('Migration completed successfully');
    } catch (error) {
      console.error('Migration failed:', error);
      throw error;
    }
  }

  /**
   * Create RBAC tables
   */
  private async createTables(): Promise<void> {
    console.log('Creating RBAC tables...');

    if (this.isDryRun) {
      console.log('[DRY RUN] Would create tables: roles, permissions, etc.');
      return;
    }

    // Execute migration SQL file
    // In practice, this would run the SQL from 0011_create_rbac_tables.sql
  }

  /**
   * Insert default permissions
   */
  private async insertDefaultPermissions(): Promise<void> {
    console.log('Inserting default permissions...');

    const permissions = [
      // User permissions
      { name: 'users:create:all', resource: 'users', action: 'create', scope: 'all' },
      { name: 'users:read:all', resource: 'users', action: 'read', scope: 'all' },
      { name: 'users:read:own', resource: 'users', action: 'read', scope: 'own' },
      { name: 'users:update:all', resource: 'users', action: 'update', scope: 'all' },
      { name: 'users:update:own', resource: 'users', action: 'update', scope: 'own' },
      { name: 'users:delete:all', resource: 'users', action: 'delete', scope: 'all' },
      { name: 'users:manage:all', resource: 'users', action: 'manage', scope: 'all' },

      // Role permissions
      { name: 'roles:create:all', resource: 'roles', action: 'create', scope: 'all' },
      { name: 'roles:read:all', resource: 'roles', action: 'read', scope: 'all' },
      { name: 'roles:update:all', resource: 'roles', action: 'update', scope: 'all' },
      { name: 'roles:delete:all', resource: 'roles', action: 'delete', scope: 'all' },
      { name: 'roles:manage:all', resource: 'roles', action: 'manage', scope: 'all' },

      // Content permissions
      { name: 'content:create:all', resource: 'content', action: 'create', scope: 'all' },
      { name: 'content:read:all', resource: 'content', action: 'read', scope: 'all' },
      { name: 'content:read:own', resource: 'content', action: 'read', scope: 'own' },
      { name: 'content:update:all', resource: 'content', action: 'update', scope: 'all' },
      { name: 'content:update:own', resource: 'content', action: 'update', scope: 'own' },
      { name: 'content:delete:all', resource: 'content', action: 'delete', scope: 'all' },
      { name: 'content:delete:own', resource: 'content', action: 'delete', scope: 'own' },
      { name: 'content:publish:all', resource: 'content', action: 'publish', scope: 'all' },
      { name: 'content:publish:own', resource: 'content', action: 'publish', scope: 'own' },

      // Settings permissions
      { name: 'settings:read:all', resource: 'settings', action: 'read', scope: 'all' },
      { name: 'settings:update:all', resource: 'settings', action: 'update', scope: 'all' },
      { name: 'settings:manage:all', resource: 'settings', action: 'manage', scope: 'all' },

      // Audit permissions
      { name: 'audit:read:all', resource: 'audit', action: 'read', scope: 'all' },
      { name: 'audit:export:all', resource: 'audit', action: 'export', scope: 'all' },

      // Analytics permissions
      { name: 'analytics:read:all', resource: 'analytics', action: 'read', scope: 'all' },
      { name: 'analytics:export:all', resource: 'analytics', action: 'export', scope: 'all' },

      // System permissions
      { name: 'system:manage:all', resource: 'system', action: 'manage', scope: 'all' },
      { name: 'system:health:read', resource: 'system', action: 'health', scope: 'read' },

      // Super admin permission
      { name: '*:*:*', resource: '*', action: '*', scope: '*', description: 'Super admin - all permissions' }
    ];

    if (this.isDryRun) {
      console.log(`[DRY RUN] Would insert ${permissions.length} permissions`);
      return;
    }

    const stmt = this.db.prepare(`
      INSERT INTO permissions (name, resource, action, scope, description, is_system)
      VALUES (?, ?, ?, ?, ?, TRUE)
    `);

    await this.db.batch(
      permissions.map(p => stmt.bind(
        p.name,
        p.resource,
        p.action,
        p.scope,
        p.description || `${p.action} ${p.resource} (${p.scope})`,
      ))
    );

    console.log(`Inserted ${permissions.length} default permissions`);
  }

  /**
   * Create default roles
   */
  private async createDefaultRoles(): Promise<void> {
    console.log('Creating default roles...');

    const roles = [
      {
        name: 'super_admin',
        description: 'Super Administrator with all permissions',
        permissions: ['*:*:*']
      },
      {
        name: 'admin',
        description: 'Administrator with most permissions',
        permissions: [
          'users:*:all',
          'roles:read:all',
          'content:*:all',
          'settings:*:all',
          'audit:read:all',
          'analytics:read:all'
        ]
      },
      {
        name: 'moderator',
        description: 'Content moderator',
        permissions: [
          'users:read:all',
          'content:read:all',
          'content:update:all',
          'content:delete:all',
          'content:publish:all'
        ]
      },
      {
        name: 'content_creator',
        description: 'Content creator',
        permissions: [
          'content:create:all',
          'content:read:own',
          'content:update:own',
          'content:delete:own',
          'content:publish:own'
        ]
      },
      {
        name: 'user',
        description: 'Regular user',
        permissions: [
          'users:read:own',
          'users:update:own',
          'content:read:all'
        ]
      }
    ];

    if (this.isDryRun) {
      console.log(`[DRY RUN] Would create ${roles.length} default roles`);
      return;
    }

    for (const roleData of roles) {
      // Create role
      const roleResult = await this.db.prepare(`
        INSERT INTO roles (name, description, is_system)
        VALUES (?, ?, TRUE)
        RETURNING id
      `).bind(roleData.name, roleData.description).first<{ id: string }>();

      if (!roleResult) continue;

      // Get permission IDs
      const permissionIds = await this.db.prepare(`
        SELECT id FROM permissions
        WHERE name IN (${roleData.permissions.map(() => '?').join(',')})
      `).bind(...roleData.permissions).all<{ id: string }>();

      // Assign permissions to role
      const stmt = this.db.prepare(`
        INSERT INTO role_permissions (role_id, permission_id)
        VALUES (?, ?)
      `);

      await this.db.batch(
        permissionIds.results.map(p => stmt.bind(roleResult.id, p.id))
      );

      console.log(`Created role '${roleData.name}' with ${permissionIds.results.length} permissions`);
    }
  }

  /**
   * Migrate existing users to new RBAC system
   */
  private async migrateExistingUsers(): Promise<void> {
    console.log('Migrating existing users...');

    // Get all users with their current role
    const users = await this.db.prepare(`
      SELECT id, email, role FROM user
    `).all<{ id: string; email: string; role: string }>();

    console.log(`Found ${users.results.length} users to migrate`);

    if (this.isDryRun) {
      const adminCount = users.results.filter(u => u.role === 'admin').length;
      const userCount = users.results.filter(u => u.role === 'user').length;
      console.log(`[DRY RUN] Would migrate: ${adminCount} admins, ${userCount} regular users`);
      return;
    }

    // Get role IDs
    const roleMap = await this.db.prepare(`
      SELECT name, id FROM roles WHERE name IN ('admin', 'user')
    `).all<{ name: string; id: string }>();

    const roleIds: Record<string, string> = {};
    roleMap.results.forEach(r => {
      roleIds[r.name] = r.id;
    });

    // Migrate each user
    const stmt = this.db.prepare(`
      INSERT INTO user_roles (user_id, role_id, granted_by)
      VALUES (?, ?, ?)
    `);

    const migrations = users.results.map(user => {
      const roleId = roleIds[user.role] || roleIds['user'];
      return stmt.bind(user.id, roleId, 'system-migration');
    });

    await this.db.batch(migrations);

    console.log(`Migrated ${users.results.length} users to RBAC system`);
  }

  /**
   * Verify migration was successful
   */
  private async verifyMigration(): Promise<void> {
    console.log('Verifying migration...');

    const checks = {
      permissions: await this.db.prepare('SELECT COUNT(*) as count FROM permissions').first<{ count: number }>(),
      roles: await this.db.prepare('SELECT COUNT(*) as count FROM roles').first<{ count: number }>(),
      rolePermissions: await this.db.prepare('SELECT COUNT(*) as count FROM role_permissions').first<{ count: number }>(),
      userRoles: await this.db.prepare('SELECT COUNT(*) as count FROM user_roles').first<{ count: number }>(),
    };

    console.log('Migration verification:');
    console.log(`- Permissions: ${checks.permissions?.count || 0}`);
    console.log(`- Roles: ${checks.roles?.count || 0}`);
    console.log(`- Role-Permission mappings: ${checks.rolePermissions?.count || 0}`);
    console.log(`- User-Role mappings: ${checks.userRoles?.count || 0}`);

    // Verify each user has at least one role
    const usersWithoutRoles = await this.db.prepare(`
      SELECT u.id, u.email
      FROM user u
      LEFT JOIN user_roles ur ON u.id = ur.user_id AND ur.is_active = TRUE
      WHERE ur.id IS NULL
    `).all();

    if (usersWithoutRoles.results.length > 0) {
      console.warn(`Warning: ${usersWithoutRoles.results.length} users have no roles assigned`);
    }
  }
}

// Migration runner
export async function runMigration(env: Env, isDryRun = true): Promise<void> {
  const migration = new RBACMigration(env.AUTH_DB, isDryRun);
  await migration.migrate();
}
```

### 8.2 Rollback Plan

```typescript
// migration/rbac-rollback.ts
export class RBACRollback {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * Rollback RBAC implementation
   */
  async rollback(): Promise<void> {
    console.log('Starting RBAC rollback...');

    try {
      // Step 1: Restore user roles from RBAC to original field
      await this.restoreUserRoles();

      // Step 2: Drop RBAC tables
      await this.dropRBACTables();

      // Step 3: Clear caches
      await this.clearCaches();

      console.log('Rollback completed successfully');
    } catch (error) {
      console.error('Rollback failed:', error);
      throw error;
    }
  }

  /**
   * Restore user roles to original field
   */
  private async restoreUserRoles(): Promise<void> {
    console.log('Restoring user roles...');

    // Update user table with roles from RBAC
    await this.db.prepare(`
      UPDATE user
      SET role = (
        SELECT r.name
        FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id
        WHERE ur.user_id = user.id
          AND ur.is_active = TRUE
          AND r.name IN ('admin', 'user')
        ORDER BY
          CASE r.name
            WHEN 'admin' THEN 1
            ELSE 2
          END
        LIMIT 1
      )
      WHERE EXISTS (
        SELECT 1
        FROM user_roles ur
        WHERE ur.user_id = user.id
      )
    `).run();

    console.log('User roles restored');
  }

  /**
   * Drop RBAC tables
   */
  private async dropRBACTables(): Promise<void> {
    console.log('Dropping RBAC tables...');

    const tables = [
      'resource_permissions',
      'user_permissions',
      'user_roles',
      'role_permissions',
      'permission_policies',
      'permissions',
      'roles'
    ];

    for (const table of tables) {
      await this.db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
      console.log(`Dropped table: ${table}`);
    }
  }

  /**
   * Clear permission caches
   */
  private async clearCaches(): Promise<void> {
    console.log('Clearing permission caches...');
    // Implementation depends on cache storage
    // This would clear all permission-related caches
  }
}
```

## 9. Admin Interface

### 9.1 Role Management UI

```tsx
// admin/components/RoleManagement.tsx
import React, { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Badge } from '../components/ui/badge';
import { Plus, Edit, Trash, Shield, Users } from 'lucide-react';

interface Role {
  id: string;
  name: string;
  description: string;
  isSystem: boolean;
  userCount?: number;
  permissionCount?: number;
}

export function RoleManagement() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [selectedRole, setSelectedRole] = useState<Role | null>(null);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchRoles();
  }, []);

  const fetchRoles = async () => {
    try {
      const response = await fetch('/api/roles');
      const data = await response.json();
      setRoles(data.roles);
    } catch (error) {
      console.error('Failed to fetch roles:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateRole = async (roleData: Partial<Role>) => {
    try {
      const response = await fetch('/api/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(roleData)
      });

      if (response.ok) {
        await fetchRoles();
        setIsCreateDialogOpen(false);
      }
    } catch (error) {
      console.error('Failed to create role:', error);
    }
  };

  const handleUpdateRole = async (roleId: string, updates: Partial<Role>) => {
    try {
      const response = await fetch(`/api/roles/${roleId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });

      if (response.ok) {
        await fetchRoles();
        setIsEditDialogOpen(false);
      }
    } catch (error) {
      console.error('Failed to update role:', error);
    }
  };

  const handleDeleteRole = async (roleId: string) => {
    if (!confirm('Are you sure you want to delete this role?')) {
      return;
    }

    try {
      const response = await fetch(`/api/roles/${roleId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        await fetchRoles();
      } else {
        const error = await response.json();
        alert(error.error);
      }
    } catch (error) {
      console.error('Failed to delete role:', error);
    }
  };

  if (loading) {
    return <div>Loading roles...</div>;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Role Management
          </CardTitle>
          <Button onClick={() => setIsCreateDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Create Role
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {roles.map(role => (
            <div
              key={role.id}
              className="flex items-center justify-between p-4 border rounded-lg"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold">{role.name}</h3>
                  {role.isSystem && (
                    <Badge variant="secondary">System</Badge>
                  )}
                </div>
                <p className="text-sm text-gray-600 mt-1">
                  {role.description}
                </p>
                <div className="flex gap-4 mt-2 text-sm text-gray-500">
                  {role.userCount !== undefined && (
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {role.userCount} users
                    </span>
                  )}
                  {role.permissionCount !== undefined && (
                    <span className="flex items-center gap-1">
                      <Shield className="h-3 w-3" />
                      {role.permissionCount} permissions
                    </span>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSelectedRole(role);
                    setIsEditDialogOpen(true);
                  }}
                  disabled={role.isSystem}
                >
                  <Edit className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDeleteRole(role.id)}
                  disabled={role.isSystem || (role.userCount && role.userCount > 0)}
                >
                  <Trash className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>

      {/* Create Role Dialog */}
      <CreateRoleDialog
        isOpen={isCreateDialogOpen}
        onClose={() => setIsCreateDialogOpen(false)}
        onCreate={handleCreateRole}
      />

      {/* Edit Role Dialog */}
      {selectedRole && (
        <EditRoleDialog
          isOpen={isEditDialogOpen}
          role={selectedRole}
          onClose={() => setIsEditDialogOpen(false)}
          onUpdate={handleUpdateRole}
        />
      )}
    </Card>
  );
}
```

### 9.2 Permission Assignment UI

```tsx
// admin/components/PermissionAssignment.tsx
import React, { useState, useEffect } from 'react';
import { Checkbox } from '../components/ui/checkbox';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { ScrollArea } from '../components/ui/scroll-area';
import { Search } from 'lucide-react';

interface Permission {
  id: string;
  name: string;
  resource: string;
  action: string;
  scope: string;
  description: string;
}

interface PermissionGroup {
  resource: string;
  permissions: Permission[];
}

interface PermissionAssignmentProps {
  roleId?: string;
  userId?: string;
  currentPermissions: string[];
  onPermissionChange: (permissions: string[]) => void;
}

export function PermissionAssignment({
  roleId,
  userId,
  currentPermissions,
  onPermissionChange
}: PermissionAssignmentProps) {
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(
    new Set(currentPermissions)
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [groupedPermissions, setGroupedPermissions] = useState<PermissionGroup[]>([]);

  useEffect(() => {
    fetchPermissions();
  }, []);

  useEffect(() => {
    setSelectedPermissions(new Set(currentPermissions));
  }, [currentPermissions]);

  const fetchPermissions = async () => {
    try {
      const response = await fetch('/api/permissions');
      const data = await response.json();
      setPermissions(data.permissions);

      // Group permissions by resource
      const grouped = data.permissions.reduce((acc: Record<string, Permission[]>, perm: Permission) => {
        if (!acc[perm.resource]) {
          acc[perm.resource] = [];
        }
        acc[perm.resource].push(perm);
        return acc;
      }, {});

      setGroupedPermissions(
        Object.entries(grouped).map(([resource, perms]) => ({
          resource,
          permissions: perms
        }))
      );
    } catch (error) {
      console.error('Failed to fetch permissions:', error);
    }
  };

  const handlePermissionToggle = (permissionId: string) => {
    const newSelected = new Set(selectedPermissions);
    if (newSelected.has(permissionId)) {
      newSelected.delete(permissionId);
    } else {
      newSelected.add(permissionId);
    }
    setSelectedPermissions(newSelected);
    onPermissionChange(Array.from(newSelected));
  };

  const handleSelectAll = (resource: string) => {
    const resourcePerms = permissions
      .filter(p => p.resource === resource)
      .map(p => p.id);

    const newSelected = new Set(selectedPermissions);
    const allSelected = resourcePerms.every(id => newSelected.has(id));

    if (allSelected) {
      resourcePerms.forEach(id => newSelected.delete(id));
    } else {
      resourcePerms.forEach(id => newSelected.add(id));
    }

    setSelectedPermissions(newSelected);
    onPermissionChange(Array.from(newSelected));
  };

  const filteredGroups = groupedPermissions
    .map(group => ({
      ...group,
      permissions: group.permissions.filter(
        p => p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
             p.description.toLowerCase().includes(searchQuery.toLowerCase())
      )
    }))
    .filter(group => group.permissions.length > 0);

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
        <Input
          placeholder="Search permissions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      <ScrollArea className="h-[400px] border rounded-lg p-4">
        <div className="space-y-6">
          {filteredGroups.map(group => (
            <div key={group.resource} className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-semibold capitalize">
                  {group.resource}
                </Label>
                <Checkbox
                  checked={group.permissions.every(p => selectedPermissions.has(p.id))}
                  onCheckedChange={() => handleSelectAll(group.resource)}
                />
              </div>
              <div className="ml-4 space-y-2">
                {group.permissions.map(permission => (
                  <div key={permission.id} className="flex items-start gap-2">
                    <Checkbox
                      id={permission.id}
                      checked={selectedPermissions.has(permission.id)}
                      onCheckedChange={() => handlePermissionToggle(permission.id)}
                    />
                    <div className="flex-1">
                      <Label
                        htmlFor={permission.id}
                        className="text-sm font-medium cursor-pointer"
                      >
                        {permission.name}
                      </Label>
                      <p className="text-xs text-gray-500">
                        {permission.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>

      <div className="text-sm text-gray-600">
        {selectedPermissions.size} permission{selectedPermissions.size !== 1 ? 's' : ''} selected
      </div>
    </div>
  );
}
```

## 10. Security Considerations

### 10.1 Security Best Practices

```typescript
// security/rbac-security.ts

/**
 * Security checks for RBAC operations
 */
export class RBACSecurity {
  /**
   * Validate permission format
   */
  static validatePermissionFormat(permission: string): boolean {
    // Format: resource:action:scope
    const pattern = /^[a-z0-9_]+:[a-z0-9_]+:[a-z0-9_*]+$/i;
    return pattern.test(permission);
  }

  /**
   * Check for privilege escalation
   */
  static async canGrantPermission(
    grantorId: string,
    permission: string,
    permService: PermissionService
  ): Promise<boolean> {
    // User cannot grant permissions they don't have
    const hasPermission = await permService.hasPermission(grantorId, permission);

    // Also need the grant permission
    const canGrant = await permService.hasPermission(
      grantorId,
      'permissions:grant:all'
    );

    return hasPermission && canGrant;
  }

  /**
   * Sanitize role name
   */
  static sanitizeRoleName(name: string): string {
    // Remove special characters, limit length
    return name
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .substring(0, 50)
      .toLowerCase();
  }

  /**
   * Validate role hierarchy (prevent cycles)
   */
  static async validateRoleHierarchy(
    roleId: string,
    parentRoleId: string,
    db: D1Database
  ): Promise<boolean> {
    if (roleId === parentRoleId) {
      return false; // Self-reference
    }

    // Check for cycles
    let currentParent = parentRoleId;
    const visited = new Set<string>([roleId]);

    while (currentParent) {
      if (visited.has(currentParent)) {
        return false; // Cycle detected
      }

      visited.add(currentParent);

      const parent = await db.prepare(
        'SELECT parent_role_id FROM roles WHERE id = ?'
      ).bind(currentParent).first<{ parent_role_id: string | null }>();

      currentParent = parent?.parent_role_id || null;
    }

    return true;
  }

  /**
   * Rate limiting for permission checks
   */
  static createRateLimiter(
    kv: KVNamespace,
    maxRequests = 100,
    windowSeconds = 60
  ) {
    return async (userId: string): Promise<boolean> => {
      const key = `ratelimit:perms:${userId}`;
      const now = Date.now();
      const window = now - (windowSeconds * 1000);

      // Get current count
      const data = await kv.get(key, 'json') as { count: number; resetAt: number } | null;

      if (!data || data.resetAt < now) {
        // New window
        await kv.put(
          key,
          JSON.stringify({ count: 1, resetAt: now + (windowSeconds * 1000) }),
          { expirationTtl: windowSeconds }
        );
        return true;
      }

      if (data.count >= maxRequests) {
        return false; // Rate limited
      }

      // Increment count
      await kv.put(
        key,
        JSON.stringify({ ...data, count: data.count + 1 }),
        { expirationTtl: Math.ceil((data.resetAt - now) / 1000) }
      );

      return true;
    };
  }
}
```

### 10.2 Audit Integration

```typescript
// audit/rbac-audit.ts
export class RBACAudit {
  private auditService: AuditService;

  constructor(auditService: AuditService) {
    this.auditService = auditService;
  }

  /**
   * Log permission check
   */
  async logPermissionCheck(
    userId: string,
    permission: string,
    granted: boolean,
    context?: any
  ): Promise<void> {
    await this.auditService.log({
      eventType: 'permission.check',
      userId,
      metadata: {
        permission,
        granted,
        context
      },
      severity: granted ? 'info' : 'warning',
      success: granted
    });
  }

  /**
   * Log role assignment
   */
  async logRoleAssignment(
    grantorId: string,
    targetUserId: string,
    roleId: string,
    roleName: string
  ): Promise<void> {
    await this.auditService.log({
      eventType: 'rbac.role_assigned',
      userId: grantorId,
      metadata: {
        targetUserId,
        roleId,
        roleName
      },
      severity: 'info',
      success: true
    });
  }

  /**
   * Log permission grant
   */
  async logPermissionGrant(
    grantorId: string,
    targetId: string,
    targetType: 'user' | 'role',
    permissions: string[]
  ): Promise<void> {
    await this.auditService.log({
      eventType: 'rbac.permissions_granted',
      userId: grantorId,
      metadata: {
        targetId,
        targetType,
        permissions,
        count: permissions.length
      },
      severity: 'info',
      success: true
    });
  }

  /**
   * Log security violation
   */
  async logSecurityViolation(
    userId: string,
    violation: string,
    details: any
  ): Promise<void> {
    await this.auditService.log({
      eventType: 'rbac.security_violation',
      userId,
      metadata: {
        violation,
        details
      },
      severity: 'critical',
      success: false,
      errorMessage: violation
    });
  }
}
```

## 11. Testing Strategy

### 11.1 Unit Tests

```typescript
// tests/permission.service.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { PermissionService } from '../services/permission.service';

describe('PermissionService', () => {
  let service: PermissionService;
  let mockDb: any;
  let mockCache: any;

  beforeEach(() => {
    mockDb = createMockD1Database();
    mockCache = createMockKVNamespace();
    service = new PermissionService(mockDb, mockCache);
  });

  describe('hasPermission', () => {
    it('should return true for exact permission match', async () => {
      const userId = 'user123';
      const permission = 'users:read:all';

      mockCache.get.mockResolvedValue({
        permissions: [{ name: permission }],
        directGrants: [],
        directDenies: []
      });

      const result = await service.hasPermission(userId, permission);
      expect(result).toBe(true);
    });

    it('should handle wildcard permissions', async () => {
      const userId = 'user123';

      mockCache.get.mockResolvedValue({
        permissions: [{ name: 'users:*:all' }],
        directGrants: [],
        directDenies: []
      });

      expect(await service.hasPermission(userId, 'users:read:all')).toBe(true);
      expect(await service.hasPermission(userId, 'users:write:all')).toBe(true);
      expect(await service.hasPermission(userId, 'content:read:all')).toBe(false);
    });

    it('should respect direct denies over grants', async () => {
      const userId = 'user123';
      const permission = 'users:delete:all';

      mockCache.get.mockResolvedValue({
        permissions: [{ name: permission }],
        directGrants: [],
        directDenies: [{ name: permission }]
      });

      const result = await service.hasPermission(userId, permission);
      expect(result).toBe(false);
    });

    it('should handle scope hierarchy', async () => {
      const userId = 'user123';

      mockCache.get.mockResolvedValue({
        permissions: [{ name: 'content:read:all', scope: 'all' }],
        directGrants: [],
        directDenies: []
      });

      expect(await service.hasPermission(userId, 'content:read:own')).toBe(true);
      expect(await service.hasPermission(userId, 'content:read:team')).toBe(true);
      expect(await service.hasPermission(userId, 'content:read:all')).toBe(true);
    });
  });

  describe('caching', () => {
    it('should cache permissions after loading', async () => {
      const userId = 'user123';

      mockCache.get.mockResolvedValueOnce(null); // Cache miss
      mockDb.prepare().bind().all.mockResolvedValue({
        results: [{ name: 'users:read:all' }]
      });

      await service.getUserPermissions(userId);

      expect(mockCache.put).toHaveBeenCalledWith(
        expect.stringContaining(userId),
        expect.any(String),
        expect.objectContaining({ expirationTtl: 300 })
      );
    });

    it('should use cached permissions when available', async () => {
      const userId = 'user123';
      const cached = {
        permissions: [{ name: 'users:read:all' }],
        expiresAt: new Date(Date.now() + 60000)
      };

      mockCache.get.mockResolvedValue(cached);

      await service.getUserPermissions(userId);

      expect(mockDb.prepare).not.toHaveBeenCalled();
    });
  });
});
```

### 11.2 Integration Tests

```typescript
// tests/rbac.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unstable_dev } from 'wrangler';

describe('RBAC Integration', () => {
  let worker: any;

  beforeAll(async () => {
    worker = await unstable_dev('src/index.ts', {
      experimental: { disableExperimentalWarning: true }
    });
  });

  afterAll(async () => {
    await worker.stop();
  });

  describe('Role Management', () => {
    it('should create a new role with permissions', async () => {
      const response = await worker.fetch('/api/roles', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer admin-token'
        },
        body: JSON.stringify({
          name: 'test_role',
          description: 'Test role',
          permissions: ['users:read:all', 'content:read:all']
        })
      });

      expect(response.status).toBe(201);
      const role = await response.json();
      expect(role.name).toBe('test_role');
    });

    it('should prevent deletion of system roles', async () => {
      const response = await worker.fetch('/api/roles/super_admin', {
        method: 'DELETE',
        headers: {
          'Authorization': 'Bearer admin-token'
        }
      });

      expect(response.status).toBe(403);
      const error = await response.json();
      expect(error.error).toContain('system role');
    });
  });

  describe('Permission Checking', () => {
    it('should correctly check user permissions', async () => {
      const response = await worker.fetch('/api/permissions/check', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer user-token'
        },
        body: JSON.stringify({
          permission: 'content:read:own'
        })
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.hasPermission).toBeDefined();
    });

    it('should handle resource-based permissions', async () => {
      const response = await worker.fetch('/api/permissions/check', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer user-token'
        },
        body: JSON.stringify({
          permission: 'content:delete:own',
          resource: {
            type: 'content',
            id: 'content123',
            ownerId: 'user123'
          }
        })
      });

      expect(response.status).toBe(200);
    });
  });

  describe('Cache Invalidation', () => {
    it('should invalidate cache when role permissions change', async () => {
      // Assign permission to role
      await worker.fetch('/api/roles/user/permissions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer admin-token'
        },
        body: JSON.stringify({
          permissions: ['content:write:own']
        })
      });

      // Check that users with this role have updated permissions
      // This would require checking cache invalidation
    });
  });
});
```

## 12. Performance Optimization

### 12.1 Query Optimization

```typescript
// optimization/rbac-optimization.ts

/**
 * Optimized permission queries
 */
export class RBACQueryOptimizer {
  /**
   * Bulk load permissions for multiple users
   */
  static async bulkLoadPermissions(
    db: D1Database,
    userIds: string[]
  ): Promise<Map<string, EffectivePermissions>> {
    // Single query to get all user roles
    const rolesResult = await db.prepare(`
      SELECT
        ur.user_id,
        r.*
      FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE ur.user_id IN (${userIds.map(() => '?').join(',')})
        AND ur.is_active = TRUE
        AND (ur.expires_at IS NULL OR ur.expires_at > datetime('now'))
      ORDER BY ur.user_id
    `).bind(...userIds).all();

    // Get all unique role IDs
    const roleIds = [...new Set(rolesResult.results.map(r => r.id))];

    // Single query to get all permissions for all roles
    const permissionsResult = await db.prepare(`
      SELECT
        rp.role_id,
        p.*
      FROM role_permissions rp
      JOIN permissions p ON rp.permission_id = p.id
      WHERE rp.role_id IN (${roleIds.map(() => '?').join(',')})
    `).bind(...roleIds).all();

    // Build permission map
    const userPermissions = new Map<string, EffectivePermissions>();

    // Process results...

    return userPermissions;
  }

  /**
   * Precompute permission sets for common roles
   */
  static async precomputeRolePermissions(
    db: D1Database,
    kv: KVNamespace
  ): Promise<void> {
    // Get all roles
    const roles = await db.prepare(`
      SELECT id, name FROM roles WHERE is_system = TRUE
    `).all();

    for (const role of roles.results) {
      // Get all permissions for this role
      const permissions = await db.prepare(`
        WITH RECURSIVE role_tree AS (
          SELECT id, parent_role_id FROM roles WHERE id = ?
          UNION ALL
          SELECT r.id, r.parent_role_id
          FROM roles r
          JOIN role_tree rt ON r.id = rt.parent_role_id
        )
        SELECT DISTINCT p.*
        FROM role_tree rt
        JOIN role_permissions rp ON rt.id = rp.role_id
        JOIN permissions p ON rp.permission_id = p.id
      `).bind(role.id).all();

      // Cache the permission set
      await kv.put(
        `role_perms:${role.id}`,
        JSON.stringify(permissions.results),
        { expirationTtl: 3600 } // 1 hour
      );
    }
  }
}
```

### 12.2 Database Indexes

```sql
-- Performance-critical indexes for RBAC

-- User role lookups (most common query)
CREATE INDEX idx_user_roles_active ON user_roles(user_id, is_active, expires_at);

-- Role permission lookups
CREATE INDEX idx_role_permissions_role ON role_permissions(role_id);

-- Permission lookups by name
CREATE UNIQUE INDEX idx_permissions_name ON permissions(name);

-- Permission lookups by resource/action
CREATE INDEX idx_permissions_lookup ON permissions(resource, action, scope);

-- Role hierarchy traversal
CREATE INDEX idx_roles_hierarchy ON roles(parent_role_id) WHERE parent_role_id IS NOT NULL;

-- Direct user permissions
CREATE INDEX idx_user_permissions_active ON user_permissions(user_id, is_grant, expires_at);

-- Audit trail queries
CREATE INDEX idx_audit_rbac ON audit_events(event_type, user_id, created_at)
WHERE event_type LIKE 'rbac.%' OR event_type LIKE 'permission.%';
```

## 13. Troubleshooting

### 13.1 Common Issues

```typescript
// troubleshooting/rbac-troubleshooting.ts

export class RBACTroubleshooter {
  /**
   * Diagnose permission issues for a user
   */
  static async diagnoseUserPermissions(
    db: D1Database,
    userId: string,
    permission: string
  ): Promise<{
    hasPermission: boolean;
    reason: string;
    details: any;
  }> {
    const diagnosis = {
      hasPermission: false,
      reason: '',
      details: {} as any
    };

    // Check if user exists
    const user = await db.prepare(
      'SELECT id, email FROM user WHERE id = ?'
    ).bind(userId).first();

    if (!user) {
      diagnosis.reason = 'User not found';
      return diagnosis;
    }

    // Check direct denies
    const denies = await db.prepare(`
      SELECT p.name
      FROM user_permissions up
      JOIN permissions p ON up.permission_id = p.id
      WHERE up.user_id = ? AND up.is_grant = FALSE
        AND (up.expires_at IS NULL OR up.expires_at > datetime('now'))
    `).bind(userId).all();

    if (denies.results.some(d => this.matchesPermission(d.name, permission))) {
      diagnosis.reason = 'Permission explicitly denied';
      diagnosis.details.deniedPermissions = denies.results;
      return diagnosis;
    }

    // Check direct grants
    const grants = await db.prepare(`
      SELECT p.name
      FROM user_permissions up
      JOIN permissions p ON up.permission_id = p.id
      WHERE up.user_id = ? AND up.is_grant = TRUE
        AND (up.expires_at IS NULL OR up.expires_at > datetime('now'))
    `).bind(userId).all();

    if (grants.results.some(g => this.matchesPermission(g.name, permission))) {
      diagnosis.hasPermission = true;
      diagnosis.reason = 'Permission directly granted';
      diagnosis.details.grantedPermissions = grants.results;
      return diagnosis;
    }

    // Check role permissions
    const rolePerms = await db.prepare(`
      SELECT
        r.name as role_name,
        p.name as permission_name
      FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      JOIN role_permissions rp ON r.id = rp.role_id
      JOIN permissions p ON rp.permission_id = p.id
      WHERE ur.user_id = ?
        AND ur.is_active = TRUE
        AND (ur.expires_at IS NULL OR ur.expires_at > datetime('now'))
    `).bind(userId).all();

    const matchingRole = rolePerms.results.find(rp =>
      this.matchesPermission(rp.permission_name, permission)
    );

    if (matchingRole) {
      diagnosis.hasPermission = true;
      diagnosis.reason = `Permission granted via role: ${matchingRole.role_name}`;
      diagnosis.details.role = matchingRole.role_name;
      diagnosis.details.permission = matchingRole.permission_name;
      return diagnosis;
    }

    // No permission found
    diagnosis.reason = 'No matching permission found';
    diagnosis.details.userRoles = [...new Set(rolePerms.results.map(r => r.role_name))];
    diagnosis.details.availablePermissions = rolePerms.results.map(r => r.permission_name);

    return diagnosis;
  }

  /**
   * Check for permission conflicts
   */
  static async findPermissionConflicts(
    db: D1Database,
    userId: string
  ): Promise<Array<{
    permission: string;
    grantedBy: string;
    deniedBy: string;
  }>> {
    // Find permissions that are both granted and denied
    const conflicts = await db.prepare(`
      SELECT
        p.name as permission,
        'role' as granted_by,
        'direct' as denied_by
      FROM user_permissions up
      JOIN permissions p ON up.permission_id = p.id
      WHERE up.user_id = ? AND up.is_grant = FALSE
        AND EXISTS (
          SELECT 1
          FROM user_roles ur
          JOIN role_permissions rp ON ur.role_id = rp.role_id
          WHERE ur.user_id = up.user_id
            AND rp.permission_id = up.permission_id
            AND ur.is_active = TRUE
        )
    `).bind(userId).all();

    return conflicts.results;
  }

  /**
   * Validate RBAC configuration
   */
  static async validateConfiguration(db: D1Database): Promise<{
    valid: boolean;
    issues: string[];
  }> {
    const issues: string[] = [];

    // Check for role cycles
    const roles = await db.prepare('SELECT id, parent_role_id FROM roles').all();
    for (const role of roles.results) {
      if (role.parent_role_id && !await this.validateNoCycles(db, role.id)) {
        issues.push(`Role cycle detected for role ${role.id}`);
      }
    }

    // Check for orphaned permissions
    const orphaned = await db.prepare(`
      SELECT COUNT(*) as count
      FROM role_permissions rp
      WHERE NOT EXISTS (
        SELECT 1 FROM permissions p WHERE p.id = rp.permission_id
      )
    `).first<{ count: number }>();

    if (orphaned?.count > 0) {
      issues.push(`Found ${orphaned.count} orphaned permission assignments`);
    }

    // Check for users without roles
    const usersWithoutRoles = await db.prepare(`
      SELECT COUNT(*) as count
      FROM user u
      WHERE NOT EXISTS (
        SELECT 1 FROM user_roles ur
        WHERE ur.user_id = u.id AND ur.is_active = TRUE
      )
    `).first<{ count: number }>();

    if (usersWithoutRoles?.count > 0) {
      issues.push(`Found ${usersWithoutRoles.count} users without any roles`);
    }

    return {
      valid: issues.length === 0,
      issues
    };
  }

  private static matchesPermission(pattern: string, permission: string): boolean {
    // Implementation of permission matching logic
    return pattern === permission || pattern === '*:*:*';
  }

  private static async validateNoCycles(
    db: D1Database,
    roleId: string
  ): Promise<boolean> {
    // Check for role hierarchy cycles
    const visited = new Set<string>();
    let current = roleId;

    while (current) {
      if (visited.has(current)) {
        return false; // Cycle detected
      }
      visited.add(current);

      const parent = await db.prepare(
        'SELECT parent_role_id FROM roles WHERE id = ?'
      ).bind(current).first<{ parent_role_id: string | null }>();

      current = parent?.parent_role_id || null;
    }

    return true;
  }
}
```

## 14. Code Examples

### 14.1 Common Use Cases

```typescript
// examples/rbac-examples.ts

/**
 * Example: Content Management with RBAC
 */
export async function contentManagementExample(
  userId: string,
  contentId: string,
  env: Env
) {
  const permService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);

  // Load content to check ownership
  const content = await env.AUTH_DB.prepare(
    'SELECT user_id, status FROM content WHERE id = ?'
  ).bind(contentId).first<{ user_id: string; status: string }>();

  if (!content) {
    throw new Error('Content not found');
  }

  // Check if user can edit
  const isOwner = content.user_id === userId;

  let canEdit = false;
  if (isOwner) {
    // Check for own content permission
    canEdit = await permService.hasPermission(userId, 'content:update:own');
  } else {
    // Check for all content permission
    canEdit = await permService.hasPermission(userId, 'content:update:all');
  }

  if (!canEdit) {
    throw new Error('Permission denied: Cannot edit this content');
  }

  // Check if user can publish
  const canPublish = await permService.hasPermission(
    userId,
    isOwner ? 'content:publish:own' : 'content:publish:all'
  );

  return {
    canEdit,
    canPublish,
    isOwner
  };
}

/**
 * Example: Admin Dashboard Access Control
 */
export async function adminDashboardAccess(
  userId: string,
  section: string,
  env: Env
): Promise<boolean> {
  const permService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);

  const sectionPermissions: Record<string, string[]> = {
    users: ['users:read:all', 'users:manage:all'],
    content: ['content:read:all', 'content:manage:all'],
    analytics: ['analytics:read:all'],
    settings: ['settings:read:all', 'settings:manage:all'],
    audit: ['audit:read:all'],
    system: ['system:manage:all']
  };

  const requiredPermissions = sectionPermissions[section] || [];

  // User needs at least one of the permissions
  return await permService.hasAnyPermission(userId, requiredPermissions);
}

/**
 * Example: Temporary Permission Grant
 */
export async function grantTemporaryPermission(
  userId: string,
  permission: string,
  durationHours: number,
  grantedBy: string,
  reason: string,
  env: Env
): Promise<void> {
  // Get permission ID
  const perm = await env.AUTH_DB.prepare(
    'SELECT id FROM permissions WHERE name = ?'
  ).bind(permission).first<{ id: string }>();

  if (!perm) {
    throw new Error(`Permission ${permission} not found`);
  }

  const expiresAt = new Date(Date.now() + durationHours * 3600 * 1000);

  // Grant temporary permission
  await env.AUTH_DB.prepare(`
    INSERT INTO user_permissions (
      user_id, permission_id, is_grant, granted_by, expires_at, reason
    ) VALUES (?, ?, TRUE, ?, ?, ?)
  `).bind(
    userId,
    perm.id,
    grantedBy,
    expiresAt.toISOString(),
    reason
  ).run();

  // Invalidate cache
  const permService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);
  await permService.invalidateUserCache(userId);

  // Log audit event
  await env.AUDIT_SERVICE.log({
    eventType: 'permission.temporary_grant',
    userId: grantedBy,
    metadata: {
      targetUserId: userId,
      permission,
      expiresAt: expiresAt.toISOString(),
      reason
    },
    severity: 'info',
    success: true
  });
}

/**
 * Example: Check Multiple Resources
 */
export async function checkMultipleResources(
  userId: string,
  resources: Array<{ type: string; id: string; action: string }>,
  env: Env
): Promise<Map<string, boolean>> {
  const permService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);
  const results = new Map<string, boolean>();

  // Load resource ownership information
  const resourceOwners = await env.AUTH_DB.prepare(`
    SELECT id, user_id FROM content
    WHERE id IN (${resources.map(() => '?').join(',')})
  `).bind(...resources.map(r => r.id)).all<{ id: string; user_id: string }>();

  const ownerMap = new Map(
    resourceOwners.results.map(r => [r.id, r.user_id])
  );

  // Check each resource
  for (const resource of resources) {
    const ownerId = ownerMap.get(resource.id);
    const isOwn = ownerId === userId;

    const permission = `${resource.type}:${resource.action}:${isOwn ? 'own' : 'all'}`;

    const hasPermission = await permService.hasPermission(
      userId,
      permission,
      {
        type: resource.type,
        id: resource.id,
        ownerId
      }
    );

    results.set(resource.id, hasPermission);
  }

  return results;
}

/**
 * Example: Role-based Menu Rendering
 */
export async function getMenuItems(
  userId: string,
  env: Env
): Promise<Array<{ label: string; path: string; icon: string }>> {
  const permService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);

  const allMenuItems = [
    {
      label: 'Dashboard',
      path: '/',
      icon: 'home',
      permission: null // Always visible
    },
    {
      label: 'Users',
      path: '/users',
      icon: 'users',
      permission: 'users:read:all'
    },
    {
      label: 'Content',
      path: '/content',
      icon: 'file-text',
      permission: 'content:read:all'
    },
    {
      label: 'Analytics',
      path: '/analytics',
      icon: 'chart',
      permission: 'analytics:read:all'
    },
    {
      label: 'Settings',
      path: '/settings',
      icon: 'settings',
      permission: 'settings:read:all'
    },
    {
      label: 'Audit Log',
      path: '/audit',
      icon: 'shield',
      permission: 'audit:read:all'
    }
  ];

  const visibleItems = [];

  for (const item of allMenuItems) {
    if (!item.permission || await permService.hasPermission(userId, item.permission)) {
      visibleItems.push({
        label: item.label,
        path: item.path,
        icon: item.icon
      });
    }
  }

  return visibleItems;
}
```

## 15. Deployment Guide

### 15.1 Deployment Checklist

```markdown
## RBAC Deployment Checklist

### Pre-Deployment
- [ ] All tests passing
- [ ] Migration scripts tested on staging
- [ ] Rollback plan documented and tested
- [ ] Performance benchmarks completed
- [ ] Security review completed
- [ ] Documentation updated

### Database Migration
- [ ] Backup current database
- [ ] Run migration in dry-run mode
- [ ] Verify dry-run results
- [ ] Execute migration
- [ ] Verify all tables created
- [ ] Verify indexes created
- [ ] Verify default data inserted

### Application Deployment
- [ ] Deploy RBAC service code
- [ ] Deploy updated API endpoints
- [ ] Deploy middleware updates
- [ ] Update environment variables
- [ ] Configure KV namespaces
- [ ] Update CORS settings if needed

### Post-Deployment Verification
- [ ] Test authentication flows
- [ ] Test permission checks
- [ ] Test role assignments
- [ ] Test cache invalidation
- [ ] Test audit logging
- [ ] Monitor error rates
- [ ] Monitor performance metrics

### Rollback Criteria
- [ ] Error rate > 5%
- [ ] Response time > 2x baseline
- [ ] Authentication failures > 1%
- [ ] Critical security issues detected

### Communication
- [ ] Notify operations team
- [ ] Update status page
- [ ] Document any issues
- [ ] Schedule post-deployment review
```

### 15.2 Environment Configuration

```typescript
// config/rbac-config.ts
export const RBACConfig = {
  // Feature flags
  features: {
    enableRBAC: process.env.ENABLE_RBAC === 'true',
    enableCache: process.env.ENABLE_PERMISSION_CACHE === 'true',
    enableAudit: process.env.ENABLE_RBAC_AUDIT === 'true',
    strictMode: process.env.RBAC_STRICT_MODE === 'true'
  },

  // Cache settings
  cache: {
    ttlSeconds: parseInt(process.env.PERMISSION_CACHE_TTL || '300'),
    namespace: process.env.PERMISSION_CACHE_NAMESPACE || 'PERMISSIONS'
  },

  // Security settings
  security: {
    maxRolesPerUser: parseInt(process.env.MAX_ROLES_PER_USER || '10'),
    maxPermissionsPerRole: parseInt(process.env.MAX_PERMISSIONS_PER_ROLE || '100'),
    requireAudit: process.env.REQUIRE_RBAC_AUDIT === 'true'
  },

  // Rate limiting
  rateLimiting: {
    enabled: process.env.ENABLE_RATE_LIMITING === 'true',
    maxChecksPerMinute: parseInt(process.env.MAX_PERMISSION_CHECKS_PER_MINUTE || '100')
  },

  // Default roles
  defaultRoles: {
    newUser: process.env.DEFAULT_USER_ROLE || 'user',
    systemAdmin: process.env.SYSTEM_ADMIN_ROLE || 'super_admin'
  }
};
```

### 15.3 Monitoring Setup

```typescript
// monitoring/rbac-monitoring.ts
export class RBACMonitoring {
  /**
   * Track permission check metrics
   */
  static async trackPermissionCheck(
    userId: string,
    permission: string,
    granted: boolean,
    latencyMs: number
  ): Promise<void> {
    // Send to analytics service
    await analytics.track({
      event: 'rbac.permission_check',
      properties: {
        userId,
        permission,
        granted,
        latencyMs
      }
    });

    // Update metrics
    if (latencyMs > 100) {
      console.warn(`Slow permission check: ${latencyMs}ms for ${permission}`);
    }
  }

  /**
   * Monitor cache performance
   */
  static async monitorCache(kv: KVNamespace): Promise<void> {
    const stats = await this.getCacheStats(kv);

    console.log('RBAC Cache Stats:', {
      hitRate: stats.hitRate,
      missRate: stats.missRate,
      avgLatency: stats.avgLatency,
      cacheSize: stats.size
    });
  }

  /**
   * Alert on security events
   */
  static async alertSecurityEvent(
    event: string,
    userId: string,
    details: any
  ): Promise<void> {
    if (event === 'privilege_escalation_attempt' ||
        event === 'permission_denied_critical') {
      // Send alert
      await alerting.sendAlert({
        severity: 'high',
        title: `RBAC Security Event: ${event}`,
        details: {
          userId,
          ...details
        }
      });
    }
  }
}
```

## Conclusion

This comprehensive RBAC implementation guide provides a complete solution for role-based access control in the Al Ummah Now platform. The system is designed to be:

- **Scalable**: Handles complex permission models and grows with the platform
- **Performant**: Edge-optimized with intelligent caching
- **Secure**: Multiple layers of security checks and audit logging
- **Flexible**: Supports custom roles, inheritance, and resource-based permissions
- **Maintainable**: Clear architecture with comprehensive documentation

The phased migration approach ensures a smooth transition from the current binary role system to the full RBAC implementation while maintaining backward compatibility. Regular monitoring and the ability to rollback provide safety nets during deployment.

Key success factors:
1. Thorough testing at each migration phase
2. Monitoring permission check latency and cache performance
3. Regular security audits of role assignments
4. Clear documentation for developers and administrators
5. Training for admin users on the new permission model

The system is ready for future enhancements including multi-tenancy, attribute-based access control, and policy engines while maintaining the simplicity needed for current requirements.