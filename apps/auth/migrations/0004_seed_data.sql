-- Migration: 0004_seed_data
-- Description: Seed data for production environment

-- Update default tenant with production domain
UPDATE tenants SET domain = 'auth.alummahnow.net' WHERE id = 'default';

-- Insert OAuth clients for profile and admin apps (production environment)
-- Schema: id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at
INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('109a1087-6626-40f7-8a7f-7f42f83f4f30', 'default', 'Profile Application', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email"]', '["http://localhost:3302/callback","https://profile.auth.alummahnow.net/callback"]', '{}', 1, unixepoch() * 1000, unixepoch() * 1000);

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('1448ed27-39a6-417d-b4c8-07f881e81269', 'default', 'Admin Dashboard', NULL, '["authorization_code","refresh_token","client_credentials"]', '["openid","profile","email","admin","admin:users","admin:roles","admin:clients"]', '["http://localhost:3303/callback","https://admin.auth.alummahnow.net/callback"]', '{}', 1, unixepoch() * 1000, unixepoch() * 1000);
