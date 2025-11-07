-- Migration number: 0017
-- Description: Seed OAuth 2.0 clients for profile app and admin dashboard
-- Date: 2025-01-25T00:00:00.000Z

-- Insert profile-app OAuth client (public client, no secret required)
INSERT INTO oauth_clients (id, client_id, client_secret_hash, client_type, allowed_grants, redirect_uris, created_at)
VALUES (
  'profile-app-id',
  'profile-app',
  NULL,
  'public',
  'authorization_code,refresh_token',
  'http://localhost:3302/callback,http://localhost:8788/callback,https://profile.auth.alummahnow.net/callback',
  strftime('%s', 'now')
);

-- Insert admin-dashboard OAuth client (public client, no secret required)
INSERT INTO oauth_clients (id, client_id, client_secret_hash, client_type, allowed_grants, redirect_uris, created_at)
VALUES (
  'admin-dashboard-id',
  'admin-dashboard',
  NULL,
  'public',
  'authorization_code,refresh_token',
  'http://localhost:3303/callback,http://localhost:3304/callback,http://localhost:5175/callback,https://admin.alummah.app/callback',
  strftime('%s', 'now')
);
