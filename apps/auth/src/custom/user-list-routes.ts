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
 * - System accounts (security/system-accounts.ts) are left out of the list,
 *   search and counts; `?system=only` is the super admin's read-only view of
 *   exactly those accounts, with every role row and status ("can't sign in").
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { SYSTEM_USER_IDS_SQL } from '../security/system-accounts';

type UserStatus = 'active' | 'suspended' | 'deleted';

// Variables set by adminContextMiddleware
type AdminVariables = {
  tenantId: string;
  tenant: { id: string };
  /** Set by requireAdmin: the acting admin and their roles (from D1) */
  adminUser?: { userId: string; email: string; roles: string[] } | null;
};

/** 'Super Admin' / 'super_admin' / 'super-admin' */
export function isSuperAdmin(roles: readonly string[] | undefined): boolean {
  return (roles ?? []).some((r) => r.trim().toLowerCase().replace(/[\s-]+/g, '_') === 'super_admin');
}

interface SystemRoleRow {
  user_id: string;
  role_id: string;
  role_name: string | null;
  assigned_at: number | null;
  assigned_by: string | null;
  expires_at: number | null;
}

/**
 * GET /?system=only: the system accounts (SYSTEM_USER_IDS, primary-key reads only)
 * with their status and every role row, expired or not, so a role that should
 * never be there is seen. Read-only; super admins only.
 */
async function listSystemAccounts(c: Context<{ Variables: AdminVariables }>, db: D1Database) {
  if (!isSuperAdmin(c.get('adminUser')?.roles)) {
    return c.json({ error: 'forbidden', error_description: 'Super admins only' }, 403);
  }
  const users = await db
    .prepare(`SELECT id, email, name, status, metadata, created_at, updated_at, deleted_at FROM users WHERE id IN (${SYSTEM_USER_IDS_SQL}) ORDER BY id`)
    .all<UserRow & { deleted_at: number | null }>();
  const roles = await db
    .prepare(
      `SELECT ur.user_id, ur.role_id, r.name AS role_name, ur.assigned_at, ur.assigned_by, ur.expires_at
       FROM rbac_user_roles ur LEFT JOIN rbac_roles r ON r.id = ur.role_id
       WHERE ur.user_id IN (${SYSTEM_USER_IDS_SQL})`
    )
    .all<SystemRoleRow>();
  const rows = users.results ?? [];
  return c.json({
    users: rows.map((row) => {
      let metadata: unknown = null;
      try {
        metadata = row.metadata ? JSON.parse(row.metadata) : null;
      } catch {
        metadata = null;
      }
      return {
        id: row.id,
        email: row.email,
        name: row.name,
        status: row.status,
        metadata,
        created_at: row.created_at,
        updated_at: row.updated_at,
        deleted_at: row.deleted_at ?? null,
        system: true,
        can_sign_in: false,
        roles: (roles.results ?? [])
          .filter((r) => r.user_id === row.id)
          .map((r) => ({ id: r.role_id, name: r.role_name ?? r.role_id, assigned_at: r.assigned_at, assigned_by: r.assigned_by, expires_at: r.expires_at })),
      };
    }),
    total_count: rows.length,
    next_cursor: null,
    has_more: false,
    pagination: { cursor: null, nextCursor: null, limit: rows.length, hasMore: false },
  });
}

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

/** The unfiltered live-user count per tenant, per isolate (a dashboard figure, not a ledger). */
const TOTAL_TTL_MS = 5 * 60_000; // each miss reads every live user (48k rows on QA)
const totals = new Map<string, { at: number; count: number }>();

function cachedTotal(tenantId: string): number | undefined {
  const hit = totals.get(tenantId);
  return hit && Date.now() - hit.at < TOTAL_TTL_MS ? hit.count : undefined;
}

function rememberTotal(tenantId: string, count: number): void {
  totals.set(tenantId, { at: Date.now(), count });
}

/** Forget the cached totals (tests). */
export function clearUserTotals(): void {
  totals.clear();
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
      if (url.searchParams.get('system') === 'only') return await listSystemAccounts(c, db);
      const status = url.searchParams.get('status') as UserStatus | null;
      const email = url.searchParams.get('email');
      const cursor = url.searchParams.get('cursor');
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
      const sortBy = url.searchParams.get('sort_by') || 'created_at';
      const sortOrder = url.searchParams.get('sort_order') || 'desc';

      // Build query conditions
      // System accounts are never in the list (their own view: ?system=only)
      const conditions: string[] = ['tenant_id = ?', 'deleted_at IS NULL', `id NOT IN (${SYSTEM_USER_IDS_SQL})`];
      const bindings: (string | number)[] = [tenantId];

      if (status) {
        conditions.push('status = ?');
        bindings.push(status);
      }

      if (email) {
        // instr, not LIKE: D1 refuses LIKE patterns over 50 bytes, and a run account's address
        // alone is longer ("LIKE or GLOB pattern too complex", a 500 on QA)
        conditions.push('instr(lower(email), ?) > 0');
        bindings.push(email.toLowerCase());
      }

      // search: the admin's autocomplete (name, email or an exact id), wildcards in the text escaped
      const search = url.searchParams.get('search')?.trim().slice(0, 100);
      // Substring match with instr (no wildcards to escape, no D1 50-byte LIKE pattern limit)
      const searchLike = search ? search.toLowerCase() : '';
      const SEARCH_SQL = "(instr(lower(email), ?) > 0 OR instr(lower(COALESCE(name, '')), ?) > 0 OR id = ?)";
      if (search) {
        conditions.push(SEARCH_SQL);
        bindings.push(searchLike, searchLike, search);
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

      // Get total count. COUNT(*) reads every live user of the tenant (48k rows on
      // QA), so callers that don't show it pass count=none (pickers, the users page,
      // users-by-role) and get total_count null; the unfiltered total is reused for
      // a few seconds per isolate (the dashboard's "Total Users").
      const skipCount = url.searchParams.get('count') === 'none';
      const unfiltered = !status && !email && !search;
      const countQuery = `
        SELECT COUNT(*) as count FROM users
        WHERE tenant_id = ? AND deleted_at IS NULL
        ${status ? 'AND status = ?' : ''}
        ${email ? 'AND instr(lower(email), ?) > 0' : ''}
        ${search ? `AND ${SEARCH_SQL}` : ''}
      `;
      const countBindingsSimple: (string | number)[] = [tenantId];
      if (status) countBindingsSimple.push(status);
      if (email) countBindingsSimple.push(email.toLowerCase());
      if (search) countBindingsSimple.push(searchLike, searchLike, search);

      let totalCount: number | null = null;
      if (!skipCount) {
        const cached = unfiltered ? cachedTotal(tenantId) : undefined;
        if (cached !== undefined) {
          totalCount = cached;
        } else {
          // The count stays an index count; the system accounts it includes are
          // subtracted with a primary-key read of the same filter
          const [countResult, systemResult] = await Promise.all([
            db.prepare(countQuery).bind(...countBindingsSimple).first<{ count: number }>(),
            db.prepare(`${countQuery} AND id IN (${SYSTEM_USER_IDS_SQL})`).bind(...countBindingsSimple).first<{ count: number }>(),
          ]);
          totalCount = Math.max(0, (countResult?.count || 0) - (systemResult?.count || 0));
          if (unfiltered) rememberTotal(tenantId, totalCount);
        }
      }

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
