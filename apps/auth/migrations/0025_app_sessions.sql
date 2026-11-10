-- Migration: 0025_app_sessions
-- PF-1, PF-2, AD-1 (scalability audit): sessions of our own server-side apps
-- (profile, admin) move from KV to D1.
--
-- The issuer rotates the refresh token on every use and treats a reuse more
-- than 60 s later as theft (it then revokes every refresh token of the user).
-- With the session in KV, a request in another location could read the
-- previous refresh token for about as long, so concurrent tabs could sign the
-- user out everywhere. In D1 every read is current, and a refresh is
-- serialized per session: a request takes `refresh_lock` with one conditional
-- UPDATE (only while the lock is free and the refresh token is unchanged), and
-- the rotated tokens are saved only by the lock holder. Logout sets
-- `revoked_at`, which every location sees at once.
--
-- id: SHA-256 (hex) of the session cookie value, so the table never holds a
-- usable cookie. Times are milliseconds since the epoch. Expired rows are
-- purged by the auth Worker's hourly cron.
CREATE TABLE IF NOT EXISTS app_sessions (
  id TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  user_json TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  refresh_lock TEXT,
  refresh_lock_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_sessions_expires ON app_sessions(expires_at);
