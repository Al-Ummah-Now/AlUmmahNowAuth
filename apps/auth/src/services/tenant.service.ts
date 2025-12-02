/**
 * Tenant Service
 *
 * Core service for managing tenants, tenant administrators, and tenant-scoped operations.
 * Implements multi-tenant architecture with complete data isolation.
 *
 * SECURITY CRITICAL:
 * - ALL queries use parameterized bindings to prevent SQL injection
 * - NO string interpolation for tenant IDs or any user input
 * - Tenant IDs from HTTP headers are untrusted input
 *
 * @module services/tenant.service
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { Tenant, TenantSettings, TenantBranding, TenantAdmin } from '../types/tenant';
import { DEFAULT_TENANT_ID } from '../types/tenant';

/**
 * Generate a unique ID with a prefix
 */
function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export class TenantService {
  constructor(private db: D1Database) {}

  /**
   * Resolve tenant from domain
   *
   * SECURITY: Uses parameterized query to prevent SQL injection
   *
   * @param domain - Domain name (from HTTP Host header)
   * @returns Tenant or null if not found
   */
  async resolveTenantByDomain(domain: string): Promise<Tenant | null> {
    const result = await this.db.prepare(`
      SELECT * FROM tenants WHERE domain = ? AND status = 'active'
    `).bind(domain).first();

    return result ? this.mapTenant(result) : null;
  }

  /**
   * Resolve tenant from slug
   *
   * SECURITY: Uses parameterized query to prevent SQL injection
   *
   * @param slug - Tenant slug (from subdomain or query param)
   * @returns Tenant or null if not found
   */
  async resolveTenantBySlug(slug: string): Promise<Tenant | null> {
    const result = await this.db.prepare(`
      SELECT * FROM tenants WHERE slug = ? AND status = 'active'
    `).bind(slug).first();

    return result ? this.mapTenant(result) : null;
  }

  /**
   * Get tenant by ID
   *
   * SECURITY: Uses parameterized query to prevent SQL injection
   *
   * @param id - Tenant ID
   * @returns Tenant or null if not found
   */
  async getTenantById(id: string): Promise<Tenant | null> {
    const result = await this.db.prepare(`
      SELECT * FROM tenants WHERE id = ?
    `).bind(id).first();

    return result ? this.mapTenant(result) : null;
  }

  /**
   * Get default tenant
   *
   * @returns Default tenant
   * @throws Error if default tenant not found
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
   *
   * SECURITY: Uses parameterized query to prevent SQL injection
   *
   * @param params - Tenant creation parameters
   * @returns Created tenant
   * @throws Error if slug or domain already exists
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

    const tenant = await this.getTenantById(id);
    if (!tenant) {
      throw new Error('Failed to retrieve created tenant');
    }

    return tenant;
  }

  /**
   * Update tenant
   *
   * SECURITY: Uses parameterized query to prevent SQL injection
   *
   * @param id - Tenant ID
   * @param updates - Partial tenant updates
   * @returns Updated tenant
   * @throws Error if domain already in use
   */
  async updateTenant(id: string, updates: Partial<{
    name: string;
    domain: string;
    status: 'active' | 'suspended';
    settings: TenantSettings;
    branding: Partial<TenantBranding>;
    emailFromName: string;
    emailFromAddress: string;
    emailReplyTo: string;
    maxUsers: number;
    maxClients: number;
  }>): Promise<Tenant> {
    const sets: string[] = [];
    const values: unknown[] = [];

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

    if (updates.emailFromAddress !== undefined) {
      sets.push('email_from_address = ?');
      values.push(updates.emailFromAddress);
    }

    if (updates.emailReplyTo !== undefined) {
      sets.push('email_reply_to = ?');
      values.push(updates.emailReplyTo);
    }

    if (updates.maxUsers !== undefined) {
      sets.push('max_users = ?');
      values.push(updates.maxUsers);
    }

    if (updates.maxClients !== undefined) {
      sets.push('max_clients = ?');
      values.push(updates.maxClients);
    }

    sets.push('updated_at = datetime("now")');

    if (sets.length === 1) {
      // Only updated_at changed, return current tenant
      const tenant = await this.getTenantById(id);
      if (!tenant) {
        throw new Error('Tenant not found');
      }
      return tenant;
    }

    values.push(id);

    await this.db.prepare(`
      UPDATE tenants SET ${sets.join(', ')} WHERE id = ?
    `).bind(...values).run();

    const tenant = await this.getTenantById(id);
    if (!tenant) {
      throw new Error('Failed to retrieve updated tenant');
    }

    return tenant;
  }

  /**
   * Delete tenant (soft delete)
   *
   * SECURITY: Uses parameterized query to prevent SQL injection
   *
   * @param id - Tenant ID
   * @throws Error if trying to delete default tenant
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
   *
   * SECURITY: Uses parameterized query to prevent SQL injection
   *
   * @param params - Filter and pagination parameters
   * @returns Tenants and total count
   */
  async listTenants(params?: {
    status?: 'active' | 'suspended' | 'deleted';
    limit?: number;
    offset?: number;
  }): Promise<{ tenants: Tenant[]; total: number }> {
    let whereClause = '';
    const values: unknown[] = [];

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
      tenants: (result.results || []).map(r => this.mapTenant(r)),
      total: countResult?.count || 0,
    };
  }

  /**
   * Get tenant branding for UI
   *
   * @param tenantId - Tenant ID
   * @returns Tenant branding
   * @throws Error if tenant not found
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
   *
   * SECURITY: Uses parameterized query to prevent SQL injection
   *
   * @param params - Admin addition parameters
   * @returns Created tenant admin
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

    const admin = await this.getTenantAdmin(id);
    if (!admin) {
      throw new Error('Failed to retrieve created tenant admin');
    }

    return admin;
  }

  /**
   * Remove admin from tenant
   *
   * SECURITY: Uses parameterized query to prevent SQL injection
   *
   * @param tenantId - Tenant ID
   * @param userId - User ID
   * @throws Error if trying to remove the last owner
   */
  async removeTenantAdmin(tenantId: string, userId: string): Promise<void> {
    // Prevent removing last owner
    const owners = await this.db.prepare(`
      SELECT COUNT(*) as count FROM tenant_admins
      WHERE tenant_id = ? AND role = 'owner'
    `).bind(tenantId).first<{ count: number }>();

    const isOwner = await this.db.prepare(`
      SELECT role FROM tenant_admins WHERE tenant_id = ? AND user_id = ?
    `).bind(tenantId, userId).first<{ role: string }>();

    if (isOwner?.role === 'owner' && (owners?.count || 0) <= 1) {
      throw new Error('Cannot remove the last owner');
    }

    await this.db.prepare(`
      DELETE FROM tenant_admins WHERE tenant_id = ? AND user_id = ?
    `).bind(tenantId, userId).run();
  }

  /**
   * Check if user is tenant admin
   *
   * SECURITY: Uses parameterized query to prevent SQL injection
   *
   * @param tenantId - Tenant ID
   * @param userId - User ID
   * @returns True if user is tenant admin
   */
  async isTenantAdmin(tenantId: string, userId: string): Promise<boolean> {
    const result = await this.db.prepare(`
      SELECT id FROM tenant_admins WHERE tenant_id = ? AND user_id = ?
    `).bind(tenantId, userId).first();

    return !!result;
  }

  /**
   * Get tenant admin role
   *
   * SECURITY: Uses parameterized query to prevent SQL injection
   *
   * @param tenantId - Tenant ID
   * @param userId - User ID
   * @returns Admin role or null if not an admin
   */
  async getTenantAdminRole(tenantId: string, userId: string): Promise<'owner' | 'admin' | 'viewer' | null> {
    const result = await this.db.prepare(`
      SELECT role FROM tenant_admins WHERE tenant_id = ? AND user_id = ?
    `).bind(tenantId, userId).first<{ role: string }>();

    return result?.role as 'owner' | 'admin' | 'viewer' | null;
  }

  /**
   * Get tenant admin by ID
   *
   * SECURITY: Uses parameterized query to prevent SQL injection
   *
   * @private
   * @param id - Tenant admin ID
   * @returns Tenant admin or null
   */
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

  /**
   * Map database row to Tenant object
   *
   * @private
   * @param row - Database row
   * @returns Tenant object
   */
  private mapTenant(row: unknown): Tenant {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      name: r.name as string,
      slug: r.slug as string,
      domain: r.domain as string | null,
      status: r.status as 'active' | 'suspended' | 'deleted',
      logoUrl: r.logo_url as string | null,
      faviconUrl: r.favicon_url as string | null,
      primaryColor: r.primary_color as string,
      secondaryColor: r.secondary_color as string,
      backgroundColor: r.background_color as string,
      fontFamily: r.font_family as string,
      emailFromName: r.email_from_name as string | null,
      emailFromAddress: r.email_from_address as string | null,
      emailReplyTo: r.email_reply_to as string | null,
      settings: JSON.parse((r.settings as string) || '{}'),
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      createdBy: r.created_by as string | null,
      maxUsers: r.max_users as number,
      maxClients: r.max_clients as number,
      maxSessionsPerUser: r.max_sessions_per_user as number,
    };
  }
}
