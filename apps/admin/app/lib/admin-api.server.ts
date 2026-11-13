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
  /** Free-form; may hold first/last/display names (see packages/ui/src/display-name.ts) */
  metadata?: unknown;
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
  total_count?: number | null;  // Total count from API (not capped by pagination limit); null when skipCount
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

  // Extract host info from auth server URL to set forwarded headers
  // This ensures OpenAuth generates tokens with the correct issuer URL
  // (OpenAuth's getRelativeUrl() uses x-forwarded-* headers if present)
  const authUrl = new URL(authServerUrl);

  const response = await fetch(`${authServerUrl}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Forwarded-Host': authUrl.host,
      'X-Forwarded-Proto': authUrl.protocol.replace(':', ''),
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

    // Parse auth server URL to get host for forwarded headers
    const authUrl = new URL(authServerUrl);

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      // CRITICAL: X-Forwarded headers ensure auth server uses correct issuer for JWT verification
      // Without these, the auth server may use Workers URL as issuer which won't match the token
      'X-Forwarded-Host': authUrl.host,
      'X-Forwarded-Proto': authUrl.protocol.replace(':', ''),
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
      console.error(`M2M API error: ${response.status} ${endpoint}`, errorText);
      try {
        const errorJson = JSON.parse(errorText);
        // Prefer error_description (human-readable) over error code
        return { error: errorJson.error_description || errorJson.error || errorJson.message || 'Request failed' };
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
  params?: { cursor?: string; limit?: number; search?: string; role?: string; email?: string; skipCount?: boolean },
  request?: Request
): Promise<PaginatedUsers | ErrorResponse> {
  const searchParams = new URLSearchParams();
  if (params?.cursor) searchParams.set('cursor', params.cursor);
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.search) searchParams.set('search', params.search);
  if (params?.role) searchParams.set('role', params.role);
  if (params?.email) searchParams.set('email', params.email);
  // A picker's page: no COUNT over every user (total_count comes back null)
  if (params?.skipCount) searchParams.set('count', 'none');

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
 * PATCH /admin/users/:id - Update user (partial update)
 * Note: OpenAuth uses PATCH for partial updates, not PUT
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
      method: 'PATCH',
      body: JSON.stringify(data),
    }
  );
}

/**
 * DELETE /admin/users/:id - Soft delete: restorable from Recently deleted for 30 days
 */
export async function deleteUser(
  env: ApiEnv,
  actingUser: ActingUser,
  userId: string,
  reason?: string
): Promise<SuccessResponse | ErrorResponse> {
  return m2mRequest<SuccessResponse>(
    env,
    `/admin/users/${encodeURIComponent(userId)}`,
    actingUser,
    { method: 'DELETE', body: JSON.stringify({ reason: reason || undefined }) }
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
  // The API returns { roles: Role[] }, so we need to unwrap
  const response = await m2mRequest<{ roles: Role[] }>(
    env,
    '/admin/roles',
    actingUser,
    { method: 'GET' },
    request
  );

  console.debug('[listRoles] Raw API response:', JSON.stringify(response, null, 2));

  // If error response, return as-is
  if (isErrorResponse(response)) {
    console.error('[listRoles] Error response from API:', response.error);
    return response;
  }

  const roles = response.roles || [];
  console.debug('[listRoles] Extracted roles count:', roles.length);

  // Unwrap the roles array from the response
  return roles;
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
 * DELETE /admin/clients/:clientId - Soft delete (disabled at once, restorable for 30 days)
 */
export async function deleteClient(
  env: ApiEnv,
  actingUser: ActingUser,
  clientId: string,
  reason?: string
): Promise<SuccessResponse | ErrorResponse> {
  return m2mRequest<SuccessResponse>(
    env,
    `/admin/clients/${encodeURIComponent(clientId)}`,
    actingUser,
    { method: 'DELETE', body: JSON.stringify({ reason: reason || undefined }) }
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
    // Note: API caps results at 100, but provides total_count with actual count
    const result = await listUsers(env, actingUser, { limit: 100 }, request);
    if (isErrorResponse(result)) {
      return result;
    }

    // Count admin users from the returned users (this is approximate for >100 users)
    // Note: OpenAuth seeds role_admin and role_super_admin (not _default suffix)
    // Use optional chaining since some users may not have roles assigned
    const adminUsers = result.users.filter(user =>
      user.roles?.some(role =>
        role.id === 'role_admin' || role.id === 'role_super_admin'
      )
    ).length;

    // Use total_count from API response for accurate user count
    // Fall back to users.length if total_count not provided
    return {
      totalUsers: result.total_count ?? result.users.length,
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
  _env: ApiEnv,
  _actingUser: ActingUser
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
    const result = await listUsers(env, actingUser, { limit: 1000, skipCount: true }, request);
    if (isErrorResponse(result)) {
      return result;
    }

    // Count users by role
    // Handle users that may not have roles assigned
    const roleCounts = new Map<string, number>();
    for (const user of result.users) {
      for (const role of user.roles || []) {
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
    capped?: boolean;
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
// Recently deleted (admin soft delete; the auth worker's hourly cleanup purges)
// ============================================================================

export type DeletionKind = 'user' | 'client' | 'role' | 'theme';

export interface DeletedItem {
  kind: DeletionKind;
  id: string;
  label: string | null;
  deletedAt: number;
  deletedBy: string;
  deletedByEmail: string | null;
  reason: string | null;
  purgeRequestedAt: number | null;
  purgeRequestedBy: string | null;
  purgeAt: number;
  lastError: string | null;
}

export interface DeletedList {
  items: DeletedItem[];
  retentionDays: number;
  now: number;
}

/** GET /admin/deletions?kind= */
export async function listDeleted(env: ApiEnv, actingUser: ActingUser, kind?: DeletionKind, request?: Request) {
  const q = kind ? `?kind=${encodeURIComponent(kind)}` : '';
  return m2mRequest<DeletedList>(env, `/admin/deletions${q}`, actingUser, { method: 'GET' }, request);
}

/** POST /admin/deletions/:kind/:id/restore */
export async function restoreDeleted(env: ApiEnv, actingUser: ActingUser, kind: DeletionKind, id: string) {
  return m2mRequest<SuccessResponse>(env, `/admin/deletions/${kind}/${encodeURIComponent(id)}/restore`, actingUser, { method: 'POST' });
}

/** POST /admin/deletions/:kind/:id/purge: the next cleanup run deletes it permanently */
export async function requestPermanentDeletion(env: ApiEnv, actingUser: ActingUser, kind: DeletionKind, id: string, confirm: string) {
  return m2mRequest<SuccessResponse>(env, `/admin/deletions/${kind}/${encodeURIComponent(id)}/purge`, actingUser, {
    method: 'POST',
    body: JSON.stringify({ confirm }),
  });
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

// ============================================================================
// Moderation requests from client apps (docs/MODERATION_REQUESTS.md)
// ============================================================================

export type ModerationStatus = 'pending' | 'info_requested' | 'approved' | 'rejected' | 'actioned';
export type ModerationActionName = 'suspend_account' | 'delete_account' | 'revoke_sessions' | 'require_password_reset' | 'other';

export interface ModerationHistoryItem {
  id: string;
  type: string;
  actor_type: 'client' | 'admin' | 'system';
  actor_id: string;
  actor_name: string | null;
  note: string | null;
  metadata: unknown;
  at: string;
}

export interface ModerationSubject {
  id: string;
  email: string;
  name: string | null;
  status: string;
  password_reset_required: boolean;
  created_at: number;
}

export interface ModerationRequest {
  id: string;
  status: ModerationStatus;
  subject_user_id: string;
  action: ModerationActionName;
  reason_category: string;
  reason: string;
  evidence: Array<{ url: string; label?: string }>;
  requested_by: { id: string; display_name: string };
  decision_note: string | null;
  decided_at: string | null;
  actioned_at: string | null;
  created_at: string;
  updated_at: string;
  client_id: string;
  client_name: string | null;
  decided_by: string | null;
  action_result: unknown;
  action_error: string | null;
  /** The queued run of an approved request's action; failed = needs an auth admin */
  execution: { status: 'queued' | 'retrying' | 'failed' | 'done' | null; attempts: number; updated_at: string | null; needs_attention: boolean };
  history: ModerationHistoryItem[];
  subject?: ModerationSubject | null;
}

export interface ModerationQueue {
  requests: ModerationRequest[];
  total: number;
  open: number;
  needs_attention: number;
  limit: number;
  offset: number;
  clients: Array<{ id: string; name: string }>;
}

export interface ModerationRequestDetail {
  request: ModerationRequest;
  subject: ModerationSubject | null;
  prior_requests: ModerationRequest[];
}

/** GET /admin/moderation-requests - the queue, with filters */
export async function listModerationRequests(
  env: ApiEnv,
  actingUser: ActingUser,
  params: { status?: string; client_id?: string; action?: string; from?: string; to?: string; needs_attention?: string; limit?: number; offset?: number }
): Promise<ModerationQueue | ErrorResponse> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const query = q.toString();
  return m2mRequest<ModerationQueue>(env, `/admin/moderation-requests${query ? `?${query}` : ''}`, actingUser, { method: 'GET' });
}

/** GET /admin/moderation-requests/:id - request, history, user, prior requests */
export async function getModerationRequest(env: ApiEnv, actingUser: ActingUser, id: string): Promise<ModerationRequestDetail | ErrorResponse> {
  return m2mRequest<ModerationRequestDetail>(env, `/admin/moderation-requests/${encodeURIComponent(id)}`, actingUser, { method: 'GET' });
}

export type ModerationDecision = 'approve' | 'reject' | 'request-info' | 'execute' | 'mark-actioned';

/** POST /admin/moderation-requests/:id/<decision> */
export async function decideModerationRequest(
  env: ApiEnv,
  actingUser: ActingUser,
  id: string,
  decision: ModerationDecision,
  note?: string
): Promise<{ request: ModerationRequest } | ErrorResponse> {
  return m2mRequest<{ request: ModerationRequest }>(env, `/admin/moderation-requests/${encodeURIComponent(id)}/${decision}`, actingUser, {
    method: 'POST',
    body: JSON.stringify(note ? { note } : {}),
  });
}

// ============================================================================
// Raw M2M requests (theme files, zips, preview HTML)
// ============================================================================

/**
 * An M2M request to the auth server that returns the raw Response: for bodies
 * that aren't JSON (file uploads, zip import/export, preview HTML). The body's
 * Content-Type is the caller's.
 */
export async function m2mFetch(
  env: ApiEnv,
  endpoint: string,
  actingUser: ActingUser,
  init: RequestInit = {},
  request?: Request
): Promise<Response> {
  const accessToken = await getAccessToken(env, request);
  const authServerUrl = getAuthServerUrl(request, env);
  const authUrl = new URL(authServerUrl);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  headers.set('X-Forwarded-Host', authUrl.host);
  headers.set('X-Forwarded-Proto', authUrl.protocol.replace(':', ''));
  headers.set('X-Acting-User-Id', actingUser.id);
  headers.set('X-Acting-User-Email', actingUser.email);
  headers.set('X-Acting-User-Roles', actingUser.roles.join(','));
  const response = await fetch(`${authServerUrl}${endpoint}`, { ...init, headers });
  if (response.status === 401) clearTokenCache();
  return response;
}

// ============================================================================
// Passkeys (AUTH-PASSKEYS)
// ============================================================================

export interface PasskeySummary {
  id: string;
  name: string;
  synced: boolean;
  deviceType: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface StaffPasskeySettings {
  enforced: boolean;
  enforcedAt: number | null;
  graceDays: number;
  staff: number;
  withoutPasskey: { id: string; email: string }[];
  capped: boolean;
  actorHasPasskey: boolean;
}

/** GET /admin/users/:id/passkeys */
export async function listUserPasskeys(env: ApiEnv, actingUser: ActingUser, userId: string, request?: Request) {
  return m2mRequest<{ passkeys: PasskeySummary[]; staff: boolean }>(env, `/admin/users/${encodeURIComponent(userId)}/passkeys`, actingUser, { method: 'GET' }, request);
}

/** DELETE /admin/users/:id/passkeys/:cid (soft delete; the user is emailed) */
export async function removeUserPasskey(env: ApiEnv, actingUser: ActingUser, userId: string, credentialId: string) {
  return m2mRequest<SuccessResponse>(env, `/admin/users/${encodeURIComponent(userId)}/passkeys/${encodeURIComponent(credentialId)}`, actingUser, { method: 'DELETE' });
}

/** POST /admin/users/:id/passkeys/setup-link: emails a one-time setup link (24 h) */
export async function sendPasskeySetupLink(env: ApiEnv, actingUser: ActingUser, userId: string, locale: 'en' | 'ar') {
  return m2mRequest<{ ok: boolean; sent: boolean; expiresAt: number }>(env, `/admin/users/${encodeURIComponent(userId)}/passkeys/setup-link`, actingUser, {
    method: 'POST',
    body: JSON.stringify({ locale }),
  });
}

/** GET /admin/settings/staff-passkeys */
export async function getStaffPasskeySettings(env: ApiEnv, actingUser: ActingUser, request?: Request) {
  return m2mRequest<StaffPasskeySettings>(env, `/admin/settings/staff-passkeys`, actingUser, { method: 'GET' }, request);
}

/** PUT /admin/settings/staff-passkeys (Super Admin; refused unless the admin has a passkey) */
export async function setStaffPasskeyEnforcement(env: ApiEnv, actingUser: ActingUser, enforced: boolean) {
  return m2mRequest<{ enforced: boolean; enforcedAt: number | null; graceDays: number }>(env, `/admin/settings/staff-passkeys`, actingUser, {
    method: 'PUT',
    body: JSON.stringify({ enforced }),
  });
}
