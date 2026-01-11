/**
 * Admin API Client with M2M Authentication
 *
 * This module provides typed API client functions for interacting with the
 * auth service using M2M (Machine-to-Machine) authentication via client_credentials grant.
 */

import { getAuthServerUrl } from './config';

// ============================================================================
// Type Definitions
// ============================================================================

export interface User {
  id: string;
  email: string;
  name?: string;
  created_at: number;
  password_reset_required: boolean;
  roles: Array<{
    id: string;
    name: string;
  }>;
}

export interface UserWithRoles extends User {
  roles: Array<{
    id: string;
    name: string;
    assigned_at: number;
    expires_at: number | null;
  }>;
}

export interface UserRole {
  id: string;
  name: string;
  description: string | null;
  is_system: boolean;
  assigned_at: number;
  expires_at: number | null;
  assigned_by: string;
}

/**
 * Role definition for listing all roles
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

export interface PaginatedUsers {
  users: User[];
  pagination: {
    cursor?: string;
    nextCursor?: string;
    limit: number;
    hasMore: boolean;
  };
}

export interface OAuthClient {
  id: string;
  client_id: string;
  name: string;
  allowed_grants: string[];
  redirect_uris: string[];
  scopes: string[];
  metadata: Record<string, unknown>;
  enabled: boolean;
  created_at: number;
}

export interface ErrorResponse {
  error: string;
  error_description?: string;
}

export interface SuccessResponse {
  success: true;
}

// ============================================================================
// Token Cache
// ============================================================================

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

// In-memory token cache (per-isolate in Workers)
// For production, consider using KV or Durable Objects for cross-isolate caching
let tokenCache: TokenCache | null = null;

/**
 * Get M2M access token, using cache if valid
 */
async function getAccessToken(
  env: { AUTH_SERVER_URL?: string; ADMIN_CLIENT_ID?: string; ADMIN_CLIENT_SECRET?: string },
  request?: Request
): Promise<string> {
  // Check cache
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }

  const authServerUrl = getAuthServerUrl(request, env);
  const clientId = env.ADMIN_CLIENT_ID;
  const clientSecret = env.ADMIN_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('M2M credentials not configured: ADMIN_CLIENT_ID and ADMIN_CLIENT_SECRET required');
  }

  const response = await fetch(`${authServerUrl}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'admin:users admin:roles admin:clients',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token request failed: ${errorText}`);
  }

  const data = await response.json() as {
    access_token: string;
    token_type: string;
    expires_in: number;
  };

  // Cache with 60 second buffer before expiry
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };

  return data.access_token;
}

/**
 * Clear the token cache (call on auth errors)
 */
export function clearTokenCache(): void {
  tokenCache = null;
}

// ============================================================================
// Request Helper
// ============================================================================

type ApiEnv = {
  AUTH_SERVER_URL?: string;
  ADMIN_CLIENT_ID?: string;
  ADMIN_CLIENT_SECRET?: string;
};

/**
 * Context for the acting user (the admin who initiated the request)
 */
export interface ActingUser {
  id: string;
  email: string;
  roles: string[];
}

/**
 * Make an authenticated M2M request to the auth server
 *
 * @param env - Environment with M2M credentials
 * @param endpoint - API endpoint to call
 * @param actingUser - The admin user who initiated this request (required for audit and authorization)
 * @param options - Fetch options
 * @param request - Optional request for localhost detection
 */
async function m2mRequest<T>(
  env: ApiEnv,
  endpoint: string,
  actingUser: ActingUser,
  options: RequestInit = {},
  request?: Request
): Promise<T | ErrorResponse> {
  try {
    const accessToken = await getAccessToken(env, request);
    const authServerUrl = getAuthServerUrl(request, env);
    const url = `${authServerUrl}${endpoint}`;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      // Pass acting user context for audit logging
      // NOTE: X-Acting-User-Id is REQUIRED - auth server fetches actual roles from DB
      // X-Acting-User-Email and X-Acting-User-Roles are for audit/logging only (not trusted for auth)
      'X-Acting-User-Id': actingUser.id,
      'X-Acting-User-Email': actingUser.email,
      'X-Acting-User-Roles': actingUser.roles.join(','),
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

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      // On 401, clear token cache and suggest retry
      if (response.status === 401) {
        clearTokenCache();
      }

      const errorText = await response.text();
      try {
        const errorJson = JSON.parse(errorText);
        return { error: errorJson.error || errorJson.message || 'Request failed' };
      } catch {
        return { error: errorText || `Request failed with status ${response.status}` };
      }
    }

    return await response.json() as T;
  } catch (error) {
    console.error('M2M request failed:', error);
    return {
      error: error instanceof Error ? error.message : 'Request failed',
    };
  }
}

/**
 * Type guard to check if response is an error
 */
export function isErrorResponse(response: unknown): response is ErrorResponse {
  return typeof response === 'object' && response !== null && 'error' in response;
}

// ============================================================================
// User Management APIs
// ============================================================================

/**
 * GET /admin/users - List all users with cursor-based pagination
 */
export async function listUsers(
  env: ApiEnv,
  actingUser: ActingUser,
  params?: { cursor?: string; limit?: number; search?: string; role?: string },
  request?: Request
): Promise<PaginatedUsers | ErrorResponse> {
  const searchParams = new URLSearchParams();
  if (params?.cursor) searchParams.set('cursor', params.cursor);
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.search) searchParams.set('search', params.search);
  if (params?.role) searchParams.set('role', params.role);

  const query = searchParams.toString();
  const endpoint = `/admin/users${query ? `?${query}` : ''}`;

  return m2mRequest<PaginatedUsers>(env, endpoint, actingUser, { method: 'GET' }, request);
}

/**
 * GET /admin/users/:id - Get user details with roles
 */
export async function getUser(
  env: ApiEnv,
  actingUser: ActingUser,
  userId: string
): Promise<UserWithRoles | ErrorResponse> {
  return m2mRequest<UserWithRoles>(
    env,
    `/admin/users/${encodeURIComponent(userId)}`,
    actingUser,
    { method: 'GET' }
  );
}

/**
 * POST /admin/users - Create a new user
 */
export async function createUser(
  env: ApiEnv,
  actingUser: ActingUser,
  data: { email: string; initialRole?: string; sendInvite?: boolean }
): Promise<User | ErrorResponse> {
  return m2mRequest<User>(env, '/admin/users', actingUser, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * PUT /admin/users/:id - Update user
 */
export async function updateUser(
  env: ApiEnv,
  actingUser: ActingUser,
  userId: string,
  data: { email?: string }
): Promise<User | ErrorResponse> {
  return m2mRequest<User>(
    env,
    `/admin/users/${encodeURIComponent(userId)}`,
    actingUser,
    {
      method: 'PUT',
      body: JSON.stringify(data),
    }
  );
}

/**
 * DELETE /admin/users/:id - Delete user
 */
export async function deleteUser(
  env: ApiEnv,
  actingUser: ActingUser,
  userId: string
): Promise<SuccessResponse | ErrorResponse> {
  return m2mRequest<SuccessResponse>(
    env,
    `/admin/users/${encodeURIComponent(userId)}`,
    actingUser,
    { method: 'DELETE' }
  );
}

/**
 * GET /admin/users/:id/roles - Get user's roles
 */
export async function getUserRoles(
  env: ApiEnv,
  actingUser: ActingUser,
  userId: string
): Promise<{ userId: string; roles: UserRole[] } | ErrorResponse> {
  return m2mRequest<{ userId: string; roles: UserRole[] }>(
    env,
    `/admin/users/${encodeURIComponent(userId)}/roles`,
    actingUser,
    { method: 'GET' }
  );
}


/**
 * List all available roles in the system
 */
export async function listRoles(
  env: ApiEnv,
  actingUser: ActingUser,
  request?: Request
): Promise<Role[] | ErrorResponse> {
  return m2mRequest<Role[]>(
    env,
    '/admin/roles',
    actingUser,
    { method: 'GET' },
    request
  );
}

/**
 * POST /admin/users/:id/roles - Assign role to user
 */
export async function assignUserRole(
  env: ApiEnv,
  actingUser: ActingUser,
  userId: string,
  roleId: string,
  expiresAt?: number
): Promise<SuccessResponse | ErrorResponse> {
  const body: { roleId: string; expiresAt?: number } = { roleId };
  if (expiresAt) body.expiresAt = expiresAt;

  return m2mRequest<SuccessResponse>(
    env,
    `/admin/users/${encodeURIComponent(userId)}/roles`,
    actingUser,
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  );
}

/**
 * DELETE /admin/users/:id/roles/:roleId - Remove role from user
 */
export async function removeUserRole(
  env: ApiEnv,
  actingUser: ActingUser,
  userId: string,
  roleId: string
): Promise<SuccessResponse | ErrorResponse> {
  return m2mRequest<SuccessResponse>(
    env,
    `/admin/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
    actingUser,
    { method: 'DELETE' }
  );
}

// ============================================================================
// Client Management APIs
// ============================================================================

/**
 * GET /admin/clients - List all OAuth clients
 */
export async function listClients(
  env: ApiEnv,
  actingUser: ActingUser
): Promise<{ clients: OAuthClient[] } | ErrorResponse> {
  return m2mRequest<{ clients: OAuthClient[] }>(env, '/admin/clients', actingUser, {
    method: 'GET',
  });
}

/**
 * GET /admin/clients/:clientId - Get client details
 */
export async function getClient(
  env: ApiEnv,
  actingUser: ActingUser,
  clientId: string
): Promise<OAuthClient | ErrorResponse> {
  return m2mRequest<OAuthClient>(
    env,
    `/admin/clients/${encodeURIComponent(clientId)}`,
    actingUser,
    { method: 'GET' }
  );
}

/**
 * Response from createClient including generated credentials
 */
export interface CreateClientResponse extends OAuthClient {
  client_secret: string;
  warning: string;
}

/**
 * POST /admin/clients - Create OAuth client
 *
 * The backend uses OpenAuth ClientService which auto-generates:
 * - client_id (UUID)
 * - client_secret (for confidential clients)
 */
export async function createClient(
  env: ApiEnv,
  actingUser: ActingUser,
  data: {
    name: string;
    grant_types?: string[];
    scopes?: string[];
    redirect_uris?: string[];
    metadata?: Record<string, unknown>;
    enabled?: boolean;
  }
): Promise<CreateClientResponse | ErrorResponse> {
  return m2mRequest<CreateClientResponse>(
    env,
    '/admin/clients',
    actingUser,
    {
      method: 'POST',
      body: JSON.stringify(data),
    }
  );
}

/**
 * PATCH /admin/clients/:clientId - Update OAuth client
 *
 * Uses PATCH method to match OpenAuth's clientAdminRoutes API.
 */
export async function updateClient(
  env: ApiEnv,
  actingUser: ActingUser,
  clientId: string,
  data: Partial<{
    name: string;
    grant_types: string[];
    scopes: string[];
    redirect_uris: string[];
    metadata: Record<string, unknown>;
    enabled: boolean;
  }>
): Promise<OAuthClient | ErrorResponse> {
  return m2mRequest<OAuthClient>(
    env,
    `/admin/clients/${encodeURIComponent(clientId)}`,
    actingUser,
    {
      method: 'PATCH',
      body: JSON.stringify(data),
    }
  );
}

/**
 * DELETE /admin/clients/:clientId - Delete OAuth client
 */
export async function deleteClient(
  env: ApiEnv,
  actingUser: ActingUser,
  clientId: string
): Promise<SuccessResponse | ErrorResponse> {
  return m2mRequest<SuccessResponse>(
    env,
    `/admin/clients/${encodeURIComponent(clientId)}`,
    actingUser,
    { method: 'DELETE' }
  );
}

/**
 * POST /admin/clients/:clientId/rotate - Rotate client secret
 *
 * Uses /rotate path to match OpenAuth's clientAdminRoutes API.
 */
export async function rotateClientSecret(
  env: ApiEnv,
  actingUser: ActingUser,
  clientId: string
): Promise<{ client_secret: string } | ErrorResponse> {
  return m2mRequest<{ client_secret: string }>(
    env,
    `/admin/clients/${encodeURIComponent(clientId)}/rotate`,
    actingUser,
    { method: 'POST' }
  );
}

// ============================================================================
// Session Management APIs
// ============================================================================

export interface Session {
  id: string;
  userId: string;
  email: string;
  authenticatedAt: number;
  lastUsed: number;
  isActive: boolean;
  device: {
    ipAddress: string;
    userAgent: string;
  };
  lastActivity: number;
}

export interface SessionsResponse {
  sessions: Session[];
  total: number;
  limit: number;
  offset: number;
}

export interface SessionStats {
  totalSessions: number;
  activeSessions: number;
  loginsLast24h: number;
  uniqueUsers: number;
}

export interface SuspiciousActivity {
  multipleIPsInShortTime: Array<{
    userId: string;
    email: string;
    ipCount: number;
    ipAddresses: string[];
  }>;
  failedThenSuccessfulLogins: Array<{
    userId: string;
    email: string;
    failedAttempts: number;
    lastFailure: number;
  }>;
}

/**
 * GET /admin/sessions - List all sessions with filtering
 */
export async function listSessions(
  env: ApiEnv,
  actingUser: ActingUser,
  params?: { limit?: number; offset?: number; ip_address?: string; user_id?: string }
): Promise<SessionsResponse | ErrorResponse> {
  const searchParams = new URLSearchParams();
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.offset) searchParams.set('offset', String(params.offset));
  if (params?.ip_address) searchParams.set('ip_address', params.ip_address);
  if (params?.user_id) searchParams.set('user_id', params.user_id);

  const query = searchParams.toString();
  const endpoint = `/admin/sessions${query ? `?${query}` : ''}`;

  return m2mRequest<SessionsResponse>(env, endpoint, actingUser, { method: 'GET' });
}

/**
 * GET /admin/sessions/stats - Get session statistics
 */
export async function getSessionStats(
  env: ApiEnv,
  actingUser: ActingUser
): Promise<SessionStats | ErrorResponse> {
  return m2mRequest<SessionStats>(env, '/admin/sessions/stats', actingUser, { method: 'GET' });
}

/**
 * GET /admin/sessions/suspicious - Get suspicious session activity
 */
export async function getSuspiciousActivity(
  env: ApiEnv,
  actingUser: ActingUser
): Promise<SuspiciousActivity | ErrorResponse> {
  return m2mRequest<SuspiciousActivity>(env, '/admin/sessions/suspicious', actingUser, { method: 'GET' });
}

/**
 * DELETE /admin/users/:userId/sessions/:sessionId - Terminate a specific session
 */
export async function terminateSession(
  env: ApiEnv,
  actingUser: ActingUser,
  userId: string,
  sessionId: string
): Promise<SuccessResponse | ErrorResponse> {
  return m2mRequest<SuccessResponse>(
    env,
    `/admin/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}`,
    actingUser,
    { method: 'DELETE' }
  );
}

/**
 * DELETE /admin/users/:userId/sessions - Terminate all sessions for a user
 */
export async function terminateAllUserSessions(
  env: ApiEnv,
  actingUser: ActingUser,
  userId: string
): Promise<SuccessResponse | ErrorResponse> {
  return m2mRequest<SuccessResponse>(
    env,
    `/admin/users/${encodeURIComponent(userId)}/sessions`,
    actingUser,
    { method: 'DELETE' }
  );
}

// ============================================================================
// Stats APIs (Dashboard)
// ============================================================================

export interface UserStats {
  totalUsers: number;
  adminUsers: number;
}

export interface RoleStats {
  totalRoles: number;
  systemRoles: number;
  customRoles: number;
}

export interface UsersByRole {
  name: string;
  user_count: number;
}

/**
 * GET /admin/stats/users - Get user statistics
 *
 * NOTE: This endpoint needs to be implemented on the auth server.
 * For now, this returns placeholder data.
 */
export async function getUserStats(
  env: ApiEnv,
  actingUser: ActingUser,
  request?: Request
): Promise<UserStats | ErrorResponse> {
  // TODO: Implement /admin/stats/users endpoint on auth server
  // For now, return from listUsers API
  try {
    const result = await listUsers(env, actingUser, { limit: 1000 }, request);
    if (isErrorResponse(result)) {
      return result;
    }

    // Count admin users from roles
    // Note: OpenAuth seeds role_admin and role_super_admin (not _default suffix)
    const adminUsers = result.users.filter(user =>
      user.roles.some(role =>
        role.id === 'role_admin' || role.id === 'role_super_admin'
      )
    ).length;

    return {
      totalUsers: result.users.length,
      adminUsers,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Failed to fetch user stats',
    };
  }
}

/**
 * GET /admin/stats/roles - Get role statistics
 *
 * NOTE: This endpoint needs to be implemented on the auth server.
 * For now, this returns placeholder data.
 */
export async function getRoleStats(
  env: ApiEnv,
  actingUser: ActingUser
): Promise<RoleStats | ErrorResponse> {
  // TODO: Implement /admin/stats/roles endpoint on auth server
  return {
    totalRoles: 0,
    systemRoles: 0,
    customRoles: 0,
  };
}

/**
 * GET /admin/stats/users-by-role - Get user distribution by role
 *
 * NOTE: This endpoint needs to be implemented on the auth server.
 * For now, this returns placeholder data.
 */
export async function getUsersByRole(
  env: ApiEnv,
  actingUser: ActingUser,
  limit: number = 5,
  request?: Request
): Promise<UsersByRole[] | ErrorResponse> {
  // TODO: Implement /admin/stats/users-by-role endpoint on auth server
  try {
    const result = await listUsers(env, actingUser, { limit: 1000 }, request);
    if (isErrorResponse(result)) {
      return result;
    }

    // Count users by role
    const roleCounts = new Map<string, number>();
    for (const user of result.users) {
      for (const role of user.roles) {
        const count = roleCounts.get(role.name) || 0;
        roleCounts.set(role.name, count + 1);
      }
    }

    // Convert to array and sort by count
    const usersByRole: UsersByRole[] = Array.from(roleCounts.entries())
      .map(([name, user_count]) => ({ name, user_count }))
      .sort((a, b) => b.user_count - a.user_count)
      .slice(0, limit);

    return usersByRole;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Failed to fetch users by role',
    };
  }
}

// ============================================================================
// Audit Log APIs
// ============================================================================

export interface AuditEvent {
  id: number;
  timestamp: string;
  event_type: string;
  severity: string;
  user_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
  success: boolean;
  error_message: string | null;
  created_at: string;
}

export interface AuditLogsResponse {
  data: AuditEvent[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

/**
 * GET /admin/audit-logs - Get audit logs with filtering and pagination
 */
export async function getAuditLogs(
  env: ApiEnv,
  actingUser: ActingUser,
  params?: {
    page?: number;
    limit?: number;
    event_type?: string;
    severity?: string;
    user_id?: string;
    start_date?: string;
    end_date?: string;
  }
): Promise<AuditLogsResponse | ErrorResponse> {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.event_type) searchParams.set('event_type', params.event_type);
  if (params?.severity) searchParams.set('severity', params.severity);
  if (params?.user_id) searchParams.set('user_id', params.user_id);
  if (params?.start_date) searchParams.set('start_date', params.start_date);
  if (params?.end_date) searchParams.set('end_date', params.end_date);

  const query = searchParams.toString();
  const endpoint = `/admin/audit-logs${query ? `?${query}` : ''}`;

  return m2mRequest<AuditLogsResponse>(env, endpoint, actingUser, { method: 'GET' });
}

// ============================================================================
// Export all as default object for convenient usage
// ============================================================================

export const adminApi = {
  // Token management
  clearTokenCache,

  // User management
  listUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  getUserRoles,
  listRoles,
  assignUserRole,
  removeUserRole,

  // Client management
  listClients,
  getClient,
  createClient,
  updateClient,
  deleteClient,
  rotateClientSecret,

  // Session management
  listSessions,
  getSessionStats,
  getSuspiciousActivity,
  terminateSession,
  terminateAllUserSessions,

  // Stats
  getUserStats,
  getRoleStats,
  getUsersByRole,

  // Audit logs
  getAuditLogs,

  // Utilities
  isErrorResponse,
};
