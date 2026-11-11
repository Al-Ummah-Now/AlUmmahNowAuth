-- Sign-in latency (AlUmmahNow#804): D1 runs one query at a time per database, so
-- a full-table scan delays every sign-in query queued behind it. On QA (46k users,
-- 48k refresh tokens) these scans kept D1 busy for up to 27 s a minute and
-- password sign-ins waited more than 15 s.

-- Email lookups by lower(email): account purge, run-account delete, forgot-password
-- (`WHERE lower(email) = ?` / `= lower(?)`). idx_users_email (email) cannot serve them.
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(email));

-- A purged account's OpenAuth refresh tokens (deletions/kinds.ts): the key holds a
-- hash of the subject, so the user id is only in the value. Was a scan of every
-- refresh token (~160 ms per purge on QA).
CREATE INDEX IF NOT EXISTS idx_openauth_atomic_refresh_user
  ON openauth_atomic(json_extract(value, '$.properties.id'))
  WHERE key >= 'oauth:refresh' AND key < 'oauth:refresi';
