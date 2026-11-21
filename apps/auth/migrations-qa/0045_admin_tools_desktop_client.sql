-- Migration: 0045_admin_tools_desktop_client
-- "Al Ummah Now Tools", the staff desktop app for bulk import (wiki TOOLS-ADMIN), on Windows, macOS
-- and Linux: a public PKCE client (metadata.type "native", PKCE S256 required), no secret. The app opens
-- sign-in in the system browser and receives the code on a loopback listener,
-- http://127.0.0.1:{any port}/auth/callback (RFC 8252 7.3; the port may vary, as for Studio (desktop)
-- in 0013). It is for staff only: the id is in ADMIN_NATIVE_CLIENT_IDS, so a refresh is refused once
-- the user holds no staff role, and admin-api checks its own import permissions on every call.
-- Stage replays the prod file. INSERT OR IGNORE keeps it idempotent; the id is fixed so the app
-- hard-codes it per environment.

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('75f36653-4dfd-44af-8f67-588a5b7e9613', 'default', 'Admin Tools (desktop)', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email","offline_access"]', '["http://127.0.0.1/auth/callback"]', '{"type":"native","pkce":"required","platforms":["windows","macos","linux"]}', 1, unixepoch() * 1000, unixepoch() * 1000);
