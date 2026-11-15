-- Migration: 0042_scoped_revocations
-- Per-device and per-install sign-out (AlUmmahNow#442, AlUmmahNowAuth#277, #363).
-- user_revocations (0026) ends every sign-in of a user. This table ends a part of them:
--   s:<sid>                  one browser sign-in (openauth sessionTokenId(browser session, user))
--   i:<user_id>:<install_id> one native app install's refresh tokens
--   c:<user_id>:<client_id>  every refresh token of one user at one client
-- A refresh token (or, for s:, an access token at the resource servers via the KV copy) whose
-- sign-in predates revoked_before is refused. Rows are looked up by primary key only.
CREATE TABLE IF NOT EXISTS scoped_revocations (
  scope_key TEXT PRIMARY KEY,
  revoked_before INTEGER NOT NULL,
  reason TEXT,
  updated_at INTEGER NOT NULL
);

-- The videos admin's M2M client (0022) may also revoke one install's or client's refresh
-- tokens (POST /internal/token-revocations): the Admin app's "Sign out this device".
UPDATE oauth_clients
SET scopes = json_insert(scopes, '$[#]', 'tokens:revoke'), updated_at = unixepoch() * 1000
WHERE id = 'd7464de8-363d-4fc1-b1af-7c71653f0afc'
  AND NOT EXISTS (SELECT 1 FROM json_each(oauth_clients.scopes) WHERE value = 'tokens:revoke');
