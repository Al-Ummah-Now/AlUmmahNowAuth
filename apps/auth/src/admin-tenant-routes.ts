/**
 * Admin Tenant Routes
 *
 * Routes for tenant management (CRUD operations on tenants).
 * Requires super admin authentication.
 *
 * @module admin-tenant-routes
 */

import { verifyAdminAuth, createAuthErrorResponse } from './auth-middleware';
import { logger } from './logger';
import { emitAuditEvent } from './audit-emitter-enhanced';
import { AuditEventSeverity, AuditEventType } from './audit-events';
import { checkRateLimit, getClientIP } from './rate-limit';
import { TenantService } from './services/tenant.service';
import type { TenantBranding } from './types/tenant';
import * as v from 'valibot';

// ============================================================================
// Validation Schemas
// ============================================================================

const CreateTenantSchema = v.object({
  id: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(50), v.regex(/^[a-z0-9-]+$/))),
  slug: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(50), v.regex(/^[a-z0-9-]+$/))), // Deprecated, use id
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  domain: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(255))),
  settings: v.optional(v.record(v.string(), v.any())),
  branding: v.optional(v.object({
    logoUrl: v.optional(v.nullable(v.string())),
    faviconUrl: v.optional(v.nullable(v.string())),
    primaryColor: v.optional(v.string()),
    secondaryColor: v.optional(v.string()),
    backgroundColor: v.optional(v.string()),
    fontFamily: v.optional(v.string()),
  })),
});

const UpdateTenantSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(100))),
  domain: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(255)))),
  status: v.optional(v.picklist(['active', 'suspended'])),
  settings: v.optional(v.record(v.string(), v.any())),
  logoUrl: v.optional(v.nullable(v.string())),
  faviconUrl: v.optional(v.nullable(v.string())),
  primaryColor: v.optional(v.string()),
  secondaryColor: v.optional(v.string()),
  backgroundColor: v.optional(v.string()),
  fontFamily: v.optional(v.string()),
  emailFromName: v.optional(v.string()),
  emailFromAddress: v.optional(v.string()),
  emailReplyTo: v.optional(v.string()),
  maxUsers: v.optional(v.number()),
  maxClients: v.optional(v.number()),
});

const AddTenantAdminSchema = v.object({
  userId: v.pipe(v.string(), v.minLength(1)),
  role: v.picklist(['owner', 'admin', 'viewer']),
});

const TenantQuerySchema = v.object({
  status: v.optional(v.picklist(['active', 'suspended', 'deleted'])),
  limit: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1), v.maxValue(100))),
  offset: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(0))),
});

// ============================================================================
// Admin Tenant Routes Handler
// ============================================================================

export class AdminTenantRoutes {
  private tenantService: TenantService;

  constructor(db: D1Database) {
    this.tenantService = new TenantService(db);
  }

  /**
   * Route handler for admin tenant endpoints
   */
  async handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    // Match tenant management routes
    if (path === '/admin/tenants' && method === 'GET') {
      return this.listTenants(request, env, ctx);
    }
    if (path === '/admin/tenants' && method === 'POST') {
      return this.createTenant(request, env, ctx);
    }
    if (path.match(/^\/admin\/tenants\/[^/]+$/) && method === 'GET') {
      const tenantId = path.split('/').pop()!;
      return this.getTenant(tenantId, request, env, ctx);
    }
    if (path.match(/^\/admin\/tenants\/[^/]+$/) && method === 'PUT') {
      const tenantId = path.split('/').pop()!;
      return this.updateTenant(tenantId, request, env, ctx);
    }
    if (path.match(/^\/admin\/tenants\/[^/]+$/) && method === 'DELETE') {
      const tenantId = path.split('/').pop()!;
      return this.deleteTenant(tenantId, request, env, ctx);
    }

    // Tenant admin management routes
    if (path.match(/^\/admin\/tenants\/[^/]+\/admins$/) && method === 'GET') {
      const tenantId = path.split('/')[3];
      return this.listTenantAdmins(tenantId, request, env, ctx);
    }
    if (path.match(/^\/admin\/tenants\/[^/]+\/admins$/) && method === 'POST') {
      const tenantId = path.split('/')[3];
      return this.addTenantAdmin(tenantId, request, env, ctx);
    }
    if (path.match(/^\/admin\/tenants\/[^/]+\/admins\/[^/]+$/) && method === 'DELETE') {
      const parts = path.split('/');
      const tenantId = parts[3];
      const userId = parts[5];
      return this.removeTenantAdmin(tenantId, userId, request, env, ctx);
    }

    return new Response('Not Found', { status: 404 });
  }

  /**
   * GET /admin/tenants - List all tenants
   */
  private async listTenants(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      // Verify admin authentication
      const _authContext = await verifyAdminAuth(request, env);

      // Parse query parameters
      const url = new URL(request.url);
      const queryParams = Object.fromEntries(url.searchParams);
      const validated = v.parse(TenantQuerySchema, queryParams);

      // Get tenants
      const result = await this.tenantService.listTenants({
        status: validated.status,
        limit: validated.limit,
        offset: validated.offset,
      });

      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to list tenants', { error });
      return createAuthErrorResponse('Failed to list tenants', 500);
    }
  }

  /**
   * POST /admin/tenants - Create new tenant
   */
  private async createTenant(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      // Verify admin authentication
      const authContext = await verifyAdminAuth(request, env);

      // Rate limiting
      const clientIP = getClientIP(request);
      const rateLimitKey = `admin:tenant:create:${clientIP}`;
      const rateLimit = await checkRateLimit(
        env.AUTH_STORAGE,
        rateLimitKey,
        5, // 5 tenants per hour
        3600
      );

      if (!rateLimit.allowed) {
        return createAuthErrorResponse('Rate limit exceeded. Please try again later.', 429);
      }

      // Parse and validate request body
      const body = await request.json();
      const validated = v.parse(CreateTenantSchema, body);

      // Create tenant (use id or fall back to slug for backwards compatibility)
      const tenant = await this.tenantService.createTenant({
        id: validated.id || validated.slug,
        name: validated.name,
        domain: validated.domain,
        settings: validated.settings,
        branding: validated.branding,
        createdBy: authContext.user.id,
      });

      // Emit audit event
      await emitAuditEvent({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.TENANT_CREATED,
        severity: AuditEventSeverity.INFO,
        userId: authContext.user.id,
        ipAddress: clientIP,
        userAgent: request.headers.get('User-Agent'),
        requestId: null,
        metadata: {
          tenantId: tenant.id,
          tenantName: tenant.name,
          tenantSlug: tenant.slug,
        },
        success: true,
        errorMessage: null,
      });

      logger.info('Tenant created', {
        tenantId: tenant.id,
        tenantName: tenant.name,
        createdBy: authContext.user.id,
      });

      return new Response(JSON.stringify(tenant), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to create tenant', { error });
      const message = error instanceof Error ? error.message : 'Failed to create tenant';
      return createAuthErrorResponse(message, 400);
    }
  }

  /**
   * GET /admin/tenants/:id - Get tenant details
   */
  private async getTenant(tenantId: string, request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      // Verify admin authentication
      await verifyAdminAuth(request, env);

      const tenant = await this.tenantService.getTenantById(tenantId);
      if (!tenant) {
        return createAuthErrorResponse('Tenant not found', 404);
      }

      return new Response(JSON.stringify(tenant), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to get tenant', { error });
      return createAuthErrorResponse('Failed to get tenant', 500);
    }
  }

  /**
   * PUT /admin/tenants/:id - Update tenant
   */
  private async updateTenant(tenantId: string, request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      // Verify admin authentication
      const authContext = await verifyAdminAuth(request, env);

      // Parse and validate request body
      const body = await request.json();
      const validated = v.parse(UpdateTenantSchema, body);

      // Build branding object if any branding fields are provided
      const branding = (validated.logoUrl !== undefined ||
        validated.faviconUrl !== undefined ||
        validated.primaryColor !== undefined ||
        validated.secondaryColor !== undefined ||
        validated.backgroundColor !== undefined ||
        validated.fontFamily !== undefined) ? {
        logoUrl: validated.logoUrl,
        faviconUrl: validated.faviconUrl,
        primaryColor: validated.primaryColor,
        secondaryColor: validated.secondaryColor,
        backgroundColor: validated.backgroundColor,
        fontFamily: validated.fontFamily,
      } : undefined;

      // Update tenant
      const tenant = await this.tenantService.updateTenant(tenantId, {
        name: validated.name,
        domain: validated.domain as string | undefined,
        status: validated.status,
        settings: validated.settings,
        branding: branding as Partial<TenantBranding> | undefined,
        emailFromName: validated.emailFromName,
        emailFromAddress: validated.emailFromAddress,
        emailReplyTo: validated.emailReplyTo,
        maxUsers: validated.maxUsers,
        maxClients: validated.maxClients,
      });

      // Emit audit event
      const clientIP = getClientIP(request);
      await emitAuditEvent({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.TENANT_UPDATED,
        severity: AuditEventSeverity.INFO,
        userId: authContext.user.id,
        ipAddress: clientIP,
        userAgent: request.headers.get('User-Agent'),
        requestId: null,
        metadata: {
          tenantId,
          updates: Object.keys(body),
        },
        success: true,
        errorMessage: null,
      });

      logger.info('Tenant updated', {
        tenantId,
        updatedBy: authContext.user.id,
      });

      return new Response(JSON.stringify(tenant), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to update tenant', { error });
      const message = error instanceof Error ? error.message : 'Failed to update tenant';
      return createAuthErrorResponse(message, 400);
    }
  }

  /**
   * DELETE /admin/tenants/:id - Delete tenant (soft delete)
   */
  private async deleteTenant(tenantId: string, request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      // Verify admin authentication
      const authContext = await verifyAdminAuth(request, env);

      // Delete tenant
      await this.tenantService.deleteTenant(tenantId);

      // Emit audit event
      const clientIP = getClientIP(request);
      await emitAuditEvent({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.TENANT_DELETED,
        severity: AuditEventSeverity.WARNING,
        userId: authContext.user.id,
        ipAddress: clientIP,
        userAgent: request.headers.get('User-Agent'),
        requestId: null,
        metadata: { tenantId },
        success: true,
        errorMessage: null,
      });

      logger.info('Tenant deleted', {
        tenantId,
        deletedBy: authContext.user.id,
      });

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to delete tenant', { error });
      const message = error instanceof Error ? error.message : 'Failed to delete tenant';
      return createAuthErrorResponse(message, 400);
    }
  }

  /**
   * GET /admin/tenants/:id/admins - List tenant admins
   */
  private async listTenantAdmins(tenantId: string, request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      // Verify admin authentication
      await verifyAdminAuth(request, env);

      const result = await env.AUTH_DB.prepare(`
        SELECT ta.*, u.email as user_email
        FROM tenant_admins ta
        JOIN users u ON ta.user_id = u.id
        WHERE ta.tenant_id = ?
        ORDER BY ta.role, ta.granted_at
      `).bind(tenantId).all();

      const admins = (result.results || []).map(r => ({
        id: r.id,
        userId: r.user_id,
        email: r.user_email,
        role: r.role,
        grantedAt: r.granted_at,
      }));

      return new Response(JSON.stringify({ admins }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to list tenant admins', { error });
      return createAuthErrorResponse('Failed to list tenant admins', 500);
    }
  }

  /**
   * POST /admin/tenants/:id/admins - Add tenant admin
   */
  private async addTenantAdmin(tenantId: string, request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      // Verify admin authentication
      const authContext = await verifyAdminAuth(request, env);

      // Parse and validate request body
      const body = await request.json();
      const validated = v.parse(AddTenantAdminSchema, body);

      // Add tenant admin
      const admin = await this.tenantService.addTenantAdmin({
        tenantId,
        userId: validated.userId,
        role: validated.role,
        grantedBy: authContext.user.id,
      });

      logger.info('Tenant admin added', {
        tenantId,
        userId: validated.userId,
        role: validated.role,
        grantedBy: authContext.user.id,
      });

      return new Response(JSON.stringify(admin), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to add tenant admin', { error });
      const message = error instanceof Error ? error.message : 'Failed to add tenant admin';
      return createAuthErrorResponse(message, 400);
    }
  }

  /**
   * DELETE /admin/tenants/:id/admins/:userId - Remove tenant admin
   */
  private async removeTenantAdmin(tenantId: string, userId: string, request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      // Verify admin authentication
      const authContext = await verifyAdminAuth(request, env);

      // Remove tenant admin
      await this.tenantService.removeTenantAdmin(tenantId, userId);

      logger.info('Tenant admin removed', {
        tenantId,
        userId,
        removedBy: authContext.user.id,
      });

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to remove tenant admin', { error });
      const message = error instanceof Error ? error.message : 'Failed to remove tenant admin';
      return createAuthErrorResponse(message, 400);
    }
  }
}
