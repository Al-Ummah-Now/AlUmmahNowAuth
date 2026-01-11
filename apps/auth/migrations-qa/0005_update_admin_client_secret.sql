-- Migration: 0005_update_admin_client_secret
-- Description: Update Auth Admin client with client_secret_hash for M2M authentication
-- Fixes: E2E tests failing because M2M token requests return invalid_client

-- Auth Admin client needs a client_secret_hash for client_credentials grant
-- Plain secret: e2e-admin-client-secret-12345 (set as ADMIN_CLIENT_SECRET in CI)
-- Hash generated with: await hashClientSecret('e2e-admin-client-secret-12345')
UPDATE oauth_clients SET
  client_secret_hash = '$pbkdf2-sha256$100000$c7HVjbQIu83H8MVouSq3Sg$Cn_m6839hln5O4X1CuxMhIyq5fUKkIuk6osyhd8izTE',
  metadata = '{"type":"confidential"}'
WHERE id = '2448ed27-39a6-417d-b4c8-07f881e81269';
