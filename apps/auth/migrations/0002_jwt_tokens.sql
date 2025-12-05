-- Migration: 0002_jwt_tokens
-- Description: JWT infrastructure and token management tables

PRAGMA foreign_keys = ON;

-- JWT keys table for storing signing keys
CREATE TABLE IF NOT EXISTS jwt_keys (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL DEFAULT 'default',
    algorithm TEXT NOT NULL DEFAULT 'RS256',
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    kid TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    expires_at INTEGER,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_jwt_keys_tenant_id ON jwt_keys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_jwt_keys_kid ON jwt_keys(kid);
CREATE INDEX IF NOT EXISTS idx_jwt_keys_active ON jwt_keys(is_active);

-- Refresh tokens table
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    token_hash TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    scope TEXT,
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_client_id ON refresh_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_tenant_id ON refresh_tokens(tenant_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);

-- Token usage tracking for rate limiting and analytics
CREATE TABLE IF NOT EXISTS token_usage (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL DEFAULT 'default',
    client_id TEXT NOT NULL,
    user_id TEXT,
    token_type TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_token_usage_tenant_id ON token_usage(tenant_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_client_id ON token_usage(client_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_user_id ON token_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage(created_at);

-- Authorization codes for OAuth flow
CREATE TABLE IF NOT EXISTS authorization_codes (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    code_hash TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    redirect_uri TEXT NOT NULL,
    scope TEXT,
    code_challenge TEXT,
    code_challenge_method TEXT,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    used_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_authorization_codes_code_hash ON authorization_codes(code_hash);
CREATE INDEX IF NOT EXISTS idx_authorization_codes_user_id ON authorization_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_authorization_codes_client_id ON authorization_codes(client_id);
CREATE INDEX IF NOT EXISTS idx_authorization_codes_expires ON authorization_codes(expires_at);
