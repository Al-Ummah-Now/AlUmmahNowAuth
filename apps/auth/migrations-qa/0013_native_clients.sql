-- Migration: 0013_native_clients
-- Epic 9.1: OAuth clients for the native apps (al-ummah-now monorepo,
-- docs/native-apps/EPIC-9-PLAN.md). All are PUBLIC clients (no secret) with
-- metadata.type "native", so the issuer requires PKCE (S256) for them
-- (@al-ummah-now/openauth >= the native-clients release).
-- redirect_uris are matched exactly, except loopback http://127.0.0.1/... whose
-- port may vary (RFC 8252 7.3). Custom schemes are allowed because they are
-- registered here (client registry). viewer-tv uses the device authorization
-- grant (RFC 8628, Epic 9.2) and has no redirect URIs.
-- QA: same schemes as prod (one app build per environment picks its client id);
-- universal links on videos.qa.alummahnow.net.
-- INSERT OR IGNORE keeps the migration idempotent; ids are fixed so the apps can
-- hard-code them per environment.

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('31389afb-d4f8-4c26-9492-4c77f4d07e65', 'default', 'Viewer (iOS / Android)', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email","offline_access"]', '["alummahnow://auth/callback","https://videos.qa.alummahnow.net/app/auth/callback"]', '{"type":"native","pkce":"required","platforms":["ios","ipados","android"]}', 1, unixepoch() * 1000, unixepoch() * 1000);

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('9c3a81c8-3f9c-4873-abb1-a51e4f1d9543', 'default', 'Viewer (TV)', NULL, '["urn:ietf:params:oauth:grant-type:device_code","refresh_token"]', '["openid","profile","email","offline_access"]', '[]', '{"type":"native","pkce":"required","platforms":["tvos","androidtv","firetv","tizen","webos"]}', 1, unixepoch() * 1000, unixepoch() * 1000);

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('ce7de8a4-59dd-4682-ab4d-105399105294', 'default', 'Viewer (desktop)', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email","offline_access"]', '["alummahnow://auth/callback","http://127.0.0.1/auth/callback"]', '{"type":"native","pkce":"required","platforms":["macos","windows","linux"]}', 1, unixepoch() * 1000, unixepoch() * 1000);

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('45364a42-21f4-4359-a76c-0a1e6615fd7b', 'default', 'Studio (iOS / Android)', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email","offline_access"]', '["alummahnow-studio://auth/callback","https://videos.qa.alummahnow.net/app/studio/auth/callback"]', '{"type":"native","pkce":"required","platforms":["ios","ipados","android"]}', 1, unixepoch() * 1000, unixepoch() * 1000);

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('29b4792a-caad-4814-a83f-4337bc6a1aeb', 'default', 'Studio (desktop)', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email","offline_access"]', '["alummahnow-studio://auth/callback","http://127.0.0.1/auth/callback"]', '{"type":"native","pkce":"required","platforms":["macos","windows","linux"]}', 1, unixepoch() * 1000, unixepoch() * 1000);
