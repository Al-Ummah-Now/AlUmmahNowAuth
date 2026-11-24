-- Migration: 0052_audit_daily_counts_and_user_index
-- Issue: AlUmmahNowAuth#514 (AUN-D1-SCALING story D1-4)
--
-- Removes full-table COUNT(*) and unindexed ORDER BY scans on audit_events
-- from GET /admin/audit-logs/stats and GET /admin/audit-logs/user/:userId.
--
-- 1. audit_daily_counts (day, event_type, severity, n) serves 7-day and 90-day
--    total counts. audit_hourly_counts (hour, event_type, severity, n) holds a
--    48-hour rolling window (pruned hourly) for 1-hour and 24-hour stats so
--    getAuditStats never scans audit_events.
-- 2. idx_audit_events_user_timestamp(user_id, timestamp, id) replaces
--    idx_audit_events_user_id(user_id) for lossless keyset paging without a
--    temp B-tree sort. Because user_id is the leading prefix, this also serves
--    every WHERE user_id = ? lookup (including rollback) and fixes the
--    audit-consumer duplicate check that previously scanned every user_id IS NULL
--    row on each no-user insert. On Cloudflare D1, CREATE INDEX builds the
--    B-tree in a single transaction; stage deploy timing is observed before
--    production promotion.
-- 3. AFTER INSERT trigger keeps both count tables updated atomically on every
--    inserted audit_events row (including audit-consumer's idempotent WHERE NOT
--    EXISTS inserts and D1Sink). Duplicate queue replays insert 0 rows and do
--    not fire the trigger.
-- 4. Backfill cursor in auth_settings records the pre-migration watermark
--    (single rightmost B-tree seeks for MAX(rowid) and MAX(timestamp)) so the
--    bounded cron backfill folds historical rows by indexed timestamp range
--    without double-counting rows inserted after this migration.

CREATE TABLE IF NOT EXISTS audit_daily_counts (
  day TEXT NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event_type, severity)
);

CREATE TABLE IF NOT EXISTS audit_hourly_counts (
  hour TEXT NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, event_type, severity)
);

CREATE INDEX IF NOT EXISTS idx_audit_events_user_timestamp
  ON audit_events(user_id, timestamp, id);

DROP INDEX IF EXISTS idx_audit_events_user_id;

CREATE TRIGGER IF NOT EXISTS audit_events_counts_insert
AFTER INSERT ON audit_events
BEGIN
  INSERT INTO audit_daily_counts (day, event_type, severity, n)
  VALUES (substr(NEW.timestamp, 1, 10), NEW.event_type, NEW.severity, 1)
  ON CONFLICT(day, event_type, severity) DO UPDATE SET n = n + 1;
  INSERT INTO audit_hourly_counts (hour, event_type, severity, n)
  VALUES (replace(substr(NEW.timestamp, 1, 13), ' ', 'T'), NEW.event_type, NEW.severity, 1)
  ON CONFLICT(hour, event_type, severity) DO UPDATE SET n = n + 1;
END;

INSERT OR IGNORE INTO auth_settings (key, value, updated_at, updated_by)
VALUES (
  'audit_daily_counts_backfill',
  json_object(
    'cutoff_rowid', COALESCE((SELECT MAX(rowid) FROM audit_events), 0),
    'cutoff_ts', COALESCE((SELECT MAX(timestamp) FROM audit_events), ''),
    'cursor_ts', '',
    'cursor_rowid', 0,
    'done', CASE WHEN COALESCE((SELECT MAX(rowid) FROM audit_events), 0) = 0 THEN 1 ELSE 0 END
  ),
  unixepoch() * 1000,
  'migration:0052'
);
