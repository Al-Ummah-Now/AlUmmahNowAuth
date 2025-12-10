/**
 * @fileoverview M2M (Machine-to-Machine) Authentication Middleware
 *
 * Validates Bearer tokens issued via the client_credentials grant.
 * Uses jose for JWT verification with JWKS endpoint.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { logger } from '../logger';

// Cached JWKS per issuer
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Get or create JWKS for an issuer
 */
function getJWKS(issuer: string) {
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    const jwksUrl = new URL('/.well-known/jwks.json', issuer);
    jwks = createRemoteJWKSet(jwksUrl);
    jwksCache.set(issuer, jwks);
  }
  return jwks;
}

/**
 * M2M token payload structure
 */
export interface M2MTokenPayload {
  /** Token mode - must be "m2m" for M2M tokens */
  mode: 'm2m';
  /** Subject - the client_id */
  sub: string;
  /** Client ID */
  client_id: string;
  /** Tenant ID (if multi-tenant) */
  tenant_id?: string;
  /** Granted scopes (space-separated) */
  scope: string;
  /** Expiration timestamp (Unix epoch seconds) */
  exp: number;
  /** Issued at timestamp */
  iat: number;
  /** Issuer URL */
  iss: string;
  /** JWT ID for revocation tracking */
  jti: string;
}

/**
 * Result of M2M authentication
 */
export interface M2MAuthResult {
  /** Client ID that authenticated */
  clientId: string;
  /** Tenant ID (if applicable) */
  tenantId?: string;
  /** Granted scopes as array */
  scopes: string[];
  /** The full token payload */
  payload: M2MTokenPayload;
}

/**
 * M2M authentication error
 */
export class M2MAuthError extends Error {
  constructor(
    message: string,
    public code: 'invalid_token' | 'insufficient_scope' | 'missing_token' | 'invalid_token_type',
    public statusCode: number = 401
  ) {
    super(message);
    this.name = 'M2MAuthError';
  }
}

/**
 * Extracts Bearer token from Authorization header
 */
function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return null;
  }

  return parts[1];
}

/**
 * Checks if the given scopes satisfy the required scope
 *
 * Supports:
 * - Exact match: "admin:users" requires "admin:users"
 * - Wildcard in required: "admin:*" is satisfied by any "admin:xxx" scope
 * - Wildcard in granted: having "admin:*" satisfies any "admin:xxx" requirement
 * - Multiple scopes: "admin:users admin:roles" has both
 */
function hasRequiredScope(grantedScopes: string[], requiredScope: string): boolean {
  // If no scope required, allow
  if (!requiredScope) return true;

  // Check for exact match
  if (grantedScopes.includes(requiredScope)) return true;

  const parts = requiredScope.split(':');
  if (parts.length === 2) {
    const [prefix, suffix] = parts;

    // If required scope is a wildcard (e.g., "admin:*"), check if any granted scope matches the prefix
    if (suffix === '*') {
      const hasMatchingScope = grantedScopes.some((scope) => scope.startsWith(`${prefix}:`));
      if (hasMatchingScope) return true;
    }

    // Check if granted scopes include a wildcard that covers the required scope
    // e.g., having "admin:*" satisfies requiring "admin:users"
    const wildcardScope = `${prefix}:*`;
    if (grantedScopes.includes(wildcardScope)) return true;
  }

  return false;
}

/**
 * Verifies an M2M access token from the Authorization header
 *
 * @param request - The incoming HTTP request
 * @param env - Cloudflare Workers environment
 * @param requiredScope - Optional scope that must be present in the token
 * @returns The authenticated M2M context
 * @throws M2MAuthError if authentication fails
 *
 * @example
 * ```typescript
 * // Basic M2M auth
 * const auth = await verifyM2MAuth(request, env);
 * console.log(`Client ${auth.clientId} authenticated`);
 *
 * // With required scope
 * const auth = await verifyM2MAuth(request, env, 'admin:users');
 * ```
 */
export async function verifyM2MAuth(
  request: Request,
  env: Env,
  requiredScope?: string
): Promise<M2MAuthResult> {
  // Extract Bearer token
  const token = extractBearerToken(request);
  if (!token) {
    throw new M2MAuthError(
      'Missing or invalid Authorization header. Expected: Bearer <token>',
      'missing_token',
      401
    );
  }

  try {
    // Get the issuer and JWKS
    const issuer = env.OPENAUTH_ISSUER || 'http://localhost:3301';
    const jwks = getJWKS(issuer);

    // Verify the token using jose with JWKS
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      clockTolerance: 10,
    });

    // Verify this is an M2M token
    if (payload.mode !== 'm2m') {
      throw new M2MAuthError(
        'Token is not an M2M token (mode claim is not "m2m")',
        'invalid_token_type',
        401
      );
    }

    // Extract required claims
    const clientId = payload.client_id as string;
    if (!clientId) {
      throw new M2MAuthError('Missing client_id claim', 'invalid_token', 401);
    }

    const scope = payload.scope as string;
    if (typeof scope !== 'string') {
      throw new M2MAuthError('Missing or invalid scope claim', 'invalid_token', 401);
    }

    const scopes = scope.split(' ').filter(Boolean);
    const tenantId = payload.tenant_id as string | undefined;

    // Check required scope
    if (requiredScope && !hasRequiredScope(scopes, requiredScope)) {
      logger.warn('M2M auth failed - insufficient scope', {
        clientId,
        requiredScope,
        grantedScopes: scopes,
      });
      throw new M2MAuthError(
        `Insufficient scope. Required: ${requiredScope}. Granted: ${scopes.join(', ')}`,
        'insufficient_scope',
        403
      );
    }

    logger.debug('M2M auth successful', {
      clientId,
      tenantId,
      scopes,
    });

    return {
      clientId,
      tenantId,
      scopes,
      payload: {
        mode: 'm2m',
        sub: payload.sub as string,
        client_id: clientId,
        tenant_id: tenantId,
        scope,
        exp: payload.exp as number,
        iat: payload.iat as number,
        iss: payload.iss as string,
        jti: (payload.jti as string) || '',
      },
    };
  } catch (error) {
    if (error instanceof M2MAuthError) {
      throw error;
    }

    logger.warn('M2M token verification failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    throw new M2MAuthError(
      error instanceof Error ? error.message : 'Token verification failed',
      'invalid_token',
      401
    );
  }
}

/**
 * Creates a standardized error response for M2M auth failures
 */
export function createM2MAuthErrorResponse(error: M2MAuthError): Response {
  return new Response(
    JSON.stringify({
      error: error.code,
      error_description: error.message,
    }),
    {
      status: error.statusCode,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer error="${error.code}", error_description="${error.message}"`,
      },
    }
  );
}

/**
 * Checks if a request has M2M authentication (Bearer token present)
 * Does not validate the token - just checks for presence
 */
export function hasM2MAuth(request: Request): boolean {
  return extractBearerToken(request) !== null;
}
