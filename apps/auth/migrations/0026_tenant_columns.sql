-- Migration number: 0026
-- Add tenant_id columns to existing tables for multi-tenant data isolation
-- Note: SQLite doesn't enforce foreign keys by default, so we omit REFERENCES constraints
-- when adding columns with default values to avoid SQLITE_ERROR

-- Users
ALTER TABLE user ADD COLUMN tenant_id TEXT DEFAULT 'tenant_default';
CREATE INDEX IF NOT EXISTS idx_user_tenant ON user(tenant_id);

-- OAuth Clients
ALTER TABLE oauth_clients ADD COLUMN tenant_id TEXT DEFAULT 'tenant_default';
CREATE INDEX IF NOT EXISTS idx_oauth_clients_tenant ON oauth_clients(tenant_id);

-- Roles (tenant-specific roles vs system roles)
ALTER TABLE roles ADD COLUMN tenant_id TEXT;
CREATE INDEX IF NOT EXISTS idx_roles_tenant ON roles(tenant_id);

-- Audit Events
ALTER TABLE audit_events ADD COLUMN tenant_id TEXT DEFAULT 'tenant_default';
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant ON audit_events(tenant_id);

-- Update existing data to use default tenant
UPDATE user SET tenant_id = 'tenant_default' WHERE tenant_id IS NULL;
UPDATE oauth_clients SET tenant_id = 'tenant_default' WHERE tenant_id IS NULL;
UPDATE audit_events SET tenant_id = 'tenant_default' WHERE tenant_id IS NULL;

-- Mark existing roles as system roles (available to all tenants)
-- System roles have tenant_id = NULL and is_system = 1
