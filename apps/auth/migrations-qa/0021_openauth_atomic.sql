-- Migration: 0021_openauth_atomic
-- Strongly consistent key/value store for the OpenAuth issuer's atomic
-- operations (StorageAdapter.atomic, @al-ummah-now/openauth >= 1.0.31): single-use
-- authorization codes and used-code markers, refresh-token family revocations,
-- and later device-flow state, refresh-token rotation and signing keys.
-- KV cannot do these: it has no compare-and-set and caches reads for ~60 s.
-- key: OpenAuth storage key joined with "::"; value: JSON; expires_at: epoch ms
-- (NULL = no expiry). Expired rows are invisible to reads and deleted hourly by
-- the token-cleanup cron.
CREATE TABLE IF NOT EXISTS openauth_atomic (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_openauth_atomic_expires_at ON openauth_atomic(expires_at);
