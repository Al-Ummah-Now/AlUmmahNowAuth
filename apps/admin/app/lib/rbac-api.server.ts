/**
 * RBAC API Client for Admin App
 *
 * This module provides typed API client functions for interacting with the
 * auth service's RBAC endpoints. All functions forward authentication cookies
 * and handle errors appropriately.
 */

import { getAuthServerUrl } from './config';

/**
 * Permission definition following resource:action:scope format
 */
export interface Permission {
  id: string;
  name: string; // Format: resource:action:scope (e.g., "users:read:all")
  resource: string;
  action: string;
  scope: string;
  description?: string;
  is_system: boolean;
  metadata?: Record<string, string | number | boolean | null>;
  created_at: string;
}

/**
 * Role definition with hierarchical support
 */
export interface Role {
  id: string;
  name: string;
  description?: string;
  parent_role_id?: string;
  is_system: boolean;
  metadata?: Record<string, string | number | boolean | null>;
  created_at: string;
  updated_at: string;
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
    is_system: boolean;
  };
}

/**
 * Role creation/update data
 */
export interface RoleData {
  name: string;
  description?: string;
  parent_role_id?: string;
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
    const authServerUrl = getAuthServerUrl(request, env);
    const url = `${authServerUrl}${endpoint}`;

    // Forward cookies from the original request
    const cookies = request.headers.get('Cookie');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Merge any provided headers
    if (options.headers) {
      const providedHeaders = options.headers;
      if (providedHeaders instanceof Headers) {
        providedHeaders.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(providedHeaders)) {
        providedHeaders.forEach(([key, value]) => {
          headers[key] = value;
        });
      } else {
        Object.assign(headers, providedHeaders);
      }
    }

    if (cookies) {
      headers['Cookie'] = cookies;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

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
 * GET /admin/roles - List all roles
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
 * POST /admin/roles - Create a new role
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
 * GET /admin/roles/:id - Get role details with permissions
 */
export async function getRoleById(
  request: Request,
  env: { AUTH_SERVER_URL?: string },
  roleId: string
): Promise<RoleWithPermissions | ErrorResponse> {
  return authRequest<RoleWithPermissions>(
    request,
    env,
    `/admin/roles/${encodeURIComponent(roleId)}`,
    {
      method: 'GET',
    }
  );
}

/**
 * PUT /admin/roles/:id - Update a role
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
      method: 'PUT',
      body: JSON.stringify(updates),
    }
  );
}

/**
 * DELETE /admin/roles/:id - Delete a role
 */
export async function deleteRole(
  request: Request,
  env: { AUTH_SERVER_URL?: string },
  roleId: string
): Promise<SuccessResponse | ErrorResponse> {
  return authRequest<SuccessResponse>(
    request,
    env,
    `/admin/roles/${encodeURIComponent(roleId)}`,
    {
      method: 'DELETE',
    }
  );
}

/**
 * POST /admin/roles/:id/permissions - Grant permission to a role
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
 * DELETE /admin/roles/:id/permissions/:permissionId - Revoke permission from a role
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
 * POST /api/users/:id/roles - Assign role to a user
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
    `/api/users/${encodeURIComponent(userId)}/roles`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  );
}

/**
 * DELETE /api/users/:id/roles/:roleId - Remove role from a user
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
    `/api/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
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
    '/api/permissions',
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
