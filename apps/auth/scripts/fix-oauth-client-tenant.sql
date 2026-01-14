-- ============================================================================
-- FIX OAUTH CLIENT TENANT_ID (Idempotent)
-- ============================================================================
-- This script ensures all OAuth clients have tenant_id='default' if NULL.
-- Uses UPDATE to fix clients that may have been created before tenant_id
-- column was added or properly populated.
-- Run after schema migrations to ensure clients have correct tenant isolation.
-- ============================================================================

-- Fix Auth Admin client (used for M2M requests)
UPDATE oauth_clients
SET tenant_id = 'default', updated_at = strftime('%s', 'now') * 1000
WHERE id = '2448ed27-39a6-417d-b4c8-07f881e81269'
  AND (tenant_id IS NULL OR tenant_id = '');

-- Fix Auth Profile client
UPDATE oauth_clients
SET tenant_id = 'default', updated_at = strftime('%s', 'now') * 1000
WHERE id = '209a1087-6626-40f7-8a7f-7f42f83f4f30'
  AND (tenant_id IS NULL OR tenant_id = '');

-- Fix any other QA clients that might have NULL tenant_id
-- This is a catch-all to ensure multi-tenant isolation works correctly
UPDATE oauth_clients
SET tenant_id = 'default', updated_at = strftime('%s', 'now') * 1000
WHERE tenant_id IS NULL OR tenant_id = '';
