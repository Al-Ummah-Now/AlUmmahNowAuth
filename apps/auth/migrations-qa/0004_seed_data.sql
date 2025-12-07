-- Migration: 0004_seed_data
-- Description: Seed data for QA environment

-- Update default tenant with QA domain
UPDATE tenants SET domain = 'auth.qa.alummahnow.net' WHERE id = 'default';

-- Insert OAuth clients for profile and admin apps (QA environment)
INSERT OR IGNORE INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, scopes, created_at, updated_at, tenant_id)
VALUES
    ('profile-app', NULL, 'Profile Application', '["http://localhost:3302/callback","https://profile.auth.qa.alummahnow.net/callback"]', '["authorization_code","refresh_token"]', '["openid","profile","email"]', unixepoch() * 1000, unixepoch() * 1000, 'default'),
    ('admin-dashboard', NULL, 'Admin Dashboard', '["http://localhost:3303/callback","https://admin.auth.qa.alummahnow.net/callback"]', '["authorization_code","refresh_token"]', '["openid","profile","email","admin"]', unixepoch() * 1000, unixepoch() * 1000, 'default');
