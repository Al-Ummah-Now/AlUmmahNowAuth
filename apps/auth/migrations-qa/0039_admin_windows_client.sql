-- Migration: 0039_admin_windows_client
-- Native "Al Ummah Now Admin" app for Windows (wiki AUN-ADMIN-NATIVE, AD5), next to Admin (iOS) and
-- Admin (macOS) in 0036: a public PKCE client (metadata.type "native", PKCE S256 required). The app opens
-- sign-in in the system browser and receives alummahnow-admin://auth/callback through its registered
-- protocol (no loopback). It is internal (signed MSIX, internal channel) and admin-api checks the staff
-- role on every call; this row only lets it sign in. QA id (stage and production use migrations/).
-- INSERT OR IGNORE keeps the migration idempotent; the id is fixed so the app hard-codes it per environment.

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('306b6f10-d9f0-4609-84a1-23c92da978e9', 'default', 'Admin (Windows)', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email","offline_access"]', '["alummahnow-admin://auth/callback"]', '{"type":"native","pkce":"required","platforms":["windows"]}', 1, unixepoch() * 1000, unixepoch() * 1000);
