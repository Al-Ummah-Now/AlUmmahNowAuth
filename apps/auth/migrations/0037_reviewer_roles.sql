-- Migration: 0037_reviewer_roles
-- Description: Video review roles (AlUmmahNow wiki AUN-VIDEO-REVIEW, owner decision VR7). A content
-- reviewer decides videos and images the automated check held (never escalations or items with a
-- minor); a senior reviewer also decides escalations and appeals. Both reach only the review queue
-- (videos admin and the native Admin app), never other admin pages. Granted by an admin. Data only.
INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
VALUES ('role_content_reviewer', 'Content reviewer', 'default', 'Decides videos and images held by pre-publication review (not escalations)', 0, unixepoch() * 1000, unixepoch() * 1000);
INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
VALUES ('role_senior_reviewer', 'Senior reviewer', 'default', 'Decides held items including escalations, minor-present items and appeals', 0, unixepoch() * 1000, unixepoch() * 1000);
