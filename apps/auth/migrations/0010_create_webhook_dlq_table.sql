-- Create webhook_dlq table for storing failed webhook deliveries
-- This table acts as a dead letter queue for audit events that couldn't be delivered

CREATE TABLE IF NOT EXISTS webhook_dlq (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  events TEXT NOT NULL,          -- JSON array of AuditEvent objects
  webhook_url TEXT NOT NULL,     -- Target webhook URL that failed
  error TEXT,                     -- Last error message from delivery attempt
  timestamp TEXT NOT NULL,        -- ISO8601 timestamp of failure
  retry_count INTEGER DEFAULT 0, -- Number of retries attempted before DLQ
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'replaying', 'completed', 'failed')),
  replayed_at TEXT,               -- ISO8601 timestamp when manual replay occurred
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index for time-based queries (e.g., recent failures)
CREATE INDEX IF NOT EXISTS idx_webhook_dlq_timestamp ON webhook_dlq(timestamp);

-- Index for filtering by status (e.g., pending replays)
CREATE INDEX IF NOT EXISTS idx_webhook_dlq_status ON webhook_dlq(status);

-- Index for cleanup operations (TTL-based deletion)
CREATE INDEX IF NOT EXISTS idx_webhook_dlq_created_at ON webhook_dlq(created_at);

-- Composite index for efficient queries on pending items by age
CREATE INDEX IF NOT EXISTS idx_webhook_dlq_status_timestamp ON webhook_dlq(status, timestamp);