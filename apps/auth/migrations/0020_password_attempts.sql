-- Migration: 0020_password_attempts
-- AU-2 (scalability/security audit): attempt limits for the 6-digit email code
-- and for password sign-in, kept in D1 because counters must be strongly
-- consistent (KV has no atomic increment and lags ~60 s between PoPs).
--
-- password_codes: the latest confirmation code sent to an email (register or
-- password reset), hashed. Each submitted code increments `attempts` with one
-- conditional UPDATE (attempts < 5, not expired); the row also caps all code
-- guesses for the email per hour across resends (window_*).
-- password_login_attempts: password sign-in failures per email in a 15-minute
-- window; a sign-in reserves a slot before the password is checked and gives it
-- back when it succeeds.
-- Times are unix seconds. Additive only (expand-only migration).

CREATE TABLE IF NOT EXISTS password_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL DEFAULT 0,
  window_attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS password_login_attempts (
  email TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0
);
