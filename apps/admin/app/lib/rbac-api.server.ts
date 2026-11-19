/**
 * RBAC API Client for Admin App
 *
 * This module provides typed API client functions for interacting with the
 * auth service's RBAC endpoints. Every call is M2M (the admin client's token), acting as the
 * signed-in admin, like admin-api.server: Auth's /admin/* routes take no cookies, so the
 * cookie-forwarding calls this file used to make were refused and the role page answered 404
 * (QA E2E color-mode.spec, 2026-11-18).
 */

import { m2mFetch, type ActingUser } from './admin-api.server';
import { getAuthenticatedUser } from './auth.server';

/**
 * Permission definition following resource:action format
 */
export interface Permission {
  id: string;
  name: string; // Format: resource:action (e.g., "users:read")
  resource: string;
  action: string;
  description?: string;
  is_system: boolean;
  metadata?: Record<string, string | number | boolean | null>;
  created_at: number;
}

/**
 * Role definition
 */
export interface Role {
  id: string;
  name: string;
  description?: string;
  is_system_role: boolean;
  metadata?: Record<string, string | number | boolean | null>;
  created_at: number;
  updated_at: number;
  created_by?: string;
  updated_by?: string;
}

/**
 * Role with permissions included
 */
export interface RoleWithPermissions extends Role {
  permissions: Permission[];
}

/**
 * User-Role assignment with role details
 */
export interface UserRoleWithDetails {
  id: string;
  userId: string;
  roleId: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt?: string;
  isActive: boolean;
  role: {
    id: string;
    name: string;
    description?: string;
    is_system_role: boolean;
  };
}

/**
 * Role creation/update data
 */
export interface RoleData {
  name: string;
  description?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

/**
 * Generic error response
 */
export interface ErrorResponse {
  error: string;
}

/**
 * Success response
 */
export interface SuccessResponse {
  success: true;
}

/**
 * Helper to make authenticated requests to the auth service
 */
async function authRequest<T>(
  request: Request,
  env: { AUTH_SERVER_URL?: string },
  endpoint: string,
  options: RequestInit = {}
): Promise<T | ErrorResponse> {
  try {
    const session = await getAuthenticatedUser(request, env as never);
    if (!session?.user?.id) return { error: 'Not signed in' };
    const acting: ActingUser = { id: session.user.id, email: session.user.email ?? '', roles: session.user.roles ?? [] };
    const headers = new Headers(options.headers);
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await m2mFetch(env as never, endpoint, acting, { ...options, headers }, request);

    if (!response.ok) {
      const errorText = await response.text();
      try {
        const errorJson = JSON.parse(errorText);
        return { error: errorJson.error || errorJson.message || 'Request failed' };
      } catch {
        return { error: errorText || `Request failed with status ${response.status}` };
      }
    }

    const data = await response.json();
    return data as T;
  } catch (error) {
    console.error('Auth request failed:', error);
    return {
      error: error instanceof Error ? error.message : 'Request failed',
    };
  }
}

/**
 * Type guard to check if response is an error
 */
export function isErrorResponse(response: unknown): response is ErrorResponse {
  return typeof response === 'object' && response !== null && 'error' in response && typeof (response as ErrorResponse).error === 'string';
}

// ============================================================================
// ADMIN ROLE MANAGEMENT APIs
// ============================================================================

/**
 * GET /admin/rbac/roles - List all roles
 */
export async function getAllRoles(
  request: Request,
  env: { AUTH_SERVER_URL?: string }
): Promise<Role[] | ErrorResponse> {
  return authRequest<Role[]>(request, env, '/admin/roles', {
    method: 'GET',
  });
}

/**
 * POST /admin/rbac/roles - Create a new role
 */
export async function createRole(
  request: Request,
  env: { AUTH_SERVER_URL?: string },
  roleData: RoleData
): Promise<Role | ErrorResponse> {
  return authRequest<Role>(request, env, '/admin/roles', {
    method: 'POST',
    body: JSON.stringify(roleData),
  });
}

/**
 * GET /admin/rbac/roles/:id - Get role details with permissions
 */
export async function getRoleById(
  request: Request,
  env: { AUTH_SERVER_URL?: string },
  roleId: string
): Promise<RoleWithPermissions | ErrorResponse> {
  // Auth answers { role, permissions }; the page takes the role with its permissions
  const res = await authRequest<{ role?: Role; permissions?: Permission[] } & Partial<RoleWithPermissions>>(
    request,
    env,
    `/admin/roles/${encodeURIComponent(roleId)}`,
    { method: 'GET' }
  );
  if (isErrorResponse(res)) return res;
  if (res.role) return { ...res.role, permissions: res.permissions ?? [] };
  return { ...(res as RoleWithPermissions), permissions: res.permissions ?? [] };
}

/**
 * PATCH /admin/rbac/roles/:id - Update a role
 */
export async function updateRole(
  request: Request,
  env: { AUTH_SERVER_URL?: string },
  roleId: string,
  updates: Partial<RoleData>
): Promise<Role | ErrorResponse> {
  return authRequest<Role>(
    request,
    env,
    `/admin/roles/${encodeURIComponent(roleId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }
  );
}

/**
 * DELETE /admin/roles/:id - Soft delete (restorable from Recently deleted for 30 days)
 */
export async function deleteRole(
  request: Request,
  env: { AUTH_SERVER_URL?: string },
  roleId: string,
  reason?: string
): Promise<SuccessResponse | ErrorResponse> {
  return authRequest<SuccessResponse>(
    request,
    env,
    `/admin/roles/${encodeURIComponent(roleId)}`,
    {
      method: 'DELETE',
      body: JSON.stringify({ reason: reason || undefined }),
    }
  );
}

/**
 * POST /admin/rbac/roles/:id/permissions - Grant permission to a role
 */
export async function grantPermissionToRole(
  request: Request,
  env: { AUTH_SERVER_URL?: string },
  roleId: string,
  permissionId: string
): Promise<SuccessResponse | ErrorResponse> {
  return authRequest<SuccessResponse>(
    request,
    env,
    `/admin/roles/${encodeURIComponent(roleId)}/permissions`,
    {
      method: 'POST',
      body: JSON.stringify({ permissionId }),
    }
  );
}

/**
 * DELETE /admin/rbac/roles/:id/permissions/:permissionId - Revoke permission from a role
 */
export async function revokePermissionFromRole(
  request: Request,
  env: { AUTH_SERVER_URL?: string },
  roleId: string,
  permissionId: string
): Promise<SuccessResponse | ErrorResponse> {
  return authRequest<SuccessResponse>(
    request,
    env,
    `/admin/roles/${encodeURIComponent(roleId)}/permissions/${encodeURIComponent(permissionId)}`,
    {
      method: 'DELETE',
    }
  );
}

// ============================================================================
// USER ROLE MANAGEMENT APIs
// ============================================================================

/**
 * GET /api/users/:id/roles - Get user's assigned roles
 */
export async function getUserRoles(
  request: Request,
  env: { AUTH_SERVER_URL?: string },
  userId: string
): Promise<UserRoleWithDetails[] | ErrorResponse> {
  return authRequest<UserRoleWithDetails[]>(
    request,
    env,
    `/api/users/${encodeURIComponent(userId)}/roles`,
    {
      method: 'GET',
    }
  );
}

/**
 * POST /admin/users/:id/roles - Assign role to a user
 * Note: The user-role-routes are mounted on adminUserApp which handles /admin/users/*
 */
export async function assignRoleToUser(
  request: Request,
  env: { AUTH_SERVER_URL?: string },
  userId: string,
  roleId: string,
  expiresAt?: string
): Promise<SuccessResponse | ErrorResponse> {
  const body: { roleId: string; expiresAt?: string } = { roleId };
  if (expiresAt) {
    body.expiresAt = expiresAt;
  }

  return authRequest<SuccessResponse>(
    request,
    env,
    `/admin/users/${encodeURIComponent(userId)}/roles`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  );
}

/**
 * DELETE /admin/users/:id/roles/:roleId - Remove role from a user
 */
export async function removeRoleFromUser(
  request: Request,
  env: { AUTH_SERVER_URL?: string },
  userId: string,
  roleId: string
): Promise<SuccessResponse | ErrorResponse> {
  return authRequest<SuccessResponse>(
    request,
    env,
    `/admin/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
    {
      method: 'DELETE',
    }
  );
}

// ============================================================================
// PERMISSION MANAGEMENT APIs
// ============================================================================

/**
 * GET /api/permissions - List all permissions
 */
export async function getAllPermissions(
  request: Request,
  env: { AUTH_SERVER_URL?: string }
): Promise<{ total: number; permissions: Record<string, Permission[]> } | ErrorResponse> {
  return authRequest<{ total: number; permissions: Record<string, Permission[]> }>(
    request,
    env,
    '/admin/permissions',
    {
      method: 'GET',
    }
  );
}

/**
 * GET /api/users/:id/permissions - Get user's effective permissions
 */
export async function getUserPermissions(
  request: Request,
  env: { AUTH_SERVER_URL?: string },
  userId: string
): Promise<{
  userId: string;
  roles: { id: string; name: string; description?: string }[];
  permissions: string[];
  cachedAt: string;
  expiresAt: string;
} | ErrorResponse> {
  return authRequest<{
    userId: string;
    roles: { id: string; name: string; description?: string }[];
    permissions: string[];
    cachedAt: string;
    expiresAt: string;
  }>(
    request,
    env,
    `/api/users/${encodeURIComponent(userId)}/permissions`,
    {
      method: 'GET',
    }
  );
}

/**
 * GET /admin/rbac/roles/:id/users - Get users assigned to a role
 */
export async function getRoleUsers(
  request: Request,
  env: { AUTH_SERVER_URL?: string },
  roleId: string
): Promise<Array<{
  id: string;
  email: string;
  assigned_at: number;
  assigned_by: string | null;
}> | ErrorResponse> {
  return authRequest<Array<{
    id: string;
    email: string;
    assigned_at: number;
    assigned_by: string | null;
  }>>(
    request,
    env,
    `/admin/roles/${encodeURIComponent(roleId)}/users`,
    {
      method: 'GET',
    }
  );
}

/**
 * DELETE /admin/rbac/roles/:roleId/users/:userId - Remove user from role
 */
export async function removeUserFromRole(
  request: Request,
  env: { AUTH_SERVER_URL?: string },
  roleId: string,
  userId: string
): Promise<SuccessResponse | ErrorResponse> {
  return authRequest<SuccessResponse>(
    request,
    env,
    `/admin/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
    {
      method: 'DELETE',
    }
  );
}
