-- Migration number: 0011 	 2025-01-13T00:00:00.000Z
-- Role-Based Access Control (RBAC) System Tables
-- This migration creates the complete RBAC infrastructure
--
-- DEPENDENCIES:
-- - Migration 0003: Requires 'role' column in user table (VARCHAR, values: 'admin', 'user')
-- - This migration will work alongside the existing role column for backward compatibility
-- - Existing role data will be migrated to the new RBAC system (see lines 246-266)

-- 1. Roles table: Defines available roles in the system
CREATE TABLE IF NOT EXISTS roles (
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
CREATE TABLE IF NOT EXISTS permissions (
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

-- 3. Role-Permission mapping: Which permissions belong to which roles
CREATE TABLE IF NOT EXISTS role_permissions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_by TEXT REFERENCES user(id),
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(role_id, permission_id)
);

-- 4. User-Role mapping: Which roles are assigned to which users
CREATE TABLE IF NOT EXISTS user_roles (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_by TEXT REFERENCES user(id),
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP, -- For temporary role assignments
  is_active BOOLEAN DEFAULT TRUE,
  UNIQUE(user_id, role_id)
);

-- 5. Direct user permissions: Override roles with direct grants/denies
CREATE TABLE IF NOT EXISTS user_permissions (
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

-- 6. Resource permissions: Permissions tied to specific resources (future enhancement)
CREATE TABLE IF NOT EXISTS resource_permissions (
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

-- 7. Permission policies: Complex permission rules (future enhancement)
CREATE TABLE IF NOT EXISTS permission_policies (
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

-- Create indexes for performance

-- User role lookups (most common query)
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_user_roles_expires ON user_roles(expires_at) WHERE expires_at IS NOT NULL;

-- Role permission lookups
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id);

-- Permission lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_permissions_name ON permissions(name);
CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions(resource, action, scope);

-- User permission lookups
CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions(user_id);

-- Resource permission lookups
CREATE INDEX IF NOT EXISTS idx_resource_permissions_lookup ON resource_permissions(resource_type, resource_id);

-- Role hierarchy
CREATE INDEX IF NOT EXISTS idx_roles_parent ON roles(parent_role_id) WHERE parent_role_id IS NOT NULL;

-- Audit trail indexes
CREATE INDEX IF NOT EXISTS idx_user_roles_granted_by ON user_roles(granted_by, granted_at);
CREATE INDEX IF NOT EXISTS idx_role_permissions_granted_by ON role_permissions(granted_by, granted_at);

-- Insert default permissions
INSERT INTO permissions (name, resource, action, scope, description, is_system) VALUES
  -- User permissions
  ('users:create:all', 'users', 'create', 'all', 'Create new users', TRUE),
  ('users:read:all', 'users', 'read', 'all', 'Read all users', TRUE),
  ('users:read:own', 'users', 'read', 'own', 'Read own user profile', TRUE),
  ('users:update:all', 'users', 'update', 'all', 'Update any user', TRUE),
  ('users:update:own', 'users', 'update', 'own', 'Update own profile', TRUE),
  ('users:delete:all', 'users', 'delete', 'all', 'Delete any user', TRUE),
  ('users:manage:all', 'users', 'manage', 'all', 'Manage user roles and permissions', TRUE),

  -- Role permissions
  ('roles:create:all', 'roles', 'create', 'all', 'Create new roles', TRUE),
  ('roles:read:all', 'roles', 'read', 'all', 'View all roles', TRUE),
  ('roles:update:all', 'roles', 'update', 'all', 'Update roles', TRUE),
  ('roles:delete:all', 'roles', 'delete', 'all', 'Delete roles', TRUE),
  ('roles:manage:all', 'roles', 'manage', 'all', 'Manage role permissions', TRUE),

  -- Content permissions
  ('content:create:all', 'content', 'create', 'all', 'Create content', TRUE),
  ('content:read:all', 'content', 'read', 'all', 'Read all content', TRUE),
  ('content:read:own', 'content', 'read', 'own', 'Read own content', TRUE),
  ('content:update:all', 'content', 'update', 'all', 'Update any content', TRUE),
  ('content:update:own', 'content', 'update', 'own', 'Update own content', TRUE),
  ('content:delete:all', 'content', 'delete', 'all', 'Delete any content', TRUE),
  ('content:delete:own', 'content', 'delete', 'own', 'Delete own content', TRUE),
  ('content:publish:all', 'content', 'publish', 'all', 'Publish any content', TRUE),
  ('content:publish:own', 'content', 'publish', 'own', 'Publish own content', TRUE),

  -- Settings permissions
  ('settings:read:all', 'settings', 'read', 'all', 'View system settings', TRUE),
  ('settings:update:all', 'settings', 'update', 'all', 'Update system settings', TRUE),
  ('settings:manage:all', 'settings', 'manage', 'all', 'Manage all settings', TRUE),

  -- Audit permissions
  ('audit:read:all', 'audit', 'read', 'all', 'View audit logs', TRUE),
  ('audit:export:all', 'audit', 'export', 'all', 'Export audit logs', TRUE),
  ('audit:delete:all', 'audit', 'delete', 'all', 'Delete audit logs', TRUE),

  -- Analytics permissions
  ('analytics:read:all', 'analytics', 'read', 'all', 'View analytics', TRUE),
  ('analytics:export:all', 'analytics', 'export', 'all', 'Export analytics data', TRUE),

  -- System permissions
  ('system:manage:all', 'system', 'manage', 'all', 'System administration', TRUE),
  ('system:health:read', 'system', 'health', 'read', 'View system health', TRUE),

  -- OAuth client permissions
  ('clients:create:all', 'clients', 'create', 'all', 'Create OAuth clients', TRUE),
  ('clients:read:all', 'clients', 'read', 'all', 'View all OAuth clients', TRUE),
  ('clients:update:all', 'clients', 'update', 'all', 'Update OAuth clients', TRUE),
  ('clients:delete:all', 'clients', 'delete', 'all', 'Delete OAuth clients', TRUE),
  ('clients:manage:all', 'clients', 'manage', 'all', 'Manage OAuth clients', TRUE),

  -- Super admin permission
  ('*:*:*', '*', '*', '*', 'Super admin - all permissions', TRUE);

-- Insert default roles
INSERT INTO roles (id, name, description, parent_role_id, is_system) VALUES
  ('role_super_admin', 'super_admin', 'Super Administrator with all permissions', NULL, TRUE),
  ('role_admin', 'admin', 'Administrator with most permissions', NULL, TRUE),
  ('role_moderator', 'moderator', 'Content moderator', NULL, TRUE),
  ('role_content_creator', 'content_creator', 'Content creator', NULL, TRUE),
  ('role_user', 'user', 'Regular user', NULL, TRUE);

-- Assign permissions to roles

-- Super Admin gets everything
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_super_admin', id FROM permissions WHERE name = '*:*:*';

-- Admin role permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_admin', id FROM permissions WHERE name IN (
  'users:create:all',
  'users:read:all',
  'users:update:all',
  'users:delete:all',
  'users:manage:all',
  'roles:read:all',
  'content:create:all',
  'content:read:all',
  'content:update:all',
  'content:delete:all',
  'content:publish:all',
  'settings:read:all',
  'settings:update:all',
  'audit:read:all',
  'analytics:read:all',
  'clients:read:all',
  'clients:manage:all'
);

-- Moderator role permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_moderator', id FROM permissions WHERE name IN (
  'users:read:all',
  'content:read:all',
  'content:update:all',
  'content:delete:all',
  'content:publish:all',
  'analytics:read:all'
);

-- Content Creator role permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_content_creator', id FROM permissions WHERE name IN (
  'content:create:all',
  'content:read:own',
  'content:update:own',
  'content:delete:own',
  'content:publish:own',
  'users:read:own',
  'users:update:own'
);

-- Regular User role permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_user', id FROM permissions WHERE name IN (
  'users:read:own',
  'users:update:own',
  'content:read:all'
);

-- Migrate existing users to new RBAC system
-- Assign roles based on existing 'role' field in user table

-- Assign admin role to existing admins
INSERT INTO user_roles (user_id, role_id, granted_by)
SELECT u.id, 'role_admin', 'system-migration'
FROM user u
WHERE u.role = 'admin'
  AND NOT EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = u.id AND ur.role_id = 'role_admin'
  );

-- Assign user role to existing regular users
INSERT INTO user_roles (user_id, role_id, granted_by)
SELECT u.id, 'role_user', 'system-migration'
FROM user u
WHERE u.role = 'user'
  AND NOT EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = u.id AND ur.role_id = 'role_user'
  );

-- Create view for efficient permission lookups (optional, for reference)
-- Note: Views in D1 are read-only and cannot be materialized
CREATE VIEW IF NOT EXISTS user_effective_permissions AS
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

-- Include direct user permissions (grants)
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

-- Add trigger to update the updated_at timestamp (if D1 supports triggers)
-- Note: D1 may not support triggers, this is for reference
-- CREATE TRIGGER IF NOT EXISTS update_roles_updated_at
-- AFTER UPDATE ON roles
-- BEGIN
--   UPDATE roles SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
-- END;