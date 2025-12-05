-- Migration: 0004_seed_data
-- Description: Seed data for OAuth clients (default tenant created by OpenAuth)

-- Note: OpenAuth's 002_add_tenant_support.sql migration creates the 'default' tenant
-- We only need to seed OAuth clients for our applications

-- Insert OAuth clients for profile and admin apps
-- client_id, client_secret_hash (NULL for public clients), client_name, redirect_uris (JSON), grant_types (JSON), scopes (JSON), created_at, updated_at, tenant_id
INSERT OR IGNORE INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, scopes, created_at, updated_at, tenant_id)
VALUES
    ('profile-app', NULL, 'Profile Application', '["http://localhost:5174/callback","https://profile.al-ummah-now.com/callback"]', '["authorization_code","refresh_token"]', '["openid","profile","email"]', unixepoch() * 1000, unixepoch() * 1000, 'default'),
    ('admin-dashboard', NULL, 'Admin Dashboard', '["http://localhost:5175/callback","https://admin.al-ummah-now.com/callback"]', '["authorization_code","refresh_token"]', '["openid","profile","email","admin"]', unixepoch() * 1000, unixepoch() * 1000, 'default');
