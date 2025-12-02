-- Migration number: 0012
-- Description: Create JWT infrastructure tables for access tokens and refresh token rotation
-- Date: 2025-01-18T00:00:00.000Z

-- JWT Keys table for storing RS256 signing keys
CREATE TABLE IF NOT EXISTS jwt_keys (
  kid TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  private_key_encrypted TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'RS256',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expiring', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Index for efficient lookup of active keys
CREATE INDEX IF NOT EXISTS idx_jwt_keys_status_expires ON jwt_keys(status, expires_at);

-- Refresh Tokens table for storing refresh tokens with rotation support
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  token_hash TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  ip_address TEXT,
  user_agent TEXT,
  revoked INTEGER DEFAULT 0,  -- Using INTEGER for boolean (0/1)
  revoked_at INTEGER,
  revoked_reason TEXT,
  parent_token_id TEXT,
  rotation_count INTEGER DEFAULT 0,
  scope TEXT DEFAULT 'openid email profile',
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);

-- Indexes for refresh tokens
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_client_id ON refresh_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_revoked ON refresh_tokens(user_id, revoked);

-- Token usage analytics table for audit trail
CREATE TABLE IF NOT EXISTS token_usage (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  token_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('generated', 'refreshed', 'revoked', 'expired')),
  timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
  ip_address TEXT,
  user_agent TEXT,
  metadata TEXT, -- JSON string for additional data
  FOREIGN KEY (token_id) REFERENCES refresh_tokens(id) ON DELETE CASCADE
);

-- Indexes for token usage analytics
CREATE INDEX IF NOT EXISTS idx_token_usage_token_id ON token_usage(token_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp_action ON token_usage(timestamp, action);
