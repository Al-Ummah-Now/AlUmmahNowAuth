-- Create authorization_codes table for OAuth 2.0 authorization code flow
-- Stores authorization codes with PKCE support and expiration

CREATE TABLE IF NOT EXISTS authorization_codes (
  -- Primary key
  code_hash TEXT PRIMARY KEY,

  -- OAuth 2.0 parameters
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',

  -- PKCE parameters (RFC 7636)
  code_challenge TEXT,
  code_challenge_method TEXT CHECK(code_challenge_method IN ('S256', 'plain')),

  -- OIDC parameters
  nonce TEXT,

  -- Lifecycle timestamps
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  used_at DATETIME,

  -- Foreign key constraints
  FOREIGN KEY (client_id) REFERENCES oauth_clients(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);

-- Index for cleanup of expired codes
CREATE INDEX IF NOT EXISTS idx_authorization_codes_expires_at
  ON authorization_codes(expires_at);

-- Index for user lookups
CREATE INDEX IF NOT EXISTS idx_authorization_codes_user_id
  ON authorization_codes(user_id);

-- Index for client lookups
CREATE INDEX IF NOT EXISTS idx_authorization_codes_client_id
  ON authorization_codes(client_id);
