-- Migration: 0003_app_extensions
-- Description: App-specific extensions for tenant management and RBAC compatibility

PRAGMA foreign_keys = ON;

-- ============================================================================
-- RBAC Compatibility Views
-- Maps app's expected table names to OpenAuth's rbac_* tables
-- ============================================================================

-- View: user_roles -> rbac_user_roles
-- App expects: id, user_id, role_id, granted_by, granted_at, expires_at, is_active
-- OpenAuth has: user_id, role_id, tenant_id, assigned_at, expires_at, assigned_by
CREATE VIEW IF NOT EXISTS user_roles AS
SELECT
    user_id || '_' || role_id || '_' || tenant_id AS id,
    user_id,
    role_id,
    assigned_by AS granted_by,
    assigned_at AS granted_at,
    expires_at,
    CASE WHEN expires_at IS NULL OR expires_at > (unixepoch() * 1000) THEN 1 ELSE 0 END AS is_active,
    tenant_id
FROM rbac_user_roles;

-- View: roles -> rbac_roles
-- App expects: id, name, description, created_at, updated_at, is_system, tenant_id
-- OpenAuth has: id, name, tenant_id, description, is_system_role, created_at, updated_at
CREATE VIEW IF NOT EXISTS roles AS
SELECT
    id,
    name,
    description,
    is_system_role AS is_system,
    tenant_id,
    created_at,
    updated_at
FROM rbac_roles;

-- View: permissions -> rbac_permissions
-- App expects: id, name, description, resource, action, scope, created_at, updated_at
-- OpenAuth has: id, name, app_id, description, resource, action, scope, created_at, updated_at
CREATE VIEW IF NOT EXISTS permissions AS
SELECT
    id,
    name,
    description,
    resource,
    action,
    scope,
    app_id,
    created_at,
    updated_at
FROM rbac_permissions;

-- View: role_permissions -> rbac_role_permissions
CREATE VIEW IF NOT EXISTS role_permissions AS
SELECT
    role_id,
    permission_id,
    assigned_at AS created_at
FROM rbac_role_permissions;

-- ============================================================================
-- INSTEAD OF Triggers for user_roles view (to handle INSERT/UPDATE/DELETE)
-- ============================================================================

-- Trigger: INSERT into user_roles -> rbac_user_roles
CREATE TRIGGER IF NOT EXISTS user_roles_insert
INSTEAD OF INSERT ON user_roles
BEGIN
    INSERT INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, expires_at, assigned_by)
    VALUES (
        NEW.user_id,
        NEW.role_id,
        COALESCE(NEW.tenant_id, 'default'),
        COALESCE(NEW.granted_at, unixepoch() * 1000),
        NEW.expires_at,
        COALESCE(NEW.granted_by, 'system')
    );
END;

-- Trigger: DELETE from user_roles -> rbac_user_roles
CREATE TRIGGER IF NOT EXISTS user_roles_delete
INSTEAD OF DELETE ON user_roles
BEGIN
    DELETE FROM rbac_user_roles
    WHERE user_id = OLD.user_id AND role_id = OLD.role_id;
END;

-- Trigger: UPDATE user_roles -> rbac_user_roles
CREATE TRIGGER IF NOT EXISTS user_roles_update
INSTEAD OF UPDATE ON user_roles
BEGIN
    UPDATE rbac_user_roles
    SET expires_at = NEW.expires_at,
        assigned_by = NEW.granted_by
    WHERE user_id = OLD.user_id AND role_id = OLD.role_id;
END;

-- ============================================================================
-- Tenant Management Tables
-- ============================================================================

-- Tenant admins table for managing admin users per tenant
CREATE TABLE IF NOT EXISTS tenant_admins (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    permissions TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
    UNIQUE(tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_admins_tenant_id ON tenant_admins(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_admins_user_id ON tenant_admins(user_id);

-- Tenant invitations for inviting new admins
CREATE TABLE IF NOT EXISTS tenant_invitations (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    invited_by TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    expires_at INTEGER NOT NULL,
    accepted_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by) REFERENCES user(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_invitations_tenant_id ON tenant_invitations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_invitations_email ON tenant_invitations(email);
CREATE INDEX IF NOT EXISTS idx_tenant_invitations_token_hash ON tenant_invitations(token_hash);
CREATE INDEX IF NOT EXISTS idx_tenant_invitations_expires ON tenant_invitations(expires_at);

-- App tokens for service-to-service authentication
CREATE TABLE IF NOT EXISTS app_tokens (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    permissions TEXT,
    last_used_at INTEGER,
    expires_at INTEGER,
    revoked INTEGER NOT NULL DEFAULT 0,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_app_tokens_tenant_id ON app_tokens(tenant_id);
CREATE INDEX IF NOT EXISTS idx_app_tokens_token_hash ON app_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_app_tokens_expires ON app_tokens(expires_at);
