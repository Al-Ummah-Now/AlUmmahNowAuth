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
  created_at: string;
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

export interface PaginatedUsers {
  users: User[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface OAuthClient {
  id: string;
  client_id: string;
  client_type: 'public' | 'confidential';
  allowed_grants: string[];
  redirect_uris: string[];
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
  env: { AUTH_SERVER_URL?: string; ADMIN_CLIENT_ID?: string; ADMIN_CLIENT_SECRET?: string }
): Promise<string> {
  // Check cache
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }

  const authServerUrl = env.AUTH_SERVER_URL || 'http://localhost:3301';
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
 */
async function m2mRequest<T>(
  env: ApiEnv,
  endpoint: string,
  actingUser: ActingUser,
  options: RequestInit = {}
): Promise<T | ErrorResponse> {
  try {
    const accessToken = await getAccessToken(env);
    const authServerUrl = env.AUTH_SERVER_URL || 'http://localhost:3301';
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
 * GET /admin/users - List all users with pagination
 */
export async function listUsers(
  env: ApiEnv,
  actingUser: ActingUser,
  params?: { page?: number; limit?: number; search?: string; role?: string }
): Promise<PaginatedUsers | ErrorResponse> {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.search) searchParams.set('search', params.search);
  if (params?.role) searchParams.set('role', params.role);

  const query = searchParams.toString();
  const endpoint = `/admin/users${query ? `?${query}` : ''}`;

  return m2mRequest<PaginatedUsers>(env, endpoint, actingUser, { method: 'GET' });
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
 * POST /admin/users/:id/roles - Assign role to user
 */
export async function assignUserRole(
  env: ApiEnv,
  actingUser: ActingUser,
  userId: string,
  roleId: string,
  expiresAt?: string
): Promise<SuccessResponse | ErrorResponse> {
  const body: { roleId: string; expiresAt?: string } = { roleId };
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
 * POST /admin/clients - Create OAuth client
 */
export async function createClient(
  env: ApiEnv,
  actingUser: ActingUser,
  data: {
    client_id: string;
    client_type: 'public' | 'confidential';
    allowed_grants: string[];
    redirect_uris: string[];
  }
): Promise<OAuthClient & { client_secret?: string } | ErrorResponse> {
  return m2mRequest<OAuthClient & { client_secret?: string }>(
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
 * PUT /admin/clients/:clientId - Update OAuth client
 */
export async function updateClient(
  env: ApiEnv,
  actingUser: ActingUser,
  clientId: string,
  data: Partial<{
    allowed_grants: string[];
    redirect_uris: string[];
  }>
): Promise<OAuthClient | ErrorResponse> {
  return m2mRequest<OAuthClient>(
    env,
    `/admin/clients/${encodeURIComponent(clientId)}`,
    actingUser,
    {
      method: 'PUT',
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
 * POST /admin/clients/:clientId/rotate-secret - Rotate client secret
 */
export async function rotateClientSecret(
  env: ApiEnv,
  actingUser: ActingUser,
  clientId: string
): Promise<{ client_secret: string } | ErrorResponse> {
  return m2mRequest<{ client_secret: string }>(
    env,
    `/admin/clients/${encodeURIComponent(clientId)}/rotate-secret`,
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
  authenticatedAt: string;
  lastUsed: string;
  isActive: boolean;
  device: {
    ipAddress: string;
    userAgent: string;
  };
  lastActivity: string;
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
    lastFailure: string;
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

  // Utilities
  isErrorResponse,
};
