-- Migration: 0027_admin_deletions
-- Admin deletes are soft deletes (owner rule, 2026-11-10): the item is hidden
-- everywhere and restorable, and the hourly cleanup (cron/token-cron.ts →
-- deletions/purge.ts) removes it for good 30 days later, or on its next run
-- once an admin has asked for permanent deletion (purge_requested_at). The
-- cleanup is the only code that hard-deletes users, OAuth clients, roles and
-- themes.
--
-- One row per deleted item:
--   kind          'user' | 'client' | 'role' | 'theme'
--   item_id       the item's id in its own table (users.id, oauth_clients.id, ...)
--   label         what the "Recently deleted" view shows (email, client or theme name)
--   deleted_at    ms; the 30-day clock
--   deleted_by    acting admin user id ('self' for a user's own account deletion)
--   snapshot      JSON the restore needs (status before deletion, a client's
--                 enabled flag, a role's user and permission links)
--   attempts, last_error: failed cleanup runs (retried on the next run)
--
-- Additive only: code from before this migration never reads the table.
CREATE TABLE IF NOT EXISTS admin_deletions (
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  label TEXT,
  deleted_at INTEGER NOT NULL,
  deleted_by TEXT NOT NULL,
  deleted_by_email TEXT,
  reason TEXT,
  purge_requested_at INTEGER,
  purge_requested_by TEXT,
  snapshot TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (kind, item_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_deletions_deleted_at ON admin_deletions(deleted_at);
CREATE INDEX IF NOT EXISTS idx_admin_deletions_purge ON admin_deletions(purge_requested_at);

-- Users deleted before this migration (users.deleted_at set) join the same
-- cleanup. Their 30 days start now, so each one shows in "Recently deleted"
-- for 30 days before anything is removed.
INSERT OR IGNORE INTO admin_deletions (kind, item_id, tenant_id, label, deleted_at, deleted_by, reason, snapshot)
SELECT 'user', id, tenant_id, email, CAST(unixepoch() AS INTEGER) * 1000, 'unknown', 'Deleted before soft delete existed', '{"status":"active"}'
FROM users
WHERE deleted_at IS NOT NULL;
