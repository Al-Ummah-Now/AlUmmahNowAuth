-- Migration number: 0014
-- Description: Add missing indexes for performance optimization
-- Date: 2025-01-18T12:00:00.000Z

-- Add index on parent_token_id for efficient chain traversal
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_parent_token_id ON refresh_tokens(parent_token_id);

-- Add composite index for revocation queries
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_revoked_reason ON refresh_tokens(revoked, revoked_reason);
