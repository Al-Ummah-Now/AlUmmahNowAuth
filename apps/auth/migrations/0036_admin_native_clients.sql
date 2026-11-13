-- Migration: 0036_admin_native_clients
-- Native "Al Ummah Now Admin" app (wiki AUN-ADMIN-NATIVE, AD5): public PKCE clients with
-- metadata.type "native" (PKCE S256 required), one per platform, redirect
-- alummahnow-admin://auth/callback only (ASWebAuthenticationSession; no universal link, no loopback).
-- The app is internal (TestFlight only) and checks the staff role with admin-api on every call;
-- these rows only let it sign in. Stage replays this file.
-- INSERT OR IGNORE keeps the migration idempotent; ids are fixed so the app hard-codes them per environment.

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('95adb86e-fdfb-4955-984b-347aa16a5023', 'default', 'Admin (iOS)', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email","offline_access"]', '["alummahnow-admin://auth/callback"]', '{"type":"native","pkce":"required","platforms":["ios","ipados"]}', 1, unixepoch() * 1000, unixepoch() * 1000);

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('6a65d365-1352-4ffa-922f-4053d461ac3a', 'default', 'Admin (macOS)', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email","offline_access"]', '["alummahnow-admin://auth/callback"]', '{"type":"native","pkce":"required","platforms":["macos"]}', 1, unixepoch() * 1000, unixepoch() * 1000);
