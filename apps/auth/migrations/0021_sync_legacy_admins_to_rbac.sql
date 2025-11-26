-- Migration: 0021_sync_legacy_admins_to_rbac.sql
-- Description: Sync legacy admin users to RBAC user_roles table

-- Assign admin role to users with legacy role='admin' who don't have RBAC admin role
INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_by, is_active)
SELECT
  u.id,
  'role_admin',
  'system-migration',
  1
FROM user u
WHERE u.role = 'admin'
  AND NOT EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = u.id
    AND ur.role_id = 'role_admin'
  );

-- Assign user role to users with legacy role='user' who don't have any RBAC roles
INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_by, is_active)
SELECT
  u.id,
  'role_user',
  'system-migration',
  1
FROM user u
WHERE u.role = 'user'
  AND NOT EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = u.id
  );
