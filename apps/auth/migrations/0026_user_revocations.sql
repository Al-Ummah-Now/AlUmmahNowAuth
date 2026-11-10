-- Migration: 0026_user_revocations
-- AU-4 (scalability audit): "sign out everywhere", password changes and admin
-- suspend/delete took up to about 60 s per location to stop refreshes, because
-- the auth worker read the revocation entry from KV (eventually consistent,
-- with misses cached at the edge). The refresh path now reads this table,
-- which every location sees current. KV keeps the same entry for the resource
-- servers (api-videos, admin-api, websocket), which only check short-lived
-- access tokens.
--
-- revoked_before: unix seconds; every sign-in made before it is dead. Written
-- only as MAX(existing, new) in one upsert, so a revocation can never be
-- shortened, even by concurrent writers.
CREATE TABLE IF NOT EXISTS user_revocations (
  user_id TEXT PRIMARY KEY,
  revoked_before INTEGER NOT NULL,
  reason TEXT,
  updated_at INTEGER NOT NULL
);
