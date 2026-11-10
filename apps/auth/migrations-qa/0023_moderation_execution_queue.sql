-- Migration: 0023_moderation_execution_queue
-- An approved moderation request's action now runs from a queue
-- (moderation-actions, retried with backoff, then a dead-letter queue) instead of
-- inside the approve request. These columns track that run; execution_status
-- 'failed' flags the request for an auth admin. Expand-only.
--   execution_status: NULL (nothing to run) | queued | retrying | failed | done
ALTER TABLE moderation_requests ADD COLUMN execution_status TEXT;
ALTER TABLE moderation_requests ADD COLUMN execution_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE moderation_requests ADD COLUMN execution_updated_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_moderation_requests_execution ON moderation_requests(execution_status, updated_at);
