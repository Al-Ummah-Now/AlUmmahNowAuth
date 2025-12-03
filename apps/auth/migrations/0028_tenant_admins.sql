-- Migration number: 0025
-- Tenant administrators and invitations

-- Tenant administrators
CREATE TABLE IF NOT EXISTS tenant_admins (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('owner', 'admin', 'viewer')),
    granted_at TEXT NOT NULL DEFAULT (datetime('now')),
    granted_by TEXT,
    UNIQUE(tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_admins_tenant ON tenant_admins(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_admins_user ON tenant_admins(user_id);

-- Tenant invitations
CREATE TABLE IF NOT EXISTS tenant_invitations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('owner', 'admin', 'viewer')),
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_tenant_invitations_tenant ON tenant_invitations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_invitations_token ON tenant_invitations(token_hash);
