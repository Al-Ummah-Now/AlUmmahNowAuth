/**
 * RBAC Types and Interfaces
 *
 * Type definitions for the Role-Based Access Control system.
 * Following the security requirements from rbac-security-implementation.md
 *
 * @module rbac-types
 */

/**
 * Permission definition following resource:action:scope format
 */
export interface Permission {
  id: string;
  name: string; // Format: resource:action:scope (e.g., "users:read:all")
  resource: string; // The entity (users, content, settings)
  action: string; // The operation (create, read, update, delete, manage)
  scope: string; // The boundary (own, team, all, *)
  description?: string;
  is_system: boolean; // System permissions cannot be deleted
  metadata?: Record<string, any>; // Additional properties as JSON
  created_at: Date;
}

/**
 * Role definition with hierarchical support
 */
export interface Role {
  id: string;
  name: string;
  description?: string;
  parent_role_id?: string; // For role inheritance
  is_system: boolean; // System roles cannot be modified/deleted
  metadata?: Record<string, any>;
  created_at: Date;
  updated_at: Date;
  created_by?: string;
  updated_by?: string;
}

/**
 * Role-Permission mapping
 */
export interface RolePermission {
  id: string;
  role_id: string;
  permission_id: string;
  granted_by: string;
  granted_at: Date;
}

/**
 * User-Role assignment (users can have multiple roles)
 */
export interface UserRole {
  id: string;
  user_id: string;
  role_id: string;
  granted_by: string;
  granted_at: Date;
  expires_at?: Date; // For temporary role assignments
  is_active: boolean;
}

/**
 * User-Role assignment with role details (for getUserRoles API responses)
 * Uses camelCase for consistency with TypeScript conventions
 */
export interface UserRoleWithDetails {
  id: string;
  userId: string;
  roleId: string;
  grantedBy: string;
  grantedAt: Date;
  expiresAt?: Date;
  isActive: boolean;
  role: {
    id: string;
    name: string;
    description?: string;
    is_system: boolean;
  };
}

/**
 * Direct user permissions (overrides role permissions)
 */
export interface UserPermission {
  id: string;
  user_id: string;
  permission_id: string;
  is_grant: boolean; // TRUE = grant, FALSE = deny (override)
  granted_by: string;
  granted_at: Date;
  expires_at?: Date;
  reason?: string; // Why this direct permission was granted/denied
}

/**
 * Effective permissions for a user (computed from roles + direct permissions)
 */
export interface EffectivePermissions {
  userId: string;
  roles: Role[];
  permissions: Permission[]; // From roles
  directGrants: Permission[]; // Direct grants
  directDenies: Permission[]; // Direct denies (highest priority)
  cachedAt: Date;
  expiresAt: Date;
  version: number; // Cache version for atomic invalidation
}

/**
 * Permission check request
 */
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

/**
 * Permission grant validation result
 */
export interface PermissionGrantCheck {
  allowed: boolean;
  missingPermissions: string[];
}

/**
 * Role creation/update data
 */
export interface RoleData {
  name: string;
  description?: string;
  parent_role_id?: string;
  metadata?: Record<string, any>;
}

/**
 * Permission creation data
 */
export interface PermissionData {
  name: string;
  resource: string;
  action: string;
  scope: string;
  description?: string;
  metadata?: Record<string, any>;
}

/**
 * Bulk permission check request
 */
export interface BulkPermissionCheck {
  userId: string;
  permissions: string[];
  requireAll?: boolean; // If true, requires all permissions. If false, requires any permission
}

/**
 * Bulk permission check response
 */
export interface BulkPermissionResult {
  userId: string;
  permissions: Record<string, boolean>; // permission name -> has permission
  hasAll: boolean;
  hasAny: boolean;
  checkedAt: Date;
}

/**
 * Resource permission (future enhancement)
 */
export interface ResourcePermission {
  id: string;
  resource_type: string;
  resource_id: string;
  user_id?: string;
  role_id?: string;
  permission_id: string;
  granted_by: string;
  granted_at: Date;
  expires_at?: Date;
}

/**
 * Permission policy for complex rules (future enhancement)
 */
export interface PermissionPolicy {
  id: string;
  name: string;
  description?: string;
  policy_type: 'condition' | 'time_based' | 'attribute_based';
  conditions: Record<string, any>; // JSON policy definition
  priority: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * System role names that are protected from modification/deletion
 */
export const SYSTEM_ROLES = [
  'super_admin',
  'admin',
  'moderator',
  'user'
] as const;

export type SystemRoleName = typeof SYSTEM_ROLES[number];

/**
 * Check if a role name is a system role
 */
export function isSystemRoleName(name: string): boolean {
  return SYSTEM_ROLES.includes(name as SystemRoleName);
}

/**
 * Permission actions
 */
export const PERMISSION_ACTIONS = [
  'create',
  'read',
  'update',
  'delete',
  'list',
  'manage',
  'execute',
  '*'
] as const;

export type PermissionAction = typeof PERMISSION_ACTIONS[number];

/**
 * Permission resources
 */
export const PERMISSION_RESOURCES = [
  'users',
  'content',
  'settings',
  'audit',
  'analytics',
  'system',
  '*'
] as const;

export type PermissionResource = typeof PERMISSION_RESOURCES[number];

/**
 * Permission scopes
 */
export const PERMISSION_SCOPES = [
  'own',
  'team',
  'org',
  'all',
  '*'
] as const;

export type PermissionScope = typeof PERMISSION_SCOPES[number];

/**
 * Parse a permission string into its components
 */
export function parsePermission(permission: string): {
  resource: string;
  action: string;
  scope: string;
} | null {
  const parts = permission.split(':');
  if (parts.length !== 3) {
    return null;
  }

  return {
    resource: parts[0],
    action: parts[1],
    scope: parts[2]
  };
}

/**
 * Check if a permission matches a pattern (supports wildcards)
 */
export function matchesPermissionPattern(
  permission: string,
  pattern: string
): boolean {
  const permParts = permission.split(':');
  const patternParts = pattern.split(':');

  if (permParts.length !== 3 || patternParts.length !== 3) {
    return false;
  }

  for (let i = 0; i < 3; i++) {
    if (patternParts[i] !== '*' && patternParts[i] !== permParts[i]) {
      return false;
    }
  }

  return true;
}