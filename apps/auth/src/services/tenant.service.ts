/**
 * Tenant Service
 *
 * Core service for managing tenants, tenant administrators, and tenant-scoped operations.
 * Updated to work with OpenAuth's schema (002_add_tenant_support.sql):
 * - tenants: id, domain, name, status, branding (JSON), settings (JSON), created_at, updated_at
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
import { clearTenantCache } from './tenant-cache';

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
   * Resolve tenant by ID (replaces slug-based lookup)
   *
   * SECURITY: Uses parameterized query to prevent SQL injection
   *
   * @param tenantId - Tenant ID
   * @returns Tenant or null if not found
   */
  async resolveTenantBySlug(tenantId: string): Promise<Tenant | null> {
    // OpenAuth doesn't have slug - use ID instead
    return this.getTenantById(tenantId);
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
   * @throws Error if ID or domain already exists
   */
  async createTenant(params: {
    id?: string;
    name: string;
    slug?: string; // Ignored - use id instead
    domain?: string;
    createdBy?: string;
    settings?: Partial<TenantSettings>;
    branding?: Partial<TenantBranding>;
  }): Promise<Tenant> {
    const id = params.id || params.slug || generateId('tenant');
    const now = Date.now();

    // Validate ID uniqueness
    const existing = await this.db.prepare(`
      SELECT id FROM tenants WHERE id = ?
    `).bind(id).first();

    if (existing) {
      throw new Error('Tenant ID already exists');
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

    // Build branding JSON
    const branding = {
      logoUrl: params.branding?.logoUrl || null,
      faviconUrl: params.branding?.faviconUrl || null,
      primaryColor: params.branding?.primaryColor || '#1976d2',
      secondaryColor: params.branding?.secondaryColor || '#424242',
      backgroundColor: params.branding?.backgroundColor || '#ffffff',
      fontFamily: params.branding?.fontFamily || 'Inter, sans-serif',
    };

    // Build settings JSON
    const settings = {
      ...params.settings,
      createdBy: params.createdBy || null,
    };

    await this.db.prepare(`
      INSERT INTO tenants (id, name, domain, status, branding, settings, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
    `).bind(
      id,
      params.name,
      params.domain || null,
      JSON.stringify(branding),
      JSON.stringify(settings),
      now,
      now
    ).run();
    clearTenantCache();

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
    // Get current tenant
    const current = await this.getTenantById(id);
    if (!current) {
      throw new Error('Tenant not found');
    }

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

    // Merge branding updates
    if (updates.branding !== undefined) {
      const newBranding = {
        logoUrl: updates.branding.logoUrl ?? current.logoUrl,
        faviconUrl: updates.branding.faviconUrl ?? current.faviconUrl,
        primaryColor: updates.branding.primaryColor ?? current.primaryColor,
        secondaryColor: updates.branding.secondaryColor ?? current.secondaryColor,
        backgroundColor: updates.branding.backgroundColor ?? current.backgroundColor,
        fontFamily: updates.branding.fontFamily ?? current.fontFamily,
      };
      sets.push('branding = ?');
      values.push(JSON.stringify(newBranding));
    }

    // Merge settings updates
    if (updates.settings !== undefined || updates.emailFromName !== undefined ||
        updates.emailFromAddress !== undefined || updates.emailReplyTo !== undefined ||
        updates.maxUsers !== undefined || updates.maxClients !== undefined) {
      const newSettings = {
        ...current.settings,
        ...(updates.settings || {}),
        emailFromName: updates.emailFromName ?? current.emailFromName,
        emailFromAddress: updates.emailFromAddress ?? current.emailFromAddress,
        emailReplyTo: updates.emailReplyTo ?? current.emailReplyTo,
        maxUsers: updates.maxUsers ?? current.maxUsers,
        maxClients: updates.maxClients ?? current.maxClients,
      };
      sets.push('settings = ?');
      values.push(JSON.stringify(newSettings));
    }

    const now = Date.now();
    sets.push('updated_at = ?');
    values.push(now);

    if (sets.length === 1) {
      // Only updated_at changed, return current tenant
      return current;
    }

    values.push(id);

    await this.db.prepare(`
      UPDATE tenants SET ${sets.join(', ')} WHERE id = ?
    `).bind(...values).run();
    clearTenantCache();

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

    const now = Date.now();
    await this.db.prepare(`
      UPDATE tenants SET status = 'deleted', updated_at = ?
      WHERE id = ?
    `).bind(now, id).run();
    clearTenantCache();
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
    const now = Date.now();

    await this.db.prepare(`
      INSERT INTO tenant_admins (id, tenant_id, user_id, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, params.tenantId, params.userId, params.role, now, now).run();

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
      JOIN users u ON ta.user_id = u.id
      WHERE ta.id = ?
    `).bind(id).first();

    if (!result) return null;

    return {
      id: result.id as string,
      tenantId: result.tenant_id as string,
      userId: result.user_id as string,
      role: result.role as 'owner' | 'admin' | 'viewer',
      grantedAt: new Date(result.created_at as number).toISOString(),
      grantedBy: null,
      user: {
        email: result.user_email as string,
      },
    };
  }

  /**
   * Map database row to Tenant object
   * OpenAuth schema: id, domain, name, status, branding (JSON), settings (JSON), created_at, updated_at
   *
   * @private
   * @param row - Database row
   * @returns Tenant object
   */
  private mapTenant(row: unknown): Tenant {
    const r = row as Record<string, unknown>;

    // Parse branding JSON
    let branding: Record<string, unknown> = {};
    if (r.branding) {
      try {
        branding = JSON.parse(r.branding as string);
      } catch {
        branding = {};
      }
    }

    // Parse settings JSON
    let settings: Record<string, unknown> = {};
    if (r.settings) {
      try {
        settings = JSON.parse(r.settings as string);
      } catch {
        settings = {};
      }
    }

    return {
      id: r.id as string,
      name: r.name as string,
      slug: r.id as string, // Use ID as slug for backwards compatibility
      domain: r.domain as string | null,
      status: r.status as 'active' | 'suspended' | 'deleted',
      logoUrl: (branding.logoUrl as string) || null,
      faviconUrl: (branding.faviconUrl as string) || null,
      primaryColor: (branding.primaryColor as string) || '#1976d2',
      secondaryColor: (branding.secondaryColor as string) || '#424242',
      backgroundColor: (branding.backgroundColor as string) || '#ffffff',
      fontFamily: (branding.fontFamily as string) || 'Inter, sans-serif',
      emailFromName: (settings.emailFromName as string) || null,
      emailFromAddress: (settings.emailFromAddress as string) || null,
      emailReplyTo: (settings.emailReplyTo as string) || null,
      settings: settings as TenantSettings,
      createdAt: new Date(r.created_at as number).toISOString(),
      updatedAt: new Date(r.updated_at as number).toISOString(),
      createdBy: (settings.createdBy as string) || null,
      maxUsers: (settings.maxUsers as number) || 100,
      maxClients: (settings.maxClients as number) || 10,
      maxSessionsPerUser: (settings.maxSessionsPerUser as number) || 5,
    };
  }
}
