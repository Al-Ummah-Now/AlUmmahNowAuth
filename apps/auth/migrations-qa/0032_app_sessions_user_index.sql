-- D1 cost (rows read): an account purge signed the user out of profile/admin with
-- `DELETE FROM app_sessions WHERE instr(user_json, ?) > 0`, a scan of every app
-- session (~3.2k rows on QA, 6.7k purges a day from E2E run accounts = 21M rows
-- read a day). The user id is the `id` of user_json; this index serves the
-- delete in deletions/kinds.ts, which now matches exactly this expression.
CREATE INDEX IF NOT EXISTS idx_app_sessions_user ON app_sessions(json_extract(user_json, '$.id'));
