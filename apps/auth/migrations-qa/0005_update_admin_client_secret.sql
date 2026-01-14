-- Migration: 0005_update_admin_client_secret
-- Description: Update Auth Admin client with client_secret_hash for M2M authentication
--              and correct redirect_uris for React Router's /auth/callback route
-- Fixes: E2E tests failing because M2M token requests return invalid_client
--        and OAuth redirect_uri mismatch causing login to fail

-- Auth Admin client needs:
-- 1. client_secret_hash for client_credentials grant
--    Plain secret: e2e-admin-client-secret-12345 (set as ADMIN_CLIENT_SECRET in CI)
--    Hash generated with: await hashClientSecret('e2e-admin-client-secret-12345')
-- 2. redirect_uris updated to /auth/callback (React Router route path)
UPDATE oauth_clients SET
  client_secret_hash = '$pbkdf2-sha256$100000$c7HVjbQIu83H8MVouSq3Sg$Cn_m6839hln5O4X1CuxMhIyq5fUKkIuk6osyhd8izTE',
  redirect_uris = '["http://localhost:3303/auth/callback","https://admin.auth.qa.alummahnow.net/auth/callback"]',
  metadata = '{"type":"confidential"}'
WHERE id = '2448ed27-39a6-417d-b4c8-07f881e81269';
