-- Migration number: 0019
-- Description: Update token_usage table schema to match OpenAuth audit consumer requirements
-- Date: 2025-11-08

-- Step 1: Create new table with correct schema
CREATE TABLE IF NOT EXISTS token_usage_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  token_id TEXT NOT NULL,
  subject TEXT NOT NULL,  -- User/subject identifier (e.g., "user:123abc")
  event_type TEXT NOT NULL CHECK (event_type IN ('generated', 'refreshed', 'revoked', 'reused')),
  client_id TEXT,  -- OAuth client ID
  timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
  ip_address TEXT,
  user_agent TEXT,
  metadata TEXT  -- JSON string for additional data
);

-- Step 2: Copy existing data, mapping action -> event_type
INSERT INTO token_usage_new (id, token_id, subject, event_type, client_id, timestamp, ip_address, user_agent, metadata)
SELECT
  id,
  token_id,
  COALESCE((SELECT 'user:' || user_id FROM refresh_tokens WHERE id = token_usage.token_id), 'unknown') as subject,
  action as event_type,  -- Map action to event_type
  (SELECT client_id FROM refresh_tokens WHERE id = token_usage.token_id) as client_id,
  timestamp,
  ip_address,
  user_agent,
  metadata
FROM token_usage;

-- Step 3: Drop old table
DROP TABLE token_usage;

-- Step 4: Rename new table
ALTER TABLE token_usage_new RENAME TO token_usage;

-- Step 5: Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_token_usage_token_id ON token_usage(token_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp);
CREATE INDEX IF NOT EXISTS idx_token_usage_subject ON token_usage(subject);
CREATE INDEX IF NOT EXISTS idx_token_usage_client_id ON token_usage(client_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_event_type ON token_usage(event_type);
