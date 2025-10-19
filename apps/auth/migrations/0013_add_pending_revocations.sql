-- Migration number: 0013
-- Description: Add pending_revocations table for grace period handling
-- Date: 2025-01-18T12:00:00.000Z

-- Pending revocations table for grace period handling
-- Since Cloudflare Workers doesn't support setTimeout, we use a cron trigger
-- to process revocations after the grace period
CREATE TABLE IF NOT EXISTS pending_revocations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  token_id TEXT NOT NULL,
  revoke_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (token_id) REFERENCES refresh_tokens(id) ON DELETE CASCADE
);

-- Index for efficient lookup of revocations to process
CREATE INDEX IF NOT EXISTS idx_pending_revocations_revoke_at ON pending_revocations(revoke_at);
