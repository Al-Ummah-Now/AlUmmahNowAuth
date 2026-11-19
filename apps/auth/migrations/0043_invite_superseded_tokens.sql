-- Migration: 0043_invite_superseded_tokens
-- The links an invite used to have. A resend or "Copy link" replaces user_invites.token_hash, so
-- an older invite email's link used to match nothing and showed the neutral "This link doesn't
-- work" page. Keeping the replaced hash lets that link find its invite: while the invite is open
-- it offers "Email me a new link" (to the invited inbox only); a withdrawn invite stays neutral.
-- reason: 'email' (a newer invite email replaced it: admin resend or the invitee's own request)
-- or 'link' (an admin's "Copy link"), so the page names what really happened.
-- Only SHA-256 hashes are kept, never a token. Lookups are by primary key; the rows go with the
-- invite (purge) and with the account (account deletion, by user_id).
CREATE TABLE IF NOT EXISTS user_invite_superseded_tokens (
  token_hash TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'email',
  superseded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invite_superseded_tokens_invite ON user_invite_superseded_tokens(invite_id);
CREATE INDEX IF NOT EXISTS idx_invite_superseded_tokens_user ON user_invite_superseded_tokens(user_id);
