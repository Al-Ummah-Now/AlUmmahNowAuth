-- Migration: 0025_app_tokens
-- Description: Create app-specific tokens tracking and client permissions tables
-- This enables audience-specific tokens where each app receives its own access token
-- with appropriate audience and permissions.

-- App-specific tokens tracking
CREATE TABLE IF NOT EXISTS app_tokens (
    id TEXT PRIMARY KEY,
    account_session_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    access_token_hash TEXT NOT NULL UNIQUE,
    scope TEXT,
    audience TEXT NOT NULL,
    issued_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    is_revoked INTEGER DEFAULT 0,
    revoked_at TEXT,
    revoke_reason TEXT,
    FOREIGN KEY (account_session_id) REFERENCES account_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES oauth_clients(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_app_tokens_session ON app_tokens(account_session_id);
CREATE INDEX IF NOT EXISTS idx_app_tokens_client ON app_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_app_tokens_hash ON app_tokens(access_token_hash);
CREATE INDEX IF NOT EXISTS idx_app_tokens_expires ON app_tokens(expires_at);
-- Composite index for introspection queries (hash + revocation check)
CREATE INDEX IF NOT EXISTS idx_app_tokens_introspection ON app_tokens(access_token_hash, is_revoked);

-- Client-specific permissions mapping
-- This defines which permissions are granted to which OAuth clients
-- Used to compute effective permissions as intersection of user roles and client grants
CREATE TABLE IF NOT EXISTS client_permissions (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    permission_id TEXT NOT NULL,
    granted_at TEXT NOT NULL DEFAULT (datetime('now')),
    granted_by TEXT, -- User ID of admin who granted the permission
    FOREIGN KEY (client_id) REFERENCES oauth_clients(id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE,
    UNIQUE(client_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_client_permissions_client ON client_permissions(client_id);
CREATE INDEX IF NOT EXISTS idx_client_permissions_permission ON client_permissions(permission_id);
