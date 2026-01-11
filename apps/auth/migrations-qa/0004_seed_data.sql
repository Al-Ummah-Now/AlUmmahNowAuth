-- Migration: 0004_seed_data
-- Description: Seed data for QA environment

-- Update default tenant with QA domain
UPDATE tenants SET domain = 'auth.qa.alummahnow.net' WHERE id = 'default';

-- Insert OAuth clients for profile and admin apps (QA environment)
-- Schema: id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at
INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('209a1087-6626-40f7-8a7f-7f42f83f4f30', 'default', 'Auth Profile', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email"]', '["http://localhost:3302/callback","https://profile.auth.qa.alummahnow.net/callback"]', '{}', 1, unixepoch() * 1000, unixepoch() * 1000);

-- Auth Admin client with M2M support (client_secret required for admin API calls)
-- Plain secret: e2e-admin-client-secret-12345 (set as ADMIN_CLIENT_SECRET in CI)
INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('2448ed27-39a6-417d-b4c8-07f881e81269', 'default', 'Auth Admin', '$pbkdf2-sha256$100000$c7HVjbQIu83H8MVouSq3Sg$Cn_m6839hln5O4X1CuxMhIyq5fUKkIuk6osyhd8izTE', '["authorization_code","refresh_token","client_credentials"]', '["openid","profile","email","admin","admin:users","admin:roles","admin:clients"]', '["http://localhost:3303/callback","https://admin.auth.qa.alummahnow.net/callback"]', '{"type":"confidential"}', 1, unixepoch() * 1000, unixepoch() * 1000);

-- Update Auth Admin in case it already exists without secret (idempotent)
UPDATE oauth_clients SET
  client_secret_hash = '$pbkdf2-sha256$100000$c7HVjbQIu83H8MVouSq3Sg$Cn_m6839hln5O4X1CuxMhIyq5fUKkIuk6osyhd8izTE',
  metadata = '{"type":"confidential"}'
WHERE id = '2448ed27-39a6-417d-b4c8-07f881e81269';

-- Video Platform OAuth Clients

-- Web (public client for user-facing video platform frontend)
INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('e0de3c30-0304-4ac4-86d6-1e185dec0439', 'default', 'Web', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email"]', '["http://localhost:3001/api/callback","https://web.qa.alummahnow.net/api/callback"]', '{"type":"public"}', 1, unixepoch() * 1000, unixepoch() * 1000);

-- Admin Web (confidential client for admin dashboard frontend)
INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('b24e39de-601d-463b-b50d-37a0a94e986b', 'default', 'Admin Web', NULL, '["authorization_code","refresh_token","client_credentials"]', '["openid","profile","email"]', '["http://localhost:3091/api/callback","https://admin.qa.alummahnow.net/api/callback"]', '{}', 1, unixepoch() * 1000, unixepoch() * 1000);

-- Admin API (M2M client for admin backend API)
INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('ca8c93f8-5cef-4a01-806a-950fe2c5b43d', 'default', 'Admin API', NULL, '["client_credentials"]', '["openid","profile","email"]', '[]', '{"type":"m2m"}', 1, unixepoch() * 1000, unixepoch() * 1000);

-- API Videos (M2M client for video platform API)
INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('c1770235-e4b6-42f3-9eb4-3c03ca111b02', 'default', 'API Videos', NULL, '["client_credentials"]', '["openid","profile","email"]', '[]', '{"type":"m2m"}', 1, unixepoch() * 1000, unixepoch() * 1000);

-- WebSocket Server (M2M client for real-time communication server)
INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('bdea61f1-5720-44cd-9e61-18dbf3aee72e', 'default', 'WebSocket Server', NULL, '["client_credentials"]', '["openid","profile","email"]', '[]', '{"type":"m2m"}', 1, unixepoch() * 1000, unixepoch() * 1000);

-- RBAC Roles for QA Environment
-- Member role (basic user access) - required for E2E tests
INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
VALUES ('role_member', 'Member', 'default', 'Basic member access', 0, unixepoch() * 1000, unixepoch() * 1000);
