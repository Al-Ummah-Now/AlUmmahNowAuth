-- Migration: 0029_scholar_role
-- Description: Scholar role. A scholar writes articles in the CMS (CMS role "writer": their own posts
-- only) and publishes them to their scholar page on www and their channel's Community tab. Editors
-- then feature selected items on the main site. Granted by an admin (accounts admin, or the videos
-- admin's invite form). Data only: no schema change.
INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
VALUES ('role_scholar', 'Scholar', 'default', 'Writes articles in the CMS (own posts only) for their scholar page on www', 0, unixepoch() * 1000, unixepoch() * 1000);
