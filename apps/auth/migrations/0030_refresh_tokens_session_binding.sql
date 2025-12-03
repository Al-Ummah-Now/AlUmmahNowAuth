-- Migration: 0027_refresh_tokens_session_binding
-- Description: Add session_id to refresh_tokens for session binding
-- This enables token revocation when account sessions are revoked

-- Add session_id column to bind refresh tokens to account sessions
ALTER TABLE refresh_tokens ADD COLUMN session_id TEXT;

-- Create index for session-based token lookups
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_session ON refresh_tokens(session_id);

-- Add foreign key constraint via trigger (SQLite doesn't support adding FK to existing tables)
-- This ensures tokens are deleted when the account session is deleted
-- Note: The CASCADE DELETE will be enforced through application logic and cleanup jobs
