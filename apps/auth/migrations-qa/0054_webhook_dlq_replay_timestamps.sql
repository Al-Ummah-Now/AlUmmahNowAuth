-- Match webhook_dlq's existing epoch-millisecond timestamps.
ALTER TABLE webhook_dlq ADD COLUMN replayed_at INTEGER;
ALTER TABLE webhook_dlq ADD COLUMN replaying_started_at INTEGER;
