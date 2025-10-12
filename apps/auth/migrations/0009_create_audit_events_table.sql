-- Create audit_events table for storing security-relevant events
-- This table tracks all authentication, authorization, and account management events

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'error', 'critical')),
  user_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  success INTEGER NOT NULL CHECK(success IN (0, 1)),
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index on timestamp for time-based queries
CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp);

-- Index on event_type for filtering by event type
CREATE INDEX IF NOT EXISTS idx_audit_events_event_type ON audit_events(event_type);

-- Index on user_id for user-specific audit trails
CREATE INDEX IF NOT EXISTS idx_audit_events_user_id ON audit_events(user_id);

-- Index on severity for finding critical/error events
CREATE INDEX IF NOT EXISTS idx_audit_events_severity ON audit_events(severity);

-- Composite index for user activity over time
CREATE INDEX IF NOT EXISTS idx_audit_events_user_timestamp ON audit_events(user_id, timestamp);

-- Index on request_id for tracing specific requests
CREATE INDEX IF NOT EXISTS idx_audit_events_request_id ON audit_events(request_id);
