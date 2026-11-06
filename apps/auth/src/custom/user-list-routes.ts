/**
 * @fileoverview Custom User Listing Routes with RBAC Roles
 *
 * This module provides enhanced user listing that includes RBAC role assignments.
 * OpenAuth's built-in userApiRoutes doesn't include roles in the list response,
 * so we override GET / to provide users with their assigned roles.
 *
 * Features:
 * - Paginated user listing with roles
 * - Search by email
 * - Cursor-based pagination
 * - Role filtering support
 */

import { Hono } from 'hono';
import type { Context } from 'hono';

type UserStatus = 'active' | 'suspended' | 'deleted';

// Variables set by adminContextMiddleware
type AdminVariables = {
  tenantId: string;
  tenant: { id: string };
};

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  status: UserStatus;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

interface RoleRow {
  user_id: string;
  role_id: string;
  role_name: string;
}

/**
 * Creates a Hono router with enhanced user listing that includes roles
 */
export function userListRoutes(db: D1Database) {
  const app = new Hono<{ Variables: AdminVariables }>();

  /**
   * GET / - List users with their RBAC roles
   */
  app.get('/', async (c) => {
    try {
      // Get tenant from context (set by adminContextMiddleware)
      const tenantId = c.get('tenantId') || 'default';

      // Parse query parameters
      const url = new URL(c.req.url);
      const status = url.searchParams.get('status') as UserStatus | null;
      const email = url.searchParams.get('email');
      const cursor = url.searchParams.get('cursor');
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
      const sortBy = url.searchParams.get('sort_by') || 'created_at';
      const sortOrder = url.searchParams.get('sort_order') || 'desc';

      // Build query conditions
      const conditions: string[] = ['tenant_id = ?', 'deleted_at IS NULL'];
      const bindings: (string | number)[] = [tenantId];

      if (status) {
        conditions.push('status = ?');
        bindings.push(status);
      }

      if (email) {
        conditions.push('email LIKE ?');
        bindings.push(`%${email.toLowerCase()}%`);
      }

      // Handle cursor-based pagination
      const validSortColumns = ['created_at', 'updated_at', 'email', 'name'];
      const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'created_at';
      const sortDir = sortOrder === 'asc' ? 'ASC' : 'DESC';

      if (cursor) {
        const cursorQuery = `SELECT ${sortColumn} FROM users WHERE tenant_id = ? AND id = ?`;
        const cursorRow = await db.prepare(cursorQuery).bind(tenantId, cursor).first<Record<string, unknown>>();

        if (cursorRow) {
          const op = sortDir === 'DESC' ? '<' : '>';
          conditions.push(
            `(${sortColumn} ${op} ? OR (${sortColumn} = ? AND id ${op} ?))`
          );
          bindings.push(cursorRow[sortColumn] as string | number, cursorRow[sortColumn] as string | number, cursor);
        }
      }

      // Query users
      const whereClause = conditions.join(' AND ');
      const usersQuery = `
        SELECT id, email, name, status, metadata, created_at, updated_at
        FROM users
        WHERE ${whereClause}
        ORDER BY ${sortColumn} ${sortDir}, id ${sortDir}
        LIMIT ?
      `;
      bindings.push(limit + 1);

      const usersResult = await db.prepare(usersQuery).bind(...bindings).all<UserRow>();
      const userRows = usersResult.results || [];
      const hasMore = userRows.length > limit;

      if (hasMore) userRows.pop();

      // Get total count
      const countBindings = bindings.slice(0, -1); // Remove limit
      const countConditions = conditions.slice(); // Copy conditions without cursor
      const countQuery = `
        SELECT COUNT(*) as count FROM users
        WHERE tenant_id = ? AND deleted_at IS NULL
        ${status ? 'AND status = ?' : ''}
        ${email ? 'AND email LIKE ?' : ''}
      `;
      const countBindingsSimple: (string | number)[] = [tenantId];
      if (status) countBindingsSimple.push(status);
      if (email) countBindingsSimple.push(`%${email.toLowerCase()}%`);

      const countResult = await db.prepare(countQuery).bind(...countBindingsSimple).first<{ count: number }>();
      const totalCount = countResult?.count || 0;

      // Get user IDs for role lookup
      const userIds = userRows.map(u => u.id);

      // Fetch roles for all users in batched queries to avoid SQL variable limits
      // SQLite/D1 has a limit of ~999 variables per query
      const rolesByUser: Map<string, Array<{ id: string; name: string }>> = new Map();
      const BATCH_SIZE = 50; // Keep batches small to stay well under limit

      if (userIds.length > 0) {
        // Process user IDs in batches
        for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
          const batch = userIds.slice(i, i + BATCH_SIZE);
          const placeholders = batch.map(() => '?').join(',');
          const rolesQuery = `
            SELECT ur.user_id, r.id as role_id, r.name as role_name
            FROM rbac_user_roles ur
            JOIN rbac_roles r ON ur.role_id = r.id
            WHERE ur.user_id IN (${placeholders})
              AND ur.tenant_id = ?
              AND (ur.expires_at IS NULL OR ur.expires_at > unixepoch() * 1000)
          `;
          const rolesResult = await db.prepare(rolesQuery).bind(...batch, tenantId).all<RoleRow>();

          for (const row of rolesResult.results || []) {
            const existing = rolesByUser.get(row.user_id) || [];
            existing.push({ id: row.role_id, name: row.role_name });
            rolesByUser.set(row.user_id, existing);
          }
        }
      }

      // Build response
      const users = userRows.map(row => {
        let parsedMetadata = null;
        if (row.metadata) {
          try {
            parsedMetadata = JSON.parse(row.metadata);
          } catch (e) {
            console.warn(`Failed to parse metadata for user ${row.id}:`, e);
          }
        }
        return {
          id: row.id,
          email: row.email,
          name: row.name,
          status: row.status,
          metadata: parsedMetadata,
          created_at: row.created_at,
          updated_at: row.updated_at,
          roles: rolesByUser.get(row.id) || [],
        };
      });

      const nextCursor = hasMore && userRows.length > 0 ? userRows[userRows.length - 1].id : null;

      return c.json({
        users,
        total_count: totalCount,
        next_cursor: nextCursor,
        has_more: hasMore,
        pagination: {
          cursor: nextCursor,
          nextCursor: nextCursor,
          limit,
          hasMore,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : '';
      console.error('Failed to list users with roles:', errorMessage);
      console.error('Stack trace:', errorStack);
      return c.json(
        { error: 'server_error', error_description: 'Failed to list users' },
        500
      );
    }
  });

  return app;
}
