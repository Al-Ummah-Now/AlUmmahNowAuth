-- Migration number: 0011 	 2025-01-13T00:00:00.000Z
-- Create refresh tokens table for JWT token rotation

-- Create refresh tokens table
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

-- Create indexes for performance
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
CREATE INDEX idx_refresh_tokens_client_id ON refresh_tokens(client_id);
CREATE INDEX idx_refresh_tokens_parent_token_id ON refresh_tokens(parent_token_id);

-- Create token usage analytics table
CREATE TABLE IF NOT EXISTS token_usage (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    token_id TEXT NOT NULL,
    action TEXT NOT NULL, -- 'generated', 'refreshed', 'revoked', 'expired'
    timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
    ip_address TEXT,
    user_agent TEXT,
    metadata TEXT, -- JSON string for additional data
    FOREIGN KEY (token_id) REFERENCES refresh_tokens(id) ON DELETE CASCADE
);

-- Create indexes for token usage
CREATE INDEX idx_token_usage_token_id ON token_usage(token_id);
CREATE INDEX idx_token_usage_timestamp ON token_usage(timestamp);
CREATE INDEX idx_token_usage_action ON token_usage(action);

-- Create JWT keys table for key rotation management
CREATE TABLE IF NOT EXISTS jwt_keys (
    kid TEXT PRIMARY KEY,
    key_type TEXT NOT NULL DEFAULT 'RS256',
    public_key TEXT NOT NULL,
    private_key_encrypted TEXT NOT NULL, -- Store encrypted for additional security
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL,
    revoked INTEGER DEFAULT 0,
    revoked_at INTEGER,
    revoked_reason TEXT
);

-- Create indexes for JWT keys
CREATE INDEX idx_jwt_keys_expires_at ON jwt_keys(expires_at);
CREATE INDEX idx_jwt_keys_created_at ON jwt_keys(created_at);

-- Create token blacklist for emergency revocation
CREATE TABLE IF NOT EXISTS token_blacklist (
    jti TEXT PRIMARY KEY, -- JWT ID from access token
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    blacklisted_at INTEGER NOT NULL DEFAULT (unixepoch()),
    reason TEXT
);

-- Create index for blacklist cleanup
CREATE INDEX idx_token_blacklist_expires_at ON token_blacklist(expires_at);