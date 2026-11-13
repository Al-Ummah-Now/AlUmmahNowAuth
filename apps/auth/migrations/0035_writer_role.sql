-- Migration: 0035_writer_role
-- Description: Writer role (staff). A writer writes and edits Al Ummah Now's own posts in the CMS
-- (CMS role "staff_writer": the full post editor for posts with no scholar author; no pages, settings,
-- timeline, featuring or deletes). Scholars write in Studio instead (role_scholar, CMS role "writer";
-- owner decision SS18, 2026-11-13). Granted by an admin in the accounts admin. Data only: no schema change.
INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
VALUES ('role_writer', 'Writer', 'default', 'Writes and edits Al Ummah Now''s own posts in the CMS (www)', 0, unixepoch() * 1000, unixepoch() * 1000);
