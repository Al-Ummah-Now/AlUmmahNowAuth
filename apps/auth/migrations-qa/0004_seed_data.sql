-- Migration: 0004_seed_data
-- Description: Seed data for QA environment

-- Update default tenant with QA domain
UPDATE tenants SET domain = 'auth.qa.alummahnow.net' WHERE id = 'default';

-- Insert OAuth clients for profile and admin apps (QA environment)
-- Schema: id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at
INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES
    ('profile-app-qa', 'default', 'Profile Application', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email"]', '["http://localhost:3302/callback","https://profile.auth.qa.alummahnow.net/callback"]', '{}', 1, unixepoch() * 1000, unixepoch() * 1000),
    ('admin-dashboard-qa', 'default', 'Admin Dashboard', NULL, '["authorization_code","refresh_token","client_credentials"]', '["openid","profile","email","admin","admin:users","admin:roles","admin:clients"]', '["http://localhost:3303/callback","https://admin.auth.qa.alummahnow.net/callback"]', '{}', 1, unixepoch() * 1000, unixepoch() * 1000);
