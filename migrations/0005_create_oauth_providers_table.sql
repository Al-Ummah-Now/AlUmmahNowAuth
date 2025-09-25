-- Migration number: 0005 	 2025-01-25T12:00:00.000Z
-- Create OAuth providers configuration table
CREATE TABLE IF NOT EXISTS oauth_providers (
    id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
    provider_name TEXT UNIQUE NOT NULL, -- 'google', 'facebook', etc.
    enabled BOOLEAN NOT NULL DEFAULT 0,
    client_id TEXT,
    client_secret TEXT,  
    scopes TEXT, -- JSON array of scopes as string
    config TEXT, -- Additional provider-specific configuration as JSON
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Insert default provider configurations (disabled by default)
INSERT OR IGNORE INTO oauth_providers (provider_name, enabled, scopes, config) VALUES 
('google', 0, '["openid", "email", "profile"]', '{"pkce": true}'),
('facebook', 0, '["email", "public_profile"]', '{"pkce": true}');