-- Migration: 0034_sites_clients
-- Registers the scholar sites (AlUmmahNowUI apps/sites, wiki AUN-SCHOLAR-SITES) as ONE public PKCE
-- client for every white-label site. No redirect_uris are listed: on /authorize auth accepts the one
-- exact `https://<host>/auth/callback` of the request when <host> is a live site's primary host in the
-- site registry (src/utils/site-redirects.ts). Never a wildcard. QA client (its own id).
-- INSERT OR IGNORE keeps the migration idempotent; the id is fixed so the sites Worker hard-codes it.

INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
VALUES ('0abd9eac-e47e-4a1a-90bd-18cffec0303c', 'default', 'Al Ummah Now (sites)', NULL, '["authorization_code","refresh_token"]', '["openid","profile","email"]', '[]', '{"type":"public"}', 1, unixepoch() * 1000, unixepoch() * 1000);
