-- Migration: 0020_remove_content_creator_role.sql
-- Description: Remove the content_creator role from the RBAC system

-- First, reassign any users with content_creator role to 'user' role
INSERT OR IGNORE INTO user_roles (id, user_id, role_id, granted_by, granted_at, is_active)
SELECT
  lower(hex(randomblob(16))),
  ur.user_id,
  'role_user',
  'system-migration',
  CURRENT_TIMESTAMP,
  1
FROM user_roles ur
WHERE ur.role_id = 'role_content_creator'
  AND NOT EXISTS (
    SELECT 1 FROM user_roles ur2
    WHERE ur2.user_id = ur.user_id AND ur2.role_id = 'role_user'
  );

-- Remove user role assignments for content_creator
DELETE FROM user_roles WHERE role_id = 'role_content_creator';

-- Remove role permissions for content_creator
DELETE FROM role_permissions WHERE role_id = 'role_content_creator';

-- Remove the content_creator role
DELETE FROM roles WHERE id = 'role_content_creator';
