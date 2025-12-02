-- Migration: 0023_browser_sessions
-- Description: Create browser_sessions and account_sessions tables for multi-account support
-- This enables up to 3 accounts to be logged in simultaneously per browser/device

-- Browser Sessions: One per browser/device
CREATE TABLE IF NOT EXISTS browser_sessions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT DEFAULT 'default',
    session_token_hash TEXT NOT NULL UNIQUE,
    user_agent TEXT,
    ip_address TEXT,
    device_type TEXT, -- 'desktop', 'mobile', 'tablet', 'unknown'
    device_name TEXT, -- Parsed from UA: 'Chrome on Windows'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_activity TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    is_revoked INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_browser_sessions_token ON browser_sessions(session_token_hash);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_tenant ON browser_sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_expires ON browser_sessions(expires_at);

-- Account Sessions: Multiple accounts per browser session
CREATE TABLE IF NOT EXISTS account_sessions (
    id TEXT PRIMARY KEY,
    browser_session_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    is_active INTEGER DEFAULT 0, -- Only one active per browser session
    authenticated_at TEXT NOT NULL DEFAULT (datetime('now')),
    auth_method TEXT DEFAULT 'email', -- 'email', 'google', 'mfa', 'password'
    last_used TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    is_revoked INTEGER DEFAULT 0,
    FOREIGN KEY (browser_session_id) REFERENCES browser_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_sessions_browser ON account_sessions(browser_session_id);
CREATE INDEX IF NOT EXISTS idx_account_sessions_user ON account_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_account_sessions_active ON account_sessions(browser_session_id, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_sessions_unique_user ON account_sessions(browser_session_id, user_id);

-- Note: Max 3 accounts per browser session is enforced in application layer
-- Note: Only 1 active account per browser session is enforced via trigger in next migration
