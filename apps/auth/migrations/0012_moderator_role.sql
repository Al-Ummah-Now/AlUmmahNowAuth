-- Migration: 0012_moderator_role
-- Description: Moderator role (video moderation; CMS editor). Production and QA already have
-- it (created by hand), stage replays these migrations and did not. Mirrors the production row.
INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
VALUES ('role_moderator', 'Moderator', 'default', 'Video platform content moderation', 0, unixepoch() * 1000, unixepoch() * 1000);
