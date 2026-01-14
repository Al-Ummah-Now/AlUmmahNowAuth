-- ============================================================================
-- SEED RBAC ROLES (Idempotent)
-- ============================================================================
-- This script ensures the 8 system roles from OpenAuth are present.
-- Uses INSERT OR IGNORE to be safe to run multiple times.
-- Run after schema migrations to ensure roles exist for E2E tests.
-- ============================================================================

-- Super Admin Role (all permissions)
INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
VALUES (
    'role_super_admin',
    'Super Admin',
    'default',
    'Full system access with all permissions',
    1,
    strftime('%s', 'now') * 1000,
    strftime('%s', 'now') * 1000
);

-- Admin Role (manage users and clients)
INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
VALUES (
    'role_admin',
    'Admin',
    'default',
    'Administrative access for user and client management',
    1,
    strftime('%s', 'now') * 1000,
    strftime('%s', 'now') * 1000
);

-- User Manager Role (manage users only)
INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
VALUES (
    'role_user_manager',
    'User Manager',
    'default',
    'Manage user accounts and roles',
    1,
    strftime('%s', 'now') * 1000,
    strftime('%s', 'now') * 1000
);

-- Client Manager Role (manage OAuth clients)
INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
VALUES (
    'role_client_manager',
    'Client Manager',
    'default',
    'Manage OAuth clients and their configurations',
    1,
    strftime('%s', 'now') * 1000,
    strftime('%s', 'now') * 1000
);

-- Auditor Role (read-only access to logs)
INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
VALUES (
    'role_auditor',
    'Auditor',
    'default',
    'Read-only access to audit logs and system information',
    1,
    strftime('%s', 'now') * 1000,
    strftime('%s', 'now') * 1000
);

-- API User Role (basic API access)
INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
VALUES (
    'role_api_user',
    'API User',
    'default',
    'Basic API read/write access',
    0,
    strftime('%s', 'now') * 1000,
    strftime('%s', 'now') * 1000
);

-- Member Role (default user role)
INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
VALUES (
    'role_member',
    'Member',
    'default',
    'Standard member with basic access',
    0,
    strftime('%s', 'now') * 1000,
    strftime('%s', 'now') * 1000
);

-- Viewer Role (read-only)
INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
VALUES (
    'role_viewer',
    'Viewer',
    'default',
    'Read-only access to resources',
    0,
    strftime('%s', 'now') * 1000,
    strftime('%s', 'now') * 1000
);

-- ============================================================================
-- SEED SYSTEM ADMIN USER (For M2M and testing)
-- ============================================================================
-- Create a known system admin user that can be used for M2M authentication
-- and testing purposes. This user has a predictable ID for easy reference.
-- ============================================================================

-- System Admin User (uses OpenAuth users table schema)
INSERT OR IGNORE INTO users (id, tenant_id, email, name, status, created_at, updated_at)
VALUES (
    'system_admin_user',
    'default',
    'system-admin@internal.local',
    'System Admin',
    'active',
    strftime('%s', 'now') * 1000,
    strftime('%s', 'now') * 1000
);

-- Assign Super Admin role to system admin user
INSERT OR IGNORE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by)
VALUES (
    'system_admin_user',
    'role_super_admin',
    'default',
    strftime('%s', 'now') * 1000,
    'system'
);
