-- Migration: 0040_admin_android_client
-- Native "Al Ummah Now Admin" app for Android phones (wiki AUN-ADMIN-NATIVE, AD5), next to Admin (iOS),
-- Admin (macOS) (0036) and Admin (Windows) (0039): a public PKCE client (metadata.type "native", PKCE S256
-- required). The app opens sign-in in a Chrome Custom Tab and receives alummahnow-admin://auth/callback
-- through its intent filter (no App Link, no loopback). It is internal (Play internal testing only) and
-- admin-api checks the staff role on every call; this row only lets it sign in. Stage replays this file.
-- INSERT OR IGNORE keeps the migration idempotent; the id is fixed so the app hard-codes it per environment.

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('6634c4c9-a80d-4961-9427-d997349f8ea2', 'default', 'Admin (Android)', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email","offline_access"]', '["alummahnow-admin://auth/callback"]', '{"type":"native","pkce":"required","platforms":["android"]}', 1, unixepoch() * 1000, unixepoch() * 1000);
