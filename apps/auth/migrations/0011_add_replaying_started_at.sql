-- Add replaying_started_at column to track when entries enter 'replaying' status
-- This is needed to accurately detect stale replaying entries that are stuck

ALTER TABLE webhook_dlq ADD COLUMN replaying_started_at TEXT;

-- Create index for efficient queries on stale replaying entries
CREATE INDEX IF NOT EXISTS idx_webhook_dlq_replaying_started
  ON webhook_dlq(status, replaying_started_at)
  WHERE status = 'replaying';
