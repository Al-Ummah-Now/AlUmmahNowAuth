-- Migration: 0049_user_birth_dates
-- A person's date of birth (wiki E20 §5.1), encrypted with PROFILE_DATA_KEY. A table of its own, so no
-- user list, KV user record, webhook or export of users can carry it. Never a plain date here.
CREATE TABLE IF NOT EXISTS user_birth_dates (
  user_id TEXT PRIMARY KEY,
  birth_date_enc TEXT NOT NULL,
  key_id TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
