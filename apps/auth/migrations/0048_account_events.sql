-- Migration: 0048_account_events
-- Account events for subscribed apps (AlUmmahNowAuth#507, docs/account-hub/SPEC.md §5.4).
-- An event is recorded in the same batch as the change that causes it, with one delivery per
-- subscribed client. No email, name, date or age band is ever stored here. user_id has no
-- foreign key: the account-purged row must outlive the user it names. '' is an event about no
-- user (verification).
CREATE TABLE IF NOT EXISTS account_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  reason TEXT,
  export_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_event_deliveries (
  jti TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  next_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);

-- Pending rows whose queue message may be lost, oldest first (cron)
CREATE INDEX IF NOT EXISTS idx_account_event_deliveries_due ON account_event_deliveries(next_at) WHERE status = 'pending';
-- A client's events about one user in order; a client's last verification (user_id '')
CREATE INDEX IF NOT EXISTS idx_account_event_deliveries_order ON account_event_deliveries(client_id, user_id, seq);
-- Failed rows per client, newest first (admin), and delivered rows past their 30 days (cron)
CREATE INDEX IF NOT EXISTS idx_account_event_deliveries_settled ON account_event_deliveries(status, settled_at);
-- Deliveries of an event (clean-up of events with none left)
CREATE INDEX IF NOT EXISTS idx_account_event_deliveries_seq ON account_event_deliveries(seq);
-- Events old enough for the clean-up
CREATE INDEX IF NOT EXISTS idx_account_events_created ON account_events(created_at);
-- The clients that subscribe: a handful, without reading the others
CREATE INDEX IF NOT EXISTS idx_oauth_clients_events ON oauth_clients(id) WHERE instr(metadata, '"events"') > 0;
