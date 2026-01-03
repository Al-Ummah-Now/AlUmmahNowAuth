-- Migration: 0004_seed_data
-- Description: Seed data for production environment

-- Update default tenant with production domain
UPDATE tenants SET domain = 'auth.alummahnow.net' WHERE id = 'default';

-- Insert OAuth clients for profile and admin apps (production environment)
-- Schema: id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at
INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('109a1087-6626-40f7-8a7f-7f42f83f4f30', 'default', 'Auth Profile', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email"]', '["http://localhost:3302/callback","https://profile.auth.alummahnow.net/callback"]', '{}', 1, unixepoch() * 1000, unixepoch() * 1000);

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('1448ed27-39a6-417d-b4c8-07f881e81269', 'default', 'Auth Admin', NULL, '["authorization_code","refresh_token","client_credentials"]', '["openid","profile","email","admin","admin:users","admin:roles","admin:clients"]', '["http://localhost:3303/callback","https://admin.auth.alummahnow.net/callback"]', '{}', 1, unixepoch() * 1000, unixepoch() * 1000);

-- Video Platform OAuth Clients

-- Web (public client for user-facing video platform frontend)
INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('f0de3c30-0304-4ac4-86d6-1e185dec0439', 'default', 'Web', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email"]', '["http://localhost:3001/api/callback","https://videos.alummahnow.net/api/callback"]', '{"type":"public"}', 1, unixepoch() * 1000, unixepoch() * 1000);

-- Admin Web (confidential client for admin dashboard frontend)
INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('a24e39de-601d-463b-b50d-37a0a94e986b', 'default', 'Admin Web', NULL, '["authorization_code","refresh_token","client_credentials"]', '["openid","profile","email"]', '["http://localhost:3091/api/callback","https://admin.alummahnow.net/api/callback"]', '{}', 1, unixepoch() * 1000, unixepoch() * 1000);

-- Admin API (M2M client for admin backend API)
INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('da8c93f8-5cef-4a01-806a-950fe2c5b43d', 'default', 'Admin API', NULL, '["client_credentials"]', '["openid","profile","email"]', '[]', '{"type":"m2m"}', 1, unixepoch() * 1000, unixepoch() * 1000);

-- API Videos (M2M client for video platform API)
INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('b1770235-e4b6-42f3-9eb4-3c03ca111b02', 'default', 'API Videos', NULL, '["client_credentials"]', '["openid","profile","email"]', '[]', '{"type":"m2m"}', 1, unixepoch() * 1000, unixepoch() * 1000);

-- WebSocket Server (M2M client for real-time communication server)
INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('adea61f1-5720-44cd-9e61-18dbf3aee72e', 'default', 'WebSocket Server', NULL, '["client_credentials"]', '["openid","profile","email"]', '[]', '{"type":"m2m"}', 1, unixepoch() * 1000, unixepoch() * 1000);
