-- Migration number: 0016
-- Description: Remove grace period infrastructure and add token family tracking
-- Date: 2025-01-19T00:00:00.000Z
-- Related: Issue #77 - Fix grace period bypass vulnerability

-- Step 1: Remove pending_revocations table (no longer needed with immediate invalidation)
DROP TABLE IF EXISTS pending_revocations;

-- Step 2: Remove grace_period_expires column if it exists
-- Note: D1 (SQLite) doesn't support DROP COLUMN IF EXISTS
-- We'll skip this step as the column may not exist
-- ALTER TABLE refresh_tokens DROP COLUMN grace_period_expires;

-- Step 3: Add token_family_id for tracking token families (reuse detection)
-- This allows us to revoke entire families when reuse is detected
ALTER TABLE refresh_tokens ADD COLUMN token_family_id TEXT;

-- Step 4: Create index for efficient family lookups
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_family ON refresh_tokens(token_family_id);

-- Step 5: Backfill token_family_id for existing tokens
-- Root tokens (no parent) get their own ID as family_id
-- Child tokens inherit from their root
UPDATE refresh_tokens
SET token_family_id = COALESCE(
  (
    WITH RECURSIVE token_chain AS (
      SELECT id, parent_token_id, id as root_id
      FROM refresh_tokens
      WHERE parent_token_id IS NULL

      UNION ALL

      SELECT rt.id, rt.parent_token_id, tc.root_id
      FROM refresh_tokens rt
      JOIN token_chain tc ON rt.parent_token_id = tc.id
    )
    SELECT root_id FROM token_chain WHERE id = refresh_tokens.id
  ),
  id -- Default to own ID if no family found
)
WHERE token_family_id IS NULL;
