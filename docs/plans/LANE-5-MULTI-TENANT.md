# Lane 5: Multi-Tenant Infrastructure

## Overview
Implement multi-tenant architecture supporting complete data isolation, custom domains, white-label branding, and tenant-specific configuration. Enable SaaS deployment model.

## Priority: P2 (Medium - Future Phase)
**Dependencies**: Lane 1 (Browser Sessions - tenant_id field)
**Blocks**: None (independent feature set)

---

## Current State Analysis

### What Exists:
- Single-tenant architecture
- Default tenant concept (hardcoded)
- No tenant isolation
- No custom domain support
- No branding customization

### What's Missing:
- Tenant data model and CRUD
- Tenant isolation in all queries
- Custom domain routing
- Branding configuration
- Tenant-specific OAuth clients
- Tenant-specific roles
- Tenant admin delegation
- Tenant settings

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Request Flow                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Request → Domain Detection → Tenant Resolution → Context   │
│                                                              │
│  auth.alummahnow.net  →  tenant: "alummahnow" (default)     │
│  auth.clientcorp.com  →  tenant: "client-corp"              │
│  sso.example.org      →  tenant: "example-org"              │
│                                                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    Data Isolation                            │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  tenant: "alummahnow"          tenant: "client-corp"        │
│  ┌──────────────────┐          ┌──────────────────┐         │
│  │ Users            │          │ Users            │         │
│  │ OAuth Clients    │          │ OAuth Clients    │         │
│  │ Roles            │          │ Roles            │         │
│  │ Sessions         │          │ Sessions         │         │
│  │ Audit Events     │          │ Audit Events     │         │
│  └──────────────────┘          └──────────────────┘         │
│                                                              │
│  Complete isolation - no cross-tenant data access           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Database Schema Changes

### Migration: 0027_tenants.sql

```sql
-- Tenants table
CREATE TABLE tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    domain TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'active', -- 'active', 'suspended', 'deleted'

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

CREATE INDEX idx_tenants_slug ON tenants(slug);
CREATE INDEX idx_tenants_domain ON tenants(domain);
CREATE INDEX idx_tenants_status ON tenants(status);

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
```

### Migration: 0028_tenant_columns.sql

```sql
-- Add tenant_id to all relevant tables

-- Users
ALTER TABLE user ADD COLUMN tenant_id TEXT DEFAULT 'tenant_default' REFERENCES tenants(id);
CREATE INDEX idx_user_tenant ON user(tenant_id);

-- OAuth Clients
ALTER TABLE oauth_clients ADD COLUMN tenant_id TEXT DEFAULT 'tenant_default' REFERENCES tenants(id);
CREATE INDEX idx_oauth_clients_tenant ON oauth_clients(tenant_id);

-- Roles (tenant-specific roles vs system roles)
ALTER TABLE roles ADD COLUMN tenant_id TEXT REFERENCES tenants(id);
ALTER TABLE roles ADD COLUMN is_system_role INTEGER DEFAULT 0;
CREATE INDEX idx_roles_tenant ON roles(tenant_id);

-- Audit Events
ALTER TABLE audit_events ADD COLUMN tenant_id TEXT DEFAULT 'tenant_default' REFERENCES tenants(id);
CREATE INDEX idx_audit_events_tenant ON audit_events(tenant_id);

-- Update existing data
UPDATE user SET tenant_id = 'tenant_default' WHERE tenant_id IS NULL;
UPDATE oauth_clients SET tenant_id = 'tenant_default' WHERE tenant_id IS NULL;
UPDATE audit_events SET tenant_id = 'tenant_default' WHERE tenant_id IS NULL;

-- Mark existing roles as system roles
UPDATE roles SET is_system_role = 1 WHERE tenant_id IS NULL;
```

### Migration: 0029_tenant_admins.sql

```sql
-- Tenant administrators
CREATE TABLE tenant_admins (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'admin', -- 'owner', 'admin', 'viewer'
    granted_at TEXT NOT NULL DEFAULT (datetime('now')),
    granted_by TEXT,
    UNIQUE(tenant_id, user_id)
);

CREATE INDEX idx_tenant_admins_tenant ON tenant_admins(tenant_id);
CREATE INDEX idx_tenant_admins_user ON tenant_admins(user_id);

-- Tenant invitations
CREATE TABLE tenant_invitations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT
);

CREATE INDEX idx_tenant_invitations_tenant ON tenant_invitations(tenant_id);
CREATE INDEX idx_tenant_invitations_token ON tenant_invitations(token_hash);
```

---

## Types & Interfaces

### File: apps/auth/src/types/tenant.ts

```typescript
export interface Tenant {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  status: 'active' | 'suspended' | 'deleted';

  // Branding
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  backgroundColor: string;
  fontFamily: string;

  // Email
  emailFromName: string | null;
  emailFromAddress: string | null;
  emailReplyTo: string | null;

  // Settings
  settings: TenantSettings;

  // Metadata
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;

  // Limits
  maxUsers: number;
  maxClients: number;
  maxSessionsPerUser: number;
}

export interface TenantSettings {
  // Authentication
  allowPasswordAuth?: boolean;
  allowSocialAuth?: boolean;
  allowEmailAuth?: boolean;
  requireMfa?: boolean;
  mfaMethods?: ('totp' | 'sms' | 'email')[];

  // Session
  sessionLifetimeDays?: number;
  maxAccountsPerBrowser?: number;

  // Security
  passwordPolicy?: {
    minLength: number;
    requireUppercase: boolean;
    requireNumbers: boolean;
    requireSymbols: boolean;
  };

  // Features
  features?: {
    multiAccountSessions: boolean;
    sso: boolean;
    auditLogs: boolean;
  };
}

export interface TenantBranding {
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  backgroundColor: string;
  fontFamily: string;
  customCss?: string;
}

export interface TenantAdmin {
  id: string;
  tenantId: string;
  userId: string;
  role: 'owner' | 'admin' | 'viewer';
  grantedAt: string;
  grantedBy: string | null;
  user?: {
    email: string;
    name?: string;
  };
}

export interface TenantContext {
  tenant: Tenant;
  branding: TenantBranding;
  isDefault: boolean;
}

export const DEFAULT_TENANT_ID = 'tenant_default';
```

---

## Tenant Service

### File: apps/auth/src/services/tenant.service.ts

```typescript
import { generateId } from '../utils/id';
import type { D1Database } from '@cloudflare/workers-types';
import type { Tenant, TenantSettings, TenantBranding, TenantAdmin, DEFAULT_TENANT_ID } from '../types/tenant';

export class TenantService {
  constructor(private db: D1Database) {}

  /**
   * Resolve tenant from domain
   */
  async resolveTenantByDomain(domain: string): Promise<Tenant | null> {
    const result = await this.db.prepare(`
      SELECT * FROM tenants WHERE domain = ? AND status = 'active'
    `).bind(domain).first();

    return result ? this.mapTenant(result) : null;
  }

  /**
   * Resolve tenant from slug
   */
  async resolveTenantBySlug(slug: string): Promise<Tenant | null> {
    const result = await this.db.prepare(`
      SELECT * FROM tenants WHERE slug = ? AND status = 'active'
    `).bind(slug).first();

    return result ? this.mapTenant(result) : null;
  }

  /**
   * Get tenant by ID
   */
  async getTenantById(id: string): Promise<Tenant | null> {
    const result = await this.db.prepare(`
      SELECT * FROM tenants WHERE id = ?
    `).bind(id).first();

    return result ? this.mapTenant(result) : null;
  }

  /**
   * Get default tenant
   */
  async getDefaultTenant(): Promise<Tenant> {
    const result = await this.db.prepare(`
      SELECT * FROM tenants WHERE id = ?
    `).bind(DEFAULT_TENANT_ID).first();

    if (!result) {
      throw new Error('Default tenant not found');
    }

    return this.mapTenant(result);
  }

  /**
   * Create a new tenant
   */
  async createTenant(params: {
    name: string;
    slug: string;
    domain?: string;
    createdBy?: string;
    settings?: Partial<TenantSettings>;
    branding?: Partial<TenantBranding>;
  }): Promise<Tenant> {
    const id = generateId('tenant');

    // Validate slug uniqueness
    const existing = await this.db.prepare(`
      SELECT id FROM tenants WHERE slug = ?
    `).bind(params.slug).first();

    if (existing) {
      throw new Error('Tenant slug already exists');
    }

    // Validate domain uniqueness if provided
    if (params.domain) {
      const existingDomain = await this.db.prepare(`
        SELECT id FROM tenants WHERE domain = ?
      `).bind(params.domain).first();

      if (existingDomain) {
        throw new Error('Domain already in use');
      }
    }

    await this.db.prepare(`
      INSERT INTO tenants (
        id, name, slug, domain, settings,
        logo_url, favicon_url, primary_color, secondary_color, background_color, font_family,
        created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      params.name,
      params.slug,
      params.domain || null,
      JSON.stringify(params.settings || {}),
      params.branding?.logoUrl || null,
      params.branding?.faviconUrl || null,
      params.branding?.primaryColor || '#1976d2',
      params.branding?.secondaryColor || '#424242',
      params.branding?.backgroundColor || '#ffffff',
      params.branding?.fontFamily || 'Inter, sans-serif',
      params.createdBy || null
    ).run();

    return this.getTenantById(id) as Promise<Tenant>;
  }

  /**
   * Update tenant
   */
  async updateTenant(id: string, updates: Partial<{
    name: string;
    domain: string;
    status: 'active' | 'suspended';
    settings: TenantSettings;
    branding: TenantBranding;
    emailFromName: string;
    emailFromAddress: string;
    emailReplyTo: string;
    maxUsers: number;
    maxClients: number;
  }>): Promise<Tenant> {
    const sets: string[] = [];
    const values: any[] = [];

    if (updates.name !== undefined) {
      sets.push('name = ?');
      values.push(updates.name);
    }

    if (updates.domain !== undefined) {
      // Validate domain uniqueness
      const existing = await this.db.prepare(`
        SELECT id FROM tenants WHERE domain = ? AND id != ?
      `).bind(updates.domain, id).first();

      if (existing) {
        throw new Error('Domain already in use');
      }

      sets.push('domain = ?');
      values.push(updates.domain);
    }

    if (updates.status !== undefined) {
      sets.push('status = ?');
      values.push(updates.status);
    }

    if (updates.settings !== undefined) {
      sets.push('settings = ?');
      values.push(JSON.stringify(updates.settings));
    }

    if (updates.branding !== undefined) {
      if (updates.branding.logoUrl !== undefined) {
        sets.push('logo_url = ?');
        values.push(updates.branding.logoUrl);
      }
      if (updates.branding.primaryColor !== undefined) {
        sets.push('primary_color = ?');
        values.push(updates.branding.primaryColor);
      }
      if (updates.branding.secondaryColor !== undefined) {
        sets.push('secondary_color = ?');
        values.push(updates.branding.secondaryColor);
      }
      if (updates.branding.backgroundColor !== undefined) {
        sets.push('background_color = ?');
        values.push(updates.branding.backgroundColor);
      }
      if (updates.branding.fontFamily !== undefined) {
        sets.push('font_family = ?');
        values.push(updates.branding.fontFamily);
      }
    }

    if (updates.emailFromName !== undefined) {
      sets.push('email_from_name = ?');
      values.push(updates.emailFromName);
    }

    if (updates.maxUsers !== undefined) {
      sets.push('max_users = ?');
      values.push(updates.maxUsers);
    }

    sets.push('updated_at = datetime("now")');

    if (sets.length === 1) {
      return this.getTenantById(id) as Promise<Tenant>;
    }

    values.push(id);

    await this.db.prepare(`
      UPDATE tenants SET ${sets.join(', ')} WHERE id = ?
    `).bind(...values).run();

    return this.getTenantById(id) as Promise<Tenant>;
  }

  /**
   * Delete tenant (soft delete)
   */
  async deleteTenant(id: string): Promise<void> {
    if (id === DEFAULT_TENANT_ID) {
      throw new Error('Cannot delete default tenant');
    }

    await this.db.prepare(`
      UPDATE tenants SET status = 'deleted', updated_at = datetime('now')
      WHERE id = ?
    `).bind(id).run();
  }

  /**
   * List all tenants
   */
  async listTenants(params?: {
    status?: 'active' | 'suspended' | 'deleted';
    limit?: number;
    offset?: number;
  }): Promise<{ tenants: Tenant[]; total: number }> {
    let whereClause = '';
    const values: any[] = [];

    if (params?.status) {
      whereClause = 'WHERE status = ?';
      values.push(params.status);
    }

    const countResult = await this.db.prepare(`
      SELECT COUNT(*) as count FROM tenants ${whereClause}
    `).bind(...values).first<{ count: number }>();

    const limit = params?.limit || 50;
    const offset = params?.offset || 0;

    const result = await this.db.prepare(`
      SELECT * FROM tenants ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).bind(...values, limit, offset).all();

    return {
      tenants: result.results.map(this.mapTenant),
      total: countResult?.count || 0,
    };
  }

  /**
   * Get tenant branding for UI
   */
  async getTenantBranding(tenantId: string): Promise<TenantBranding> {
    const tenant = await this.getTenantById(tenantId);

    if (!tenant) {
      throw new Error('Tenant not found');
    }

    return {
      logoUrl: tenant.logoUrl,
      faviconUrl: tenant.faviconUrl,
      primaryColor: tenant.primaryColor,
      secondaryColor: tenant.secondaryColor,
      backgroundColor: tenant.backgroundColor,
      fontFamily: tenant.fontFamily,
    };
  }

  // Tenant Admin Management

  /**
   * Add admin to tenant
   */
  async addTenantAdmin(params: {
    tenantId: string;
    userId: string;
    role: 'owner' | 'admin' | 'viewer';
    grantedBy?: string;
  }): Promise<TenantAdmin> {
    const id = generateId('ta');

    await this.db.prepare(`
      INSERT INTO tenant_admins (id, tenant_id, user_id, role, granted_by)
      VALUES (?, ?, ?, ?, ?)
    `).bind(id, params.tenantId, params.userId, params.role, params.grantedBy || null).run();

    return this.getTenantAdmin(id) as Promise<TenantAdmin>;
  }

  /**
   * Remove admin from tenant
   */
  async removeTenantAdmin(tenantId: string, userId: string): Promise<void> {
    // Prevent removing last owner
    const owners = await this.db.prepare(`
      SELECT COUNT(*) as count FROM tenant_admins
      WHERE tenant_id = ? AND role = 'owner'
    `).bind(tenantId).first<{ count: number }>();

    const isOwner = await this.db.prepare(`
      SELECT role FROM tenant_admins WHERE tenant_id = ? AND user_id = ?
    `).bind(tenantId, userId).first();

    if (isOwner?.role === 'owner' && owners?.count === 1) {
      throw new Error('Cannot remove the last owner');
    }

    await this.db.prepare(`
      DELETE FROM tenant_admins WHERE tenant_id = ? AND user_id = ?
    `).bind(tenantId, userId).run();
  }

  /**
   * Check if user is tenant admin
   */
  async isTenantAdmin(tenantId: string, userId: string): Promise<boolean> {
    const result = await this.db.prepare(`
      SELECT id FROM tenant_admins WHERE tenant_id = ? AND user_id = ?
    `).bind(tenantId, userId).first();

    return !!result;
  }

  /**
   * Get tenant admin role
   */
  async getTenantAdminRole(tenantId: string, userId: string): Promise<'owner' | 'admin' | 'viewer' | null> {
    const result = await this.db.prepare(`
      SELECT role FROM tenant_admins WHERE tenant_id = ? AND user_id = ?
    `).bind(tenantId, userId).first();

    return result?.role as 'owner' | 'admin' | 'viewer' | null;
  }

  private async getTenantAdmin(id: string): Promise<TenantAdmin | null> {
    const result = await this.db.prepare(`
      SELECT ta.*, u.email as user_email
      FROM tenant_admins ta
      JOIN user u ON ta.user_id = u.id
      WHERE ta.id = ?
    `).bind(id).first();

    if (!result) return null;

    return {
      id: result.id as string,
      tenantId: result.tenant_id as string,
      userId: result.user_id as string,
      role: result.role as 'owner' | 'admin' | 'viewer',
      grantedAt: result.granted_at as string,
      grantedBy: result.granted_by as string | null,
      user: {
        email: result.user_email as string,
      },
    };
  }

  private mapTenant(row: any): Tenant {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      domain: row.domain,
      status: row.status,
      logoUrl: row.logo_url,
      faviconUrl: row.favicon_url,
      primaryColor: row.primary_color,
      secondaryColor: row.secondary_color,
      backgroundColor: row.background_color,
      fontFamily: row.font_family,
      emailFromName: row.email_from_name,
      emailFromAddress: row.email_from_address,
      emailReplyTo: row.email_reply_to,
      settings: JSON.parse(row.settings || '{}'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
      maxUsers: row.max_users,
      maxClients: row.max_clients,
      maxSessionsPerUser: row.max_sessions_per_user,
    };
  }
}
```

---

## Tenant Middleware

### File: apps/auth/src/middleware/tenant.ts

```typescript
import { createMiddleware } from 'hono/factory';
import { TenantService } from '../services/tenant.service';
import type { Env } from '../types/env';
import type { TenantContext } from '../types/tenant';

/**
 * Middleware to resolve tenant from request
 */
export const resolveTenant = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const tenantService = new TenantService(c.env.AUTH_DB);

  let tenant: TenantContext['tenant'] | null = null;

  // Try to resolve from custom domain
  const host = c.req.header('Host') || '';
  tenant = await tenantService.resolveTenantByDomain(host);

  // Try to resolve from subdomain
  if (!tenant) {
    const subdomain = extractSubdomain(host);
    if (subdomain && subdomain !== 'auth' && subdomain !== 'www') {
      tenant = await tenantService.resolveTenantBySlug(subdomain);
    }
  }

  // Try to resolve from query parameter (for testing)
  if (!tenant && c.env.ENVIRONMENT === 'development') {
    const tenantSlug = c.req.query('tenant');
    if (tenantSlug) {
      tenant = await tenantService.resolveTenantBySlug(tenantSlug);
    }
  }

  // Fall back to default tenant
  if (!tenant) {
    tenant = await tenantService.getDefaultTenant();
  }

  // Set tenant context
  const tenantContext: TenantContext = {
    tenant,
    branding: {
      logoUrl: tenant.logoUrl,
      faviconUrl: tenant.faviconUrl,
      primaryColor: tenant.primaryColor,
      secondaryColor: tenant.secondaryColor,
      backgroundColor: tenant.backgroundColor,
      fontFamily: tenant.fontFamily,
    },
    isDefault: tenant.id === 'tenant_default',
  };

  c.set('tenantContext', tenantContext);
  c.set('tenantId', tenant.id);

  await next();
});

/**
 * Middleware to require tenant admin access
 */
export const requireTenantAdmin = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const tenantId = c.get('tenantId');
  const activeAccount = c.get('activeAccount');

  if (!activeAccount) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const tenantService = new TenantService(c.env.AUTH_DB);
  const isAdmin = await tenantService.isTenantAdmin(tenantId, activeAccount.userId);

  if (!isAdmin) {
    return c.json({ error: 'Tenant admin access required' }, 403);
  }

  await next();
});

function extractSubdomain(host: string): string | null {
  const parts = host.split('.');
  if (parts.length >= 3) {
    return parts[0];
  }
  return null;
}
```

---

## Tenant-Scoped Queries

### File: apps/auth/src/utils/tenant-query.ts

```typescript
/**
 * Helper to build tenant-scoped queries
 */
export function withTenantScope(baseQuery: string, tenantId: string): string {
  // Add tenant_id condition to WHERE clause
  if (baseQuery.toLowerCase().includes('where')) {
    return baseQuery.replace(/where/i, `WHERE tenant_id = '${tenantId}' AND`);
  } else {
    const insertPoint = baseQuery.toLowerCase().includes('order by')
      ? baseQuery.toLowerCase().indexOf('order by')
      : baseQuery.toLowerCase().includes('limit')
        ? baseQuery.toLowerCase().indexOf('limit')
        : baseQuery.length;

    return `${baseQuery.slice(0, insertPoint)} WHERE tenant_id = '${tenantId}' ${baseQuery.slice(insertPoint)}`;
  }
}

/**
 * Tenant-aware user query builder
 */
export class TenantQueryBuilder {
  constructor(private tenantId: string) {}

  users() {
    return {
      select: `SELECT * FROM user WHERE tenant_id = ?`,
      count: `SELECT COUNT(*) as count FROM user WHERE tenant_id = ?`,
      bindings: [this.tenantId],
    };
  }

  clients() {
    return {
      select: `SELECT * FROM oauth_clients WHERE tenant_id = ?`,
      count: `SELECT COUNT(*) as count FROM oauth_clients WHERE tenant_id = ?`,
      bindings: [this.tenantId],
    };
  }

  roles() {
    return {
      // Include system roles (tenant_id IS NULL) and tenant-specific roles
      select: `SELECT * FROM roles WHERE tenant_id = ? OR (tenant_id IS NULL AND is_system_role = 1)`,
      bindings: [this.tenantId],
    };
  }

  auditEvents() {
    return {
      select: `SELECT * FROM audit_events WHERE tenant_id = ?`,
      bindings: [this.tenantId],
    };
  }
}
```

---

## Tenant Routes

### File: apps/auth/src/routes/admin/tenants.ts

```typescript
import { Hono } from 'hono';
import { TenantService } from '../../services/tenant.service';
import { requireSuperAdmin } from '../../middleware/admin-auth';
import { emitAuditEvent } from '../../services/audit';
import type { Env } from '../../types/env';

const tenantsRoute = new Hono<{ Bindings: Env }>();

// All tenant management requires super admin
tenantsRoute.use('*', requireSuperAdmin);

/**
 * GET /admin/tenants
 * List all tenants
 */
tenantsRoute.get('/', async (c) => {
  const status = c.req.query('status') as any;
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const tenantService = new TenantService(c.env.AUTH_DB);
  const { tenants, total } = await tenantService.listTenants({ status, limit, offset });

  return c.json({ tenants, total, limit, offset });
});

/**
 * POST /admin/tenants
 * Create new tenant
 */
tenantsRoute.post('/', async (c) => {
  const body = await c.req.json<{
    name: string;
    slug: string;
    domain?: string;
    settings?: any;
    branding?: any;
  }>();

  const activeAccount = c.get('activeAccount');
  const tenantService = new TenantService(c.env.AUTH_DB);

  const tenant = await tenantService.createTenant({
    ...body,
    createdBy: activeAccount?.userId,
  });

  await emitAuditEvent(c.env, {
    type: 'tenant.created',
    userId: activeAccount?.userId || 'system',
    severity: 'info',
    metadata: { tenantId: tenant.id, tenantName: tenant.name },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json(tenant, 201);
});

/**
 * GET /admin/tenants/:id
 * Get tenant details
 */
tenantsRoute.get('/:id', async (c) => {
  const id = c.req.param('id');
  const tenantService = new TenantService(c.env.AUTH_DB);

  const tenant = await tenantService.getTenantById(id);
  if (!tenant) {
    return c.json({ error: 'Tenant not found' }, 404);
  }

  return c.json(tenant);
});

/**
 * PUT /admin/tenants/:id
 * Update tenant
 */
tenantsRoute.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();

  const tenantService = new TenantService(c.env.AUTH_DB);
  const tenant = await tenantService.updateTenant(id, body);

  await emitAuditEvent(c.env, {
    type: 'tenant.updated',
    userId: c.get('activeAccount')?.userId || 'system',
    severity: 'info',
    metadata: { tenantId: id, updates: Object.keys(body) },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json(tenant);
});

/**
 * DELETE /admin/tenants/:id
 * Delete tenant (soft delete)
 */
tenantsRoute.delete('/:id', async (c) => {
  const id = c.req.param('id');

  const tenantService = new TenantService(c.env.AUTH_DB);
  await tenantService.deleteTenant(id);

  await emitAuditEvent(c.env, {
    type: 'tenant.deleted',
    userId: c.get('activeAccount')?.userId || 'system',
    severity: 'warning',
    metadata: { tenantId: id },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ success: true });
});

/**
 * GET /admin/tenants/:id/admins
 * List tenant admins
 */
tenantsRoute.get('/:id/admins', async (c) => {
  const tenantId = c.req.param('id');

  const result = await c.env.AUTH_DB.prepare(`
    SELECT ta.*, u.email as user_email
    FROM tenant_admins ta
    JOIN user u ON ta.user_id = u.id
    WHERE ta.tenant_id = ?
    ORDER BY ta.role, ta.granted_at
  `).bind(tenantId).all();

  return c.json({
    admins: result.results.map(r => ({
      id: r.id,
      userId: r.user_id,
      email: r.user_email,
      role: r.role,
      grantedAt: r.granted_at,
    })),
  });
});

/**
 * POST /admin/tenants/:id/admins
 * Add tenant admin
 */
tenantsRoute.post('/:id/admins', async (c) => {
  const tenantId = c.req.param('id');
  const { userId, role } = await c.req.json<{ userId: string; role: 'owner' | 'admin' | 'viewer' }>();

  const tenantService = new TenantService(c.env.AUTH_DB);
  const admin = await tenantService.addTenantAdmin({
    tenantId,
    userId,
    role,
    grantedBy: c.get('activeAccount')?.userId,
  });

  return c.json(admin, 201);
});

/**
 * DELETE /admin/tenants/:id/admins/:userId
 * Remove tenant admin
 */
tenantsRoute.delete('/:id/admins/:userId', async (c) => {
  const tenantId = c.req.param('id');
  const userId = c.req.param('userId');

  const tenantService = new TenantService(c.env.AUTH_DB);
  await tenantService.removeTenantAdmin(tenantId, userId);

  return c.json({ success: true });
});

export default tenantsRoute;
```

---

## Testing Requirements

### Unit Tests

#### File: apps/auth/src/services/__tests__/tenant.service.test.ts

```typescript
describe('TenantService', () => {
  describe('resolveTenantByDomain', () => {
    it('should resolve tenant from custom domain', async () => {
      // Setup: Tenant with domain='auth.clientcorp.com'
      // Input: 'auth.clientcorp.com'
      // Acceptance: Returns matching Tenant
    });

    it('should return null for unknown domain', async () => {
      // Input: 'unknown.example.com'
      // Acceptance: Returns null
    });

    it('should return null for suspended tenant', async () => {
      // Setup: Tenant with status='suspended'
      // Acceptance: Returns null
    });

    it('should return null for deleted tenant', async () => {
      // Setup: Tenant with status='deleted'
      // Acceptance: Returns null
    });

    it('should be case-insensitive for domain matching', async () => {
      // Input: 'AUTH.ClientCorp.COM'
      // Acceptance: Returns tenant (if DB supports case-insensitive)
    });
  });

  describe('resolveTenantBySlug', () => {
    it('should resolve tenant from slug', async () => {
      // Input: 'clientcorp'
      // Acceptance: Returns matching Tenant
    });

    it('should return null for unknown slug', async () => {
      // Acceptance: Returns null
    });

    it('should return null for inactive tenant', async () => {
      // Acceptance: Returns null for suspended/deleted
    });
  });

  describe('getTenantById', () => {
    it('should return tenant with all fields', async () => {
      // Acceptance: Tenant object with branding, settings, limits
    });

    it('should parse settings JSON', async () => {
      // Acceptance: settings is object, not string
    });

    it('should return null for non-existent ID', async () => {
      // Acceptance: Returns null
    });
  });

  describe('getDefaultTenant', () => {
    it('should return the default tenant', async () => {
      // Acceptance: Returns tenant with id='tenant_default'
    });

    it('should throw if default tenant not found', async () => {
      // Setup: Delete default tenant (test only)
      // Acceptance: Throws 'Default tenant not found'
    });
  });

  describe('createTenant', () => {
    it('should create tenant with all fields', async () => {
      // Acceptance: Tenant created with name, slug, domain, settings, branding
    });

    it('should generate unique ID with prefix', async () => {
      // Acceptance: id starts with 'tenant_'
    });

    it('should reject duplicate slug', async () => {
      // Setup: Tenant with slug='existing'
      // Test: Create with slug='existing'
      // Acceptance: Throws 'Tenant slug already exists'
    });

    it('should reject duplicate domain', async () => {
      // Setup: Tenant with domain='taken.com'
      // Test: Create with domain='taken.com'
      // Acceptance: Throws 'Domain already in use'
    });

    it('should allow null domain', async () => {
      // Acceptance: Tenant created without domain
    });

    it('should set default branding values', async () => {
      // Acceptance: primaryColor='#1976d2', fontFamily='Inter, sans-serif'
    });

    it('should set default limits', async () => {
      // Acceptance: maxUsers=1000, maxClients=10
    });

    it('should record createdBy', async () => {
      // Acceptance: createdBy = provided userId
    });
  });

  describe('updateTenant', () => {
    it('should update tenant name', async () => {
      // Acceptance: name changed in DB
    });

    it('should update tenant domain', async () => {
      // Acceptance: domain changed
    });

    it('should validate domain uniqueness on update', async () => {
      // Setup: Another tenant has the domain
      // Acceptance: Throws 'Domain already in use'
    });

    it('should allow setting same domain (no-op)', async () => {
      // Acceptance: No error when domain unchanged
    });

    it('should update status to suspended', async () => {
      // Acceptance: status = 'suspended'
    });

    it('should update branding fields', async () => {
      // Acceptance: logoUrl, primaryColor, etc. updated
    });

    it('should update settings as JSON', async () => {
      // Acceptance: settings stored as JSON string
    });

    it('should update updatedAt timestamp', async () => {
      // Acceptance: updatedAt changes
    });

    it('should handle partial updates', async () => {
      // Setup: Only update name
      // Acceptance: Other fields unchanged
    });
  });

  describe('deleteTenant', () => {
    it('should soft delete tenant (set status=deleted)', async () => {
      // Acceptance: status = 'deleted', not removed from DB
    });

    it('should prevent deleting default tenant', async () => {
      // Acceptance: Throws 'Cannot delete default tenant'
    });

    it('should update updatedAt on delete', async () => {
      // Acceptance: updatedAt changes
    });
  });

  describe('listTenants', () => {
    it('should return all tenants with pagination', async () => {
      // Acceptance: { tenants: [], total: N }
    });

    it('should filter by status', async () => {
      // Setup: ?status=active
      // Acceptance: Only active tenants returned
    });

    it('should respect limit and offset', async () => {
      // Setup: 50 tenants, ?limit=10&offset=20
      // Acceptance: Returns tenants 21-30
    });

    it('should order by created_at descending', async () => {
      // Acceptance: Newest first
    });
  });

  describe('getTenantBranding', () => {
    it('should return branding object', async () => {
      // Acceptance: { logoUrl, primaryColor, ... }
    });

    it('should throw for non-existent tenant', async () => {
      // Acceptance: Throws 'Tenant not found'
    });
  });

  describe('Tenant Admin Management', () => {
    describe('addTenantAdmin', () => {
      it('should add user as tenant admin', async () => {
        // Acceptance: tenant_admins row created
      });

      it('should set correct role', async () => {
        // Acceptance: role = 'admin' | 'owner' | 'viewer'
      });

      it('should record grantedBy', async () => {
        // Acceptance: grantedBy = grantor userId
      });

      it('should set grantedAt timestamp', async () => {
        // Acceptance: grantedAt = current time
      });

      it('should prevent duplicate admin entries', async () => {
        // Acceptance: Error or update existing
      });
    });

    describe('removeTenantAdmin', () => {
      it('should remove admin from tenant', async () => {
        // Acceptance: tenant_admins row deleted
      });

      it('should prevent removing last owner', async () => {
        // Setup: Only 1 owner
        // Acceptance: Throws 'Cannot remove the last owner'
      });

      it('should allow removing admin when other owners exist', async () => {
        // Setup: 2 owners
        // Acceptance: One owner removed successfully
      });

      it('should allow removing non-owner admins freely', async () => {
        // Acceptance: Admin removed even if only one
      });
    });

    describe('isTenantAdmin', () => {
      it('should return true for tenant admin', async () => {
        // Acceptance: true
      });

      it('should return false for non-admin', async () => {
        // Acceptance: false
      });

      it('should return false for admin of different tenant', async () => {
        // Acceptance: false
      });
    });

    describe('getTenantAdminRole', () => {
      it('should return correct role', async () => {
        // Acceptance: 'owner' | 'admin' | 'viewer'
      });

      it('should return null for non-admin', async () => {
        // Acceptance: null
      });
    });
  });
});
```

### Tenant Middleware Tests

```typescript
describe('Tenant Middleware', () => {
  describe('resolveTenant', () => {
    it('should resolve tenant from custom domain', async () => {
      // Setup: Request Host: auth.clientcorp.com
      // Acceptance: c.get('tenantId') = clientcorp's tenant ID
    });

    it('should resolve tenant from subdomain', async () => {
      // Setup: Request Host: clientcorp.auth.example.com
      // Acceptance: Tenant resolved from subdomain 'clientcorp'
    });

    it('should ignore www subdomain', async () => {
      // Setup: Request Host: www.auth.example.com
      // Acceptance: Falls back to default, not tenant 'www'
    });

    it('should ignore auth subdomain', async () => {
      // Setup: Request Host: auth.example.com
      // Acceptance: Falls back to default, not tenant 'auth'
    });

    it('should fall back to default tenant', async () => {
      // Setup: Request Host: unknown.example.com
      // Acceptance: c.get('tenantId') = 'tenant_default'
    });

    it('should set tenant context with branding', async () => {
      // Acceptance: c.get('tenantContext') has branding object
    });

    it('should set isDefault flag', async () => {
      // Acceptance: isDefault = true for default tenant
    });

    it('should resolve from query param in development', async () => {
      // Setup: ?tenant=clientcorp, ENVIRONMENT=development
      // Acceptance: Tenant resolved from query param
    });

    it('should ignore query param in production', async () => {
      // Setup: ?tenant=clientcorp, ENVIRONMENT=production
      // Acceptance: Falls back to default
    });
  });

  describe('requireTenantAdmin', () => {
    it('should allow tenant admin', async () => {
      // Setup: User is admin of current tenant
      // Acceptance: next() called
    });

    it('should reject non-admin', async () => {
      // Acceptance: 403 'Tenant admin access required'
    });

    it('should reject unauthenticated', async () => {
      // Acceptance: 401 'Authentication required'
    });

    it('should reject admin of different tenant', async () => {
      // Setup: User is admin of tenant-a, accessing tenant-b
      // Acceptance: 403
    });
  });
});
```

### Tenant Routes Tests

```typescript
describe('Tenant Admin Routes', () => {
  describe('GET /admin/tenants', () => {
    it('should require super admin', async () => {
      // Acceptance: 403 for non-super-admin
    });

    it('should list all tenants', async () => {
      // Acceptance: Array of tenants with pagination
    });

    it('should filter by status', async () => {
      // Acceptance: Only matching status returned
    });
  });

  describe('POST /admin/tenants', () => {
    it('should create new tenant', async () => {
      // Acceptance: Tenant created, 201 response
    });

    it('should emit audit event', async () => {
      // Acceptance: 'tenant.created' event logged
    });

    it('should require super admin', async () => {
      // Acceptance: 403 for tenant admin
    });
  });

  describe('GET /admin/tenants/:id', () => {
    it('should return tenant details', async () => {
      // Acceptance: Full tenant object
    });

    it('should return 404 for unknown tenant', async () => {
      // Acceptance: { error: 'Tenant not found' }, 404
    });
  });

  describe('PUT /admin/tenants/:id', () => {
    it('should update tenant', async () => {
      // Acceptance: Updated tenant returned
    });

    it('should emit audit event', async () => {
      // Acceptance: 'tenant.updated' event logged
    });
  });

  describe('DELETE /admin/tenants/:id', () => {
    it('should soft delete tenant', async () => {
      // Acceptance: status = 'deleted'
    });

    it('should emit audit event', async () => {
      // Acceptance: 'tenant.deleted' event logged
    });

    it('should prevent deleting default tenant', async () => {
      // Acceptance: Error response
    });
  });

  describe('GET /admin/tenants/:id/admins', () => {
    it('should list tenant admins', async () => {
      // Acceptance: Array of admins with user email
    });

    it('should order by role then granted_at', async () => {
      // Acceptance: Owners first, then by date
    });
  });

  describe('POST /admin/tenants/:id/admins', () => {
    it('should add tenant admin', async () => {
      // Acceptance: Admin created, 201
    });
  });

  describe('DELETE /admin/tenants/:id/admins/:userId', () => {
    it('should remove tenant admin', async () => {
      // Acceptance: Admin removed
    });

    it('should prevent removing last owner', async () => {
      // Acceptance: Error response
    });
  });
});
```

### Tenant Isolation Tests

```typescript
describe('Tenant Data Isolation', () => {
  describe('User Isolation', () => {
    it('should not return users from other tenants', async () => {
      // Setup: User in tenant-a
      // Test: Query users as tenant-b admin
      // Acceptance: User not in results
    });

    it('should not allow creating user in other tenant', async () => {
      // Acceptance: User created in admin's tenant only
    });
  });

  describe('OAuth Client Isolation', () => {
    it('should not return clients from other tenants', async () => {
      // Acceptance: Only current tenant's clients
    });

    it('should not allow authorizing with other tenant client', async () => {
      // Acceptance: Client validation fails
    });
  });

  describe('Session Isolation', () => {
    it('should not return sessions from other tenants', async () => {
      // Acceptance: Only current tenant's sessions
    });
  });

  describe('Audit Event Isolation', () => {
    it('should not return events from other tenants', async () => {
      // Acceptance: Only current tenant's events
    });

    it('should tag new events with tenant_id', async () => {
      // Acceptance: audit_events.tenant_id set
    });
  });

  describe('Role Isolation', () => {
    it('should return tenant roles and system roles', async () => {
      // Acceptance: Both tenant-specific and is_system_role=1 roles
    });

    it('should not return other tenant roles', async () => {
      // Acceptance: Only own tenant's custom roles
    });
  });
});
```

### Tenant Query Builder Tests

```typescript
describe('TenantQueryBuilder', () => {
  describe('users()', () => {
    it('should return query with tenant_id binding', async () => {
      // Acceptance: WHERE tenant_id = ?
    });
  });

  describe('clients()', () => {
    it('should return query with tenant_id binding', async () => {
      // Acceptance: WHERE tenant_id = ?
    });
  });

  describe('roles()', () => {
    it('should include system roles', async () => {
      // Acceptance: WHERE tenant_id = ? OR is_system_role = 1
    });
  });

  describe('auditEvents()', () => {
    it('should return query with tenant_id binding', async () => {
      // Acceptance: WHERE tenant_id = ?
    });
  });
});
```

### E2E Tests

```typescript
test.describe('Multi-Tenant E2E', () => {
  test('users are isolated by tenant', async ({ request }) => {
    // Create user in tenant A
    await createUserInTenant('tenant-a', 'user@tenant-a.com');

    // Query as tenant B admin
    const response = await request.get('/admin/users', {
      headers: { Host: 'auth.tenant-b.com' },
    });

    const users = await response.json();
    const found = users.users.find(u => u.email === 'user@tenant-a.com');
    expect(found).toBeUndefined();
  });

  test('tenant branding is applied to login page', async ({ page }) => {
    await page.goto('https://auth.clientcorp.com/login');

    // Check branding
    const logo = page.locator('img.logo');
    await expect(logo).toHaveAttribute('src', /clientcorp/);

    // Check primary color
    const button = page.locator('button[type="submit"]');
    await expect(button).toHaveCSS('background-color', 'rgb(0, 150, 136)'); // Teal
  });

  test('tenant admin can only manage own tenant', async ({ request }) => {
    // Login as tenant-a admin
    const response = await request.get('/admin/users', {
      headers: { Authorization: `Bearer ${tenantAAdminToken}` },
    });

    const users = await response.json();
    users.users.forEach((u: any) => {
      expect(u.tenantId).toBe('tenant-a');
    });
  });

  test('custom domain routes to correct tenant', async ({ page }) => {
    await page.goto('https://sso.clientcorp.com/login');

    // Should see clientcorp branding
    await expect(page.getByText('ClientCorp')).toBeVisible();
  });

  test('subdomain routes to correct tenant', async ({ page }) => {
    await page.goto('https://clientcorp.auth.example.com/login');

    // Should see clientcorp branding
    await expect(page.getByText('ClientCorp')).toBeVisible();
  });

  test('SSO works within tenant boundary', async ({ page }) => {
    // Login to app-a in tenant-x
    await loginToApp(page, 'tenant-x-app-a', 'user@tenant-x.com');

    // SSO to app-b in same tenant
    await page.goto('https://auth.tenant-x.com/authorize?client_id=tenant-x-app-b&prompt=none&redirect_uri=...');

    await page.waitForURL(/code=/);
    expect(page.url()).toContain('code=');
  });

  test('SSO fails across tenant boundary', async ({ page }) => {
    // Login in tenant-x
    await loginToApp(page, 'tenant-x-app-a', 'user@tenant-x.com');

    // Try SSO to tenant-y (should fail - different tenant)
    await page.goto('https://auth.tenant-y.com/authorize?client_id=tenant-y-app&prompt=none&redirect_uri=...');

    await page.waitForURL(/error=/);
    expect(page.url()).toContain('error=login_required');
  });

  test('super admin can create new tenant', async ({ page }) => {
    await loginAsSuperAdmin(page);

    await page.goto('/admin/tenants');
    await page.click('text=Create Tenant');

    await page.fill('[name="name"]', 'New Corp');
    await page.fill('[name="slug"]', 'newcorp');
    await page.click('text=Create');

    await expect(page.getByText('New Corp')).toBeVisible();
  });

  test('tenant admin cannot create tenants', async ({ page }) => {
    await loginAsTenantAdmin(page, 'tenant-a');

    await page.goto('/admin/tenants');

    // Should be forbidden
    await expect(page.getByText('Access Denied')).toBeVisible();
  });
});
```

### Coverage Requirements

| Component | Target Coverage |
|-----------|----------------|
| TenantService | >90% |
| Tenant Middleware | 100% |
| Tenant Routes | >80% |
| Tenant Isolation | 100% |
| Query Builder | 100% |

**Overall Lane 5 Coverage Target: >85%**

**Critical Path Coverage**: The following must have 100% coverage:
- Data isolation in all queries
- Tenant resolution
- Permission checks (tenant admin vs super admin)
- Cross-tenant access prevention

---

## Rollout Checklist

- [ ] Create migration 0027_tenants.sql
- [ ] Create migration 0028_tenant_columns.sql
- [ ] Create migration 0029_tenant_admins.sql
- [ ] Apply migrations locally
- [ ] Implement TenantService
- [ ] Implement tenant middleware
- [ ] Update all queries to be tenant-scoped
- [ ] Implement tenant admin routes
- [ ] Create tenant management UI in admin dashboard
- [ ] Add branding support to login UI
- [ ] Configure custom domain routing (Cloudflare)
- [ ] Write unit tests
- [ ] Write E2E tests
- [ ] Performance test with multiple tenants
- [ ] Document tenant management

---

## Estimated Effort
- Database migrations: 2-3 hours
- TenantService: 6-8 hours
- Middleware: 3-4 hours
- Query scoping updates: 8-10 hours
- Admin routes: 4-6 hours
- Admin UI: 8-10 hours
- Custom domain setup: 4-6 hours
- Testing: 8-10 hours
- **Total: 43-57 hours**

## Security Considerations
- All queries must be tenant-scoped
- Tenant admins can only access their tenant
- Super admin required for cross-tenant operations
- Domain verification before custom domain activation
- Tenant deletion is soft-delete only
- Audit all tenant management actions
