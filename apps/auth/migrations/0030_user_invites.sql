-- Migration: 0030_user_invites
-- Admin invites (docs/USER_INVITES.md). Additive: a new table and one client scope; the users
-- table is unchanged (an invited account is a users row with status 'invited').
--
-- One row per invite. The account it pre-provisions (user_id) exists from the
-- moment the invite is made, so it can be searched for, linked and given
-- channels before the person first signs in.
--
-- token_hash: SHA-256 (hex) of the link's single-use token; the token itself is
-- never stored or logged. A resend or "copy link" replaces it.
--
-- Revoke is an admin soft delete (deleted_at/deleted_by/deleted_reason, the same
-- fields as admin_deletions): restorable for 30 days, then the hourly cleanup
-- purges the invite and its never-used account. purge_requested_at queues it for
-- the cleanup's next run instead.
CREATE TABLE IF NOT EXISTS user_invites (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT,
    locale TEXT NOT NULL DEFAULT 'en',
    note TEXT,
    client_id TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    continue_url TEXT,
    token_hash TEXT,
    token_used_at INTEGER,
    invited_by TEXT NOT NULL,
    invited_by_email TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_sent_at INTEGER,
    send_count INTEGER NOT NULL DEFAULT 0,
    accepted_at INTEGER,
    deleted_at INTEGER,
    deleted_by TEXT,
    deleted_by_email TEXT,
    deleted_reason TEXT,
    purge_requested_at INTEGER,
    purge_requested_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_invites_token ON user_invites(token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_invites_user ON user_invites(user_id);
CREATE INDEX IF NOT EXISTS idx_user_invites_email ON user_invites(tenant_id, email);
CREATE INDEX IF NOT EXISTS idx_user_invites_created ON user_invites(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_user_invites_deleted ON user_invites(deleted_at) WHERE deleted_at IS NOT NULL;

-- The videos admin's client (also used for moderation requests) may provision
-- invited accounts: POST /provisioning/invites needs the invites:provision scope.
UPDATE oauth_clients
SET scopes = json_insert(COALESCE(scopes, '[]'), '$[#]', 'invites:provision'), updated_at = unixepoch() * 1000
WHERE id = 'd7464de8-363d-4fc1-b1af-7c71653f0afc'
  AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(oauth_clients.scopes, '[]')) WHERE value = 'invites:provision');
