-- Migration: 0005_add_admin_role
-- Description: Add Admin role for user management
-- Issue: 0004_seed_data.sql was already applied without Admin role

-- Admin role (administrative access) - required for E2E tests and admin users
INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
VALUES ('role_admin', 'Admin', 'default', 'Administrative access', 0, unixepoch() * 1000, unixepoch() * 1000);
