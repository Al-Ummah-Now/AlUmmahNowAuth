-- Migration: 0008_add_admin_role
-- Description: Add Admin role for E2E tests that create users with admin role
-- Issue: Tests try to create users with role "admin" but this role doesn't exist in QA

-- Admin role (administrative access) - required for E2E tests
INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
VALUES ('role_admin', 'Admin', 'default', 'Administrative access', 0, unixepoch() * 1000, unixepoch() * 1000);
