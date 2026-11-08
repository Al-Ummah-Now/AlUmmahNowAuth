-- Migration: 0013_native_clients
-- Epic 9.1: OAuth clients for the native apps (al-ummah-now monorepo,
-- docs/native-apps/EPIC-9-PLAN.md). All are PUBLIC clients (no secret) with
-- metadata.type "native", so the issuer requires PKCE (S256) for them
-- (@al-ummah-now/openauth >= the native-clients release).
-- redirect_uris are matched exactly, except loopback http://127.0.0.1/... whose
-- port may vary (RFC 8252 7.3). Custom schemes are allowed because they are
-- registered here (client registry). viewer-tv uses the device authorization
-- grant (RFC 8628, Epic 9.2) and has no redirect URIs.
-- Stage replays this file; scripts/stage/seed.ts rewrites the https hosts to
-- *.stage.alummahnow.net and keeps the custom-scheme and loopback URIs.
-- INSERT OR IGNORE keeps the migration idempotent; ids are fixed so the apps can
-- hard-code them per environment.

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('567a2cbc-dab8-4d5c-9437-a9e61c7120f5', 'default', 'Viewer (iOS / Android)', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email","offline_access"]', '["alummahnow://auth/callback","https://videos.alummahnow.net/app/auth/callback"]', '{"type":"native","pkce":"required","platforms":["ios","ipados","android"]}', 1, unixepoch() * 1000, unixepoch() * 1000);

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('111648c6-24e6-4c35-8bcf-f50ab5c0d96d', 'default', 'Viewer (TV)', NULL, '["urn:ietf:params:oauth:grant-type:device_code","refresh_token"]', '["openid","profile","email","offline_access"]', '[]', '{"type":"native","pkce":"required","platforms":["tvos","androidtv","firetv","tizen","webos"]}', 1, unixepoch() * 1000, unixepoch() * 1000);

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('f97abe68-ef61-41b6-bf08-d86650cc7cb3', 'default', 'Viewer (desktop)', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email","offline_access"]', '["alummahnow://auth/callback","http://127.0.0.1/auth/callback"]', '{"type":"native","pkce":"required","platforms":["macos","windows","linux"]}', 1, unixepoch() * 1000, unixepoch() * 1000);

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('6f8073c6-754b-4d63-bf80-0546214e0d62', 'default', 'Studio (iOS / Android)', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email","offline_access"]', '["alummahnow-studio://auth/callback","https://videos.alummahnow.net/app/studio/auth/callback"]', '{"type":"native","pkce":"required","platforms":["ios","ipados","android"]}', 1, unixepoch() * 1000, unixepoch() * 1000);

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('950e2b3b-6353-4472-affe-7c1f57f4e6a4', 'default', 'Studio (desktop)', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email","offline_access"]', '["alummahnow-studio://auth/callback","http://127.0.0.1/auth/callback"]', '{"type":"native","pkce":"required","platforms":["macos","windows","linux"]}', 1, unixepoch() * 1000, unixepoch() * 1000);
