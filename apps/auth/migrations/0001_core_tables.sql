-- Migration: 0001_core_tables
-- Description: Core application tables (runs AFTER OpenAuth migrations)
-- OpenAuth provides: oauth_clients, tenants, browser_sessions, account_sessions, rbac_* tables

PRAGMA foreign_keys = ON;

-- Note: User table is created by OpenAuth (users table)
-- Note: OAuth clients are managed by OpenAuth via oauth_clients table
-- The legacy 'clients' table has been removed - use OpenAuth's client management APIs

-- Logs table for general application logging
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    service TEXT DEFAULT 'AUTH',
    message TEXT NOT NULL,
    context TEXT,
    timestamp INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);

-- Audit events table for security and compliance logging
-- Schema matches app code expectations (audit-emitter.ts)
CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    timestamp TEXT NOT NULL,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    user_id TEXT,
    ip_address TEXT,
    user_agent TEXT,
    request_id TEXT,
    metadata TEXT,
    success INTEGER NOT NULL DEFAULT 1,
    error_message TEXT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_id ON audit_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_user_id ON audit_events(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_event_type ON audit_events(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_events_severity ON audit_events(severity);

-- Webhook dead letter queue for failed webhook deliveries
CREATE TABLE IF NOT EXISTS webhook_dlq (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL DEFAULT 'default',
    webhook_url TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    next_retry_at INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webhook_dlq_tenant_id ON webhook_dlq(tenant_id);
CREATE INDEX IF NOT EXISTS idx_webhook_dlq_status ON webhook_dlq(status);
CREATE INDEX IF NOT EXISTS idx_webhook_dlq_next_retry ON webhook_dlq(next_retry_at);
