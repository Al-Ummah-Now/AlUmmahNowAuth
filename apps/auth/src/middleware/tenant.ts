/**
 * Tenant Middleware
 *
 * Middleware to resolve tenant from request and provide tenant context.
 * Supports multiple tenant resolution strategies:
 * - Custom domain matching
 * - Subdomain extraction
 * - Query parameter (development only)
 * - Fallback to default tenant
 *
 * @module middleware/tenant
 */

import type { Context, Next } from 'hono';
import { TenantService } from '../services/tenant.service';
import type { TenantContext } from '../types/tenant';
import type { AccountSession } from '../types/sessions';

type TenantMiddlewareContext = Context<{
  Bindings: Env;
  Variables: {
    tenantContext: TenantContext;
    tenantId: string;
    activeAccount?: AccountSession | null;
  };
}>;

/**
 * Extract subdomain from host header
 *
 * @param host - Host header value (e.g., "subdomain.example.com")
 * @returns Subdomain or null
 */
function extractSubdomain(host: string): string | null {
  const parts = host.split('.');
  if (parts.length >= 3) {
    return parts[0];
  }
  return null;
}

/**
 * Middleware to resolve tenant from request
 *
 * Sets tenant context in Hono context:
 * - c.get('tenantContext'): Full tenant context with branding
 * - c.get('tenantId'): Tenant ID for queries
 *
 * Resolution order:
 * 1. Custom domain (e.g., auth.clientcorp.com)
 * 2. Subdomain (e.g., clientcorp.auth.example.com)
 * 3. Query parameter ?tenant=slug (development only)
 * 4. Default tenant (fallback)
 */
export async function resolveTenant(c: TenantMiddlewareContext, next: Next): Promise<void> {
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

  // Try to resolve from query parameter (for testing in development)
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
    isDefault: tenant.id === 'default',
  };

  c.set('tenantContext', tenantContext);
  c.set('tenantId', tenant.id);

  await next();
}

/**
 * Middleware to require tenant admin access
 *
 * Verifies that the authenticated user is an admin of the current tenant.
 * Must be used after authentication middleware.
 *
 * Returns:
 * - 401 if not authenticated
 * - 403 if not a tenant admin
 */
export async function requireTenantAdmin(c: TenantMiddlewareContext, next: Next): Promise<Response | void> {
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
}
