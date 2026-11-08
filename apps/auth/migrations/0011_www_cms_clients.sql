-- Migration: 0011_www_cms_clients
-- Registers the public site (www) and its content admin (cms) as OAuth clients.
-- Both are public PKCE clients (no secret): the authorization_code grant checks
-- client_id, the exact redirect_uri and PKCE, not a client secret, so a secret
-- would add nothing (see AlUmmahNowCMS docs/SPEC.md §3).
-- redirect_uris are matched exactly (full string). Stage replays this file and
-- scripts/stage/seed.ts rewrites the hosts to *.stage.alummahnow.net.
-- INSERT OR IGNORE keeps the migration idempotent; ids are fixed so the apps can
-- hard-code them per environment.

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('d34701ed-03de-43f8-95a8-91cd1e1874bb', 'default', 'Al Ummah Now (www)', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email"]', '["http://localhost:4321/auth/callback","https://www.alummahnow.net/auth/callback"]', '{"type":"public"}', 1, unixepoch() * 1000, unixepoch() * 1000);

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('d06fd65a-5b79-45bc-8bfd-a856b8502330', 'default', 'CMS', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email"]', '["http://localhost:8585/sso/callback","https://cms.alummahnow.net/sso/callback"]', '{"type":"public"}', 1, unixepoch() * 1000, unixepoch() * 1000);
