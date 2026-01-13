-- Migration: 0009_ensure_admin_role
-- Description: Ensure Admin role exists for user management
-- Issue: 0008_add_admin_role.sql may have already been applied, but role might not exist
-- This uses INSERT OR IGNORE to be safe to run multiple times

-- Admin role (administrative access) - required for E2E tests and admin users
INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
VALUES ('role_admin', 'Admin', 'default', 'Administrative access', 0, unixepoch() * 1000, unixepoch() * 1000);
