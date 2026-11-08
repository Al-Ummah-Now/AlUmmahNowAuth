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
VALUES ('ecda6f18-89cb-415c-b746-7e77184d75a2', 'default', 'Al Ummah Now (www)', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email"]', '["http://localhost:4321/auth/callback","https://www.qa.alummahnow.net/auth/callback"]', '{"type":"public"}', 1, unixepoch() * 1000, unixepoch() * 1000);

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('0e613f49-674b-490a-93e5-97a35d586da1', 'default', 'CMS', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email"]', '["http://localhost:8585/sso/callback","https://cms.qa.alummahnow.net/sso/callback"]', '{"type":"public"}', 1, unixepoch() * 1000, unixepoch() * 1000);
