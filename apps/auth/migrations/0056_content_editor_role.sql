-- Migration: 0056_content_editor_role
-- Description: Assignable Content Editor role for the CMS. The CMS authorizes
-- access using the role name in the token.
INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
VALUES ('role_content_editor', 'Content Editor', 'default', 'Edit website content in the CMS', 0, unixepoch() * 1000, unixepoch() * 1000);
