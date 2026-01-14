/**
 * Tenant-Scoped Query Utilities
 *
 * SECURITY WARNING: Never use string interpolation for tenant IDs in SQL queries.
 * Always use parameterized queries to prevent SQL injection attacks.
 *
 * The tenantId often comes from HTTP Host header resolution, making it an
 * untrusted input that could be manipulated by attackers.
 *
 * BAD (SQL Injection vulnerable):
 *   `SELECT * FROM users WHERE tenant_id = '${tenantId}'`
 *
 * GOOD (Parameterized):
 *   db.prepare(`SELECT * FROM users WHERE tenant_id = ?`).bind(tenantId)
 *
 * @module utils/tenant-query
 */

/**
 * Tenant-aware query builder with parameterized queries
 *
 * All methods return query strings with ? placeholders and separate bindings.
 * This ensures tenant IDs are never interpolated into SQL strings.
 */
export class TenantQueryBuilder {
  constructor(private tenantId: string) {
    // Validate tenantId format to prevent injection via other vectors
    if (!/^[a-z0-9_-]+$/i.test(tenantId)) {
      throw new Error('Invalid tenant ID format');
    }
  }

  /**
   * Get tenant binding for use in parameterized queries
   *
   * @returns Tenant ID for query binding
   */
  getTenantBinding(): string {
    return this.tenantId;
  }

  /**
   * User queries with tenant isolation
   *
   * @returns Query strings and bindings
   */
  users() {
    return {
      select: `SELECT * FROM users WHERE tenant_id = ?`,
      count: `SELECT COUNT(*) as count FROM users WHERE tenant_id = ?`,
      bindings: [this.tenantId],
    };
  }

  /**
   * OAuth client queries with tenant isolation
   *
   * @returns Query strings and bindings
   */
  clients() {
    return {
      select: `SELECT * FROM oauth_clients WHERE tenant_id = ?`,
      count: `SELECT COUNT(*) as count FROM oauth_clients WHERE tenant_id = ?`,
      bindings: [this.tenantId],
    };
  }

  /**
   * Role queries with tenant isolation
   *
   * Includes both system roles (tenant_id IS NULL) and tenant-specific roles.
   *
   * @returns Query strings and bindings
   */
  roles() {
    return {
      // Include system roles (tenant_id IS NULL AND is_system = 1) and tenant-specific roles
      select: `SELECT * FROM rbac_roles WHERE tenant_id = ? OR (tenant_id IS NULL AND is_system = 1)`,
      bindings: [this.tenantId],
    };
  }

  /**
   * Audit event queries with tenant isolation
   *
   * @returns Query strings and bindings
   */
  auditEvents() {
    return {
      select: `SELECT * FROM audit_events WHERE tenant_id = ?`,
      count: `SELECT COUNT(*) as count FROM audit_events WHERE tenant_id = ?`,
      bindings: [this.tenantId],
    };
  }
}

/**
 * Helper function to create a tenant query builder
 *
 * @param tenantId - Tenant ID
 * @returns TenantQueryBuilder instance
 */
export function createTenantQuery(tenantId: string): TenantQueryBuilder {
  return new TenantQueryBuilder(tenantId);
}
