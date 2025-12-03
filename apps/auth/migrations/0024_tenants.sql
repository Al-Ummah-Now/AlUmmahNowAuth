-- Migration number: 0023
-- Tenants table for multi-tenant support

CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    domain TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'deleted')),

    -- Branding
    logo_url TEXT,
    favicon_url TEXT,
    primary_color TEXT DEFAULT '#1976d2',
    secondary_color TEXT DEFAULT '#424242',
    background_color TEXT DEFAULT '#ffffff',
    font_family TEXT DEFAULT 'Inter, sans-serif',

    -- Email templates
    email_from_name TEXT,
    email_from_address TEXT,
    email_reply_to TEXT,

    -- Settings (JSON)
    settings TEXT DEFAULT '{}',

    -- Metadata
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT,

    -- Limits
    max_users INTEGER DEFAULT 1000,
    max_clients INTEGER DEFAULT 10,
    max_sessions_per_user INTEGER DEFAULT 10
);

CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);
CREATE INDEX IF NOT EXISTS idx_tenants_domain ON tenants(domain);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);

-- Insert default tenant
INSERT INTO tenants (id, name, slug, domain, email_from_name, email_from_address)
VALUES (
    'tenant_default',
    'AlUmmahNow',
    'alummahnow',
    'auth.alummahnow.net',
    'AlUmmahNow',
    'noreply@alummahnow.net'
);
