-- Migration: 0005_update_admin_client_secret
-- Description: Update Auth Admin client redirect_uris for React Router's /auth/callback route
--              and mark it as a confidential client.
-- Fixes: OAuth redirect_uri mismatch causing admin login to fail
--
-- SECURITY: Client secrets are NOT stored in migrations.
-- The Auth Admin client's secret (and its client_secret_hash) is provisioned
-- out-of-band:
--   * The plaintext value lives only in the E2E_ADMIN_CLIENT_SECRET GitHub
--     Actions secret, which CI writes to the admin worker as ADMIN_CLIENT_SECRET.
--   * The matching hash is written to oauth_clients.client_secret_hash with an
--     operator-run command (generate the hash with openauth's hashClientSecret,
--     or use `openauth bootstrap-secrets`), never committed to the repository.
-- An earlier revision of this file contained a plaintext secret and its hash;
-- that value is considered compromised and must be rotated.
UPDATE oauth_clients SET
  redirect_uris = '["http://localhost:3303/auth/callback","https://admin.auth.qa.alummahnow.net/auth/callback"]',
  metadata = '{"type":"confidential"}'
WHERE id = '2448ed27-39a6-417d-b4c8-07f881e81269';
