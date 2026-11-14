-- System accounts (src/security/system-accounts.ts; openauth user/system.ts).
--
-- user_system (system@openauth.local) only labels automatic actions: it is the
-- assigned_by of the Member role every new account gets. openauth's seed made
-- it a Super Admin; it needs no role at all, and must never sign in.
--
-- 1. Its role rows go. The user row and its id stay: rbac_user_roles.assigned_by
--    of existing rows still names it.
-- 2. Its metadata says what it is (the seed already writes this; kept for
--    databases seeded before that).
-- 3. A system account can never be given a role again, by any code path: an
--    insert, or an update that moves a row onto one, is aborted. Primary-key
--    lookups only.

DELETE FROM rbac_user_roles WHERE user_id = 'user_system';

UPDATE users
SET metadata = json_set(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.type', 'system'),
    updated_at = unixepoch() * 1000
WHERE id = 'user_system'
  AND (metadata IS NULL OR NOT json_valid(metadata) OR json_extract(metadata, '$.type') IS NOT 'system');

CREATE TRIGGER IF NOT EXISTS rbac_user_roles_no_system_accounts_insert
BEFORE INSERT ON rbac_user_roles
WHEN NEW.user_id = 'user_system'
  OR EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND json_valid(metadata) AND json_extract(metadata, '$.type') = 'system')
BEGIN
  SELECT RAISE(ABORT, 'system_account_role_refused');
END;

CREATE TRIGGER IF NOT EXISTS rbac_user_roles_no_system_accounts_update
BEFORE UPDATE OF user_id ON rbac_user_roles
WHEN NEW.user_id = 'user_system'
  OR EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND json_valid(metadata) AND json_extract(metadata, '$.type') = 'system')
BEGIN
  SELECT RAISE(ABORT, 'system_account_role_refused');
END;
