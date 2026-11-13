-- Migration: 0038_webauthn_credentials
-- Description: Passkeys (AUTH-PASSKEYS, AlUmmahNowWiki). Every query is by key
-- (credential id, user id, token hash, setting key): never a scan of Auth D1.

-- One row per passkey. id = WebAuthn credential id (base64url).
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  device_type TEXT NOT NULL,
  backed_up INTEGER NOT NULL DEFAULT 0,
  aaguid TEXT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webauthn_credentials_id ON webauthn_credentials(id);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials(user_id);

-- "Not now" on the after-sign-in card (PK1: at most once every 30 days)
CREATE TABLE IF NOT EXISTS webauthn_prompts (
  user_id TEXT PRIMARY KEY,
  dismissed_at INTEGER NOT NULL
);

-- One-time passkey setup links an admin sends (PK4 staff recovery)
CREATE TABLE IF NOT EXISTS passkey_setup_tickets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_passkey_setup_tickets_user ON passkey_setup_tickets(user_id);

-- Admin-managed settings (staff_passkeys: { enforced, enforcedAt, graceDays })
CREATE TABLE IF NOT EXISTS auth_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
