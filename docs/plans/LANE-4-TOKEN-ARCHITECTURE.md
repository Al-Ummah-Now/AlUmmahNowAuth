# Lane 4: Token Architecture Enhancement

## Overview
Enhance token architecture to support audience-specific tokens, token introspection, and cross-app token exchange. Each app receives its own access token with appropriate audience and permissions.

## Priority: P1 (High)
**Dependencies**: Lane 1 (Browser Sessions) - for session context in tokens
**Blocks**: None (can run in parallel after Lane 1)

---

## Current State Analysis

### What Exists:
- JWT access tokens with RS256 signing
- Refresh token rotation with parent tracking
- Token introspection endpoint (RFC 7662)
- Token revocation endpoint (RFC 7009)
- Standard claims: iss, sub, aud, exp, iat, nbf, jti
- Custom claims: email, roles, client_id, scope
- Key rotation support

### What's Missing:
- Audience-specific tokens (different token per client)
- App-specific permissions in tokens
- Token exchange (RFC 8693)
- Cross-app token exchange flow
- Token binding to session

---

## Token Expiration Strategy

### Token Lifetimes Overview

| Token Type | Lifetime | Storage | Refresh Strategy |
|------------|----------|---------|------------------|
| Access Token | 1 hour | Client (memory/storage) | Exchange refresh token |
| Refresh Token | 7 days | DB (hashed) | Rotation on use |
| Account Session | 7 days | DB | Extended on activity |
| Browser Session | 7 days | DB (sliding window) | Extended on activity |

### Detailed Lifecycle

```
User Authenticates
    ↓
Browser Session Created (expires in 7 days)
    ↓
Account Session Created (expires in 7 days)
    ↓
Access Token Generated (expires in 1 hour)
Refresh Token Generated (expires in 7 days)
    ↓
Client stores tokens, uses access token for API calls
    ↓
Access Token Expires (1 hour later)
    ↓
Client uses refresh token to get new access token
    ↓
New Access Token (1 hour)
Old Refresh Token Revoked
New Refresh Token Issued (rotation)
    ↓
User activity touches browser session
    ↓
Browser Session expires_at extended (sliding window)
Account Session last_used updated
    ↓
After 7 days of inactivity:
    ↓
Browser Session Expires
All Account Sessions in that browser become invalid
All tokens bound to those sessions become invalid
User must re-authenticate
```

### Sliding Window for Browser Sessions

Browser session expiration uses a sliding window approach:

```typescript
// On every authenticated request:
async function touchBrowserSession(sessionId: string): Promise<void> {
  const newExpiry = new Date();
  newExpiry.setDate(newExpiry.getDate() + SESSION_LIFETIME_DAYS);

  await this.db.prepare(`
    UPDATE browser_sessions
    SET last_activity = datetime('now'),
        expires_at = ?  -- Sliding window extension
    WHERE id = ?
  `).bind(newExpiry.toISOString(), sessionId).run();
}
```

This ensures:
- Active users stay logged in indefinitely
- Inactive sessions expire after 7 days
- No unnecessary re-authentication for frequent users

### Session Cleanup Job

A scheduled worker cleans up expired sessions with batching and time-boxing:

```typescript
// Scheduled every hour via Cloudflare Cron Trigger
// Uses LIMIT for batched deletes to avoid long-running queries
// Time-boxed to max 10 seconds per execution
export async function cleanupExpiredSessions(db: D1Database): Promise<CleanupResult> {
  const now = new Date().toISOString();
  const startTime = Date.now();
  const MAX_EXECUTION_MS = 10000; // 10 seconds max
  const BATCH_SIZE = 1000; // Delete in batches

  let browserSessionsDeleted = 0;
  let refreshTokensDeleted = 0;
  let appTokensDeleted = 0;

  // Helper to check if we should continue
  const shouldContinue = () => Date.now() - startTime < MAX_EXECUTION_MS;

  // Delete expired browser sessions in batches (cascades to account_sessions via FK)
  while (shouldContinue()) {
    const result = await db.prepare(`
      DELETE FROM browser_sessions
      WHERE id IN (
        SELECT id FROM browser_sessions
        WHERE expires_at < ? OR is_revoked = 1
        LIMIT ?
      )
    `).bind(now, BATCH_SIZE).run();

    const deleted = result.meta.changes || 0;
    browserSessionsDeleted += deleted;
    if (deleted < BATCH_SIZE) break; // No more to delete
  }

  // Delete expired/revoked refresh tokens in batches
  while (shouldContinue()) {
    const result = await db.prepare(`
      DELETE FROM refresh_tokens
      WHERE id IN (
        SELECT id FROM refresh_tokens
        WHERE expires_at < ? OR is_revoked = 1
        LIMIT ?
      )
    `).bind(now, BATCH_SIZE).run();

    const deleted = result.meta.changes || 0;
    refreshTokensDeleted += deleted;
    if (deleted < BATCH_SIZE) break;
  }

  // Delete expired app tokens in batches
  while (shouldContinue()) {
    const result = await db.prepare(`
      DELETE FROM app_tokens
      WHERE id IN (
        SELECT id FROM app_tokens
        WHERE expires_at < ? OR is_revoked = 1
        LIMIT ?
      )
    `).bind(now, BATCH_SIZE).run();

    const deleted = result.meta.changes || 0;
    appTokensDeleted += deleted;
    if (deleted < BATCH_SIZE) break;
  }

  return {
    browserSessionsDeleted,
    refreshTokensDeleted,
    appTokensDeleted,
    timestamp: now,
    executionTimeMs: Date.now() - startTime,
    timeBoxedExit: !shouldContinue(), // True if we hit time limit
  };
}
```

### Token Revocation Cascade

When a session is revoked, all related tokens must be invalidated:

```
Browser Session Revoked
    ↓
All Account Sessions in browser → Revoked
    ↓
For each Account Session:
    → All App Tokens → Revoked
    → All Refresh Tokens → Revoked
    ↓
User's access tokens become invalid on next introspection
(JWT signature valid but session_id check fails)
```

### Legacy Token Migration Strategy

When migrating from the existing token schema to the new architecture, handle backwards compatibility:

```typescript
/**
 * Legacy Token Handling Strategy
 *
 * Problem: Existing tokens don't have session_id binding or app_tokens entries
 * Solution: Dual-read during transition, allow legacy tokens until natural expiry
 */

// Token version identifier (add to new tokens)
const TOKEN_VERSION = 2;

async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, keyResolver, { issuer: this.issuer });
    const claims = payload as unknown as AccessTokenClaims;

    // Check token version for new vs legacy handling
    const tokenVersion = claims.token_version || 1;

    if (tokenVersion >= 2) {
      // New tokens: Full validation with session binding
      const tokenHash = await hashToken(token);
      const appToken = await this.db.prepare(`
        SELECT is_revoked FROM app_tokens WHERE access_token_hash = ?
      `).bind(tokenHash).first();

      // Must exist in app_tokens and not be revoked
      if (!appToken || appToken.is_revoked) {
        return null;
      }

      // Verify session is still valid
      const session = await this.db.prepare(`
        SELECT is_revoked FROM account_sessions WHERE id = ?
      `).bind(claims.session_id).first();

      if (!session || session.is_revoked) {
        return null;
      }
    } else {
      // Legacy tokens (v1): Only check JWT validity and expiration
      // Allow until natural expiry (max 1 hour for access tokens)
      // Log for monitoring migration progress
      console.log('Legacy token used', { sub: claims.sub, exp: claims.exp });
    }

    return claims;
  } catch {
    return null;
  }
}

// When generating new tokens, include version
const accessTokenClaims: AccessTokenClaims = {
  // ... existing claims ...
  token_version: TOKEN_VERSION,
};
```

**Migration Timeline:**
1. Deploy new token architecture
2. New tokens issued with `token_version: 2` and `session_id` binding
3. Legacy tokens (no `token_version`) continue working until they expire (max 7 days for refresh)
4. After 7 days, all tokens are new format
5. Remove legacy handling code after transition period

**Monitoring:**
- Track ratio of legacy vs new tokens in introspection
- Alert if legacy token usage doesn't decrease over time

---

## Token Architecture Design

### Token Per App Model

```
User authenticates to Auth Server
    ↓
User visits App A
    ↓
App A requests token with:
  - aud: "app-a"
  - scope: "read write"
    ↓
Token issued:
  {
    sub: "user_123",
    aud: "app-a",
    scope: "read write",
    permissions: ["articles:read", "articles:write"],
    session_id: "as_xxx"
  }

User visits App B (via SSO)
    ↓
App B requests token with:
  - aud: "app-b"
  - scope: "admin"
    ↓
New token issued:
  {
    sub: "user_123",
    aud: "app-b",
    scope: "admin",
    permissions: ["dashboard:view"],
    session_id: "as_xxx"
  }
```

---

## Database Schema Changes

### Migration: 0025_app_tokens.sql

```sql
-- App-specific tokens tracking
CREATE TABLE app_tokens (
    id TEXT PRIMARY KEY,
    account_session_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    access_token_hash TEXT NOT NULL,
    scope TEXT,
    audience TEXT NOT NULL,
    issued_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    is_revoked INTEGER DEFAULT 0,
    revoked_at TEXT,
    revoke_reason TEXT,
    FOREIGN KEY (account_session_id) REFERENCES account_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES oauth_clients(id) ON DELETE CASCADE
);

CREATE INDEX idx_app_tokens_session ON app_tokens(account_session_id);
CREATE INDEX idx_app_tokens_client ON app_tokens(client_id);
CREATE INDEX idx_app_tokens_hash ON app_tokens(access_token_hash);
CREATE INDEX idx_app_tokens_expires ON app_tokens(expires_at);
-- Composite index for introspection queries (hash + revocation check)
CREATE INDEX idx_app_tokens_introspection ON app_tokens(access_token_hash, is_revoked);

-- Client-specific permissions mapping
CREATE TABLE client_permissions (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    permission_id TEXT NOT NULL,
    granted_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES oauth_clients(id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE,
    UNIQUE(client_id, permission_id)
);

CREATE INDEX idx_client_permissions_client ON client_permissions(client_id);
```

### Migration: 0026_oauth_clients_audience.sql

```sql
-- Add audience field to oauth_clients
ALTER TABLE oauth_clients ADD COLUMN audience TEXT;

-- Update existing clients to use client_id as default audience
UPDATE oauth_clients SET audience = id WHERE audience IS NULL;
```

---

## Token Claims Structure

### File: apps/auth/src/types/token-claims.ts

```typescript
export interface AccessTokenClaims {
  // Standard Claims (RFC 7519)
  iss: string;          // Issuer (auth server URL)
  sub: string;          // Subject (user ID)
  aud: string;          // Audience (client/app identifier)
  exp: number;          // Expiration time (Unix timestamp)
  iat: number;          // Issued at (Unix timestamp)
  nbf: number;          // Not before (Unix timestamp)
  jti: string;          // JWT ID (unique identifier)

  // OpenID Connect Claims
  auth_time?: number;   // Time of authentication
  nonce?: string;       // Nonce from authorization request
  acr?: string;         // Authentication Context Class Reference
  amr?: string[];       // Authentication Methods References

  // Custom Claims
  email: string;
  email_verified?: boolean;
  roles: string[];
  permissions: string[];
  scope: string;
  client_id: string;
  session_id: string;   // Account session ID for binding
  tenant_id?: string;   // Tenant context

  // App-specific metadata (optional)
  app_metadata?: Record<string, unknown>;
}

export interface RefreshTokenClaims {
  jti: string;
  sub: string;
  client_id: string;
  scope: string;
  session_id: string;
  iat: number;
  exp: number;
}

export interface TokenExchangeRequest {
  grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange';
  subject_token: string;
  subject_token_type: 'urn:ietf:params:oauth:token-type:access_token';
  audience: string;           // Target client/audience
  scope?: string;             // Requested scope for new token
  requested_token_type?: string;
}

export interface IntrospectionResponse {
  active: boolean;
  scope?: string;
  client_id?: string;
  username?: string;
  token_type?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
  sub?: string;
  aud?: string;
  iss?: string;
  jti?: string;
  // Custom claims
  roles?: string[];
  permissions?: string[];
  session_id?: string;
}
```

---

## Service Implementation

### File: apps/auth/src/services/token.service.ts

```typescript
import { SignJWT, jwtVerify, decodeJwt } from 'jose';
import { generateId } from '../utils/id';
import { hashToken } from '../utils/crypto';
import type { D1Database } from '@cloudflare/workers-types';
import type { AccessTokenClaims, RefreshTokenClaims, IntrospectionResponse } from '../types/token-claims';

export interface TokenGenerationParams {
  userId: string;
  clientId: string;
  audience: string;
  scope: string;
  sessionId: string;
  tenantId?: string;
  nonce?: string;
}

export interface GeneratedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
  scope: string;
}

export class TokenService {
  private readonly ACCESS_TOKEN_LIFETIME = 3600;  // 1 hour
  private readonly REFRESH_TOKEN_LIFETIME = 604800; // 7 days

  constructor(
    private db: D1Database,
    private issuer: string,
    private getSigningKey: () => Promise<{ privateKey: CryptoKey; keyId: string }>
  ) {}

  /**
   * Generate access and refresh tokens for a client
   */
  async generateTokens(params: TokenGenerationParams): Promise<GeneratedTokens> {
    const { userId, clientId, audience, scope, sessionId, tenantId, nonce } = params;

    // Get user details and permissions
    const [user, permissions] = await Promise.all([
      this.getUserWithRoles(userId),
      this.getEffectivePermissions(userId, clientId),
    ]);

    if (!user) {
      throw new Error('User not found');
    }

    const now = Math.floor(Date.now() / 1000);
    const jti = generateId('at');

    // Build access token claims
    const accessTokenClaims: AccessTokenClaims = {
      iss: this.issuer,
      sub: userId,
      aud: audience,
      exp: now + this.ACCESS_TOKEN_LIFETIME,
      iat: now,
      nbf: now,
      jti,
      auth_time: now,
      email: user.email,
      roles: user.roles,
      permissions,
      scope,
      client_id: clientId,
      session_id: sessionId,
    };

    if (tenantId) {
      accessTokenClaims.tenant_id = tenantId;
    }

    if (nonce) {
      accessTokenClaims.nonce = nonce;
    }

    // Get signing key
    const { privateKey, keyId } = await this.getSigningKey();

    // Sign access token
    const accessToken = await new SignJWT(accessTokenClaims as unknown as Record<string, unknown>)
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: keyId })
      .sign(privateKey);

    // Generate refresh token
    const refreshTokenId = generateId('rt');
    const refreshToken = await this.generateRefreshToken({
      jti: refreshTokenId,
      sub: userId,
      clientId,
      scope,
      sessionId,
    }, privateKey, keyId);

    // Store app token reference
    await this.storeAppToken({
      id: jti,
      accountSessionId: sessionId,
      clientId,
      accessTokenHash: await hashToken(accessToken),
      scope,
      audience,
      expiresAt: new Date((now + this.ACCESS_TOKEN_LIFETIME) * 1000).toISOString(),
    });

    // Store refresh token
    await this.storeRefreshToken({
      id: refreshTokenId,
      userId,
      clientId,
      tokenHash: await hashToken(refreshToken),
      scope,
      sessionId,
      expiresAt: new Date((now + this.REFRESH_TOKEN_LIFETIME) * 1000).toISOString(),
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.ACCESS_TOKEN_LIFETIME,
      tokenType: 'Bearer',
      scope,
    };
  }

  /**
   * Refresh tokens - generates new access token, rotates refresh token
   */
  async refreshTokens(refreshToken: string): Promise<GeneratedTokens> {
    const tokenHash = await hashToken(refreshToken);

    // Find and validate refresh token
    const storedToken = await this.db.prepare(`
      SELECT rt.*, u.email
      FROM refresh_tokens rt
      JOIN user u ON rt.user_id = u.id
      WHERE rt.token_hash = ?
      AND rt.is_revoked = 0
      AND rt.expires_at > datetime('now')
    `).bind(tokenHash).first();

    if (!storedToken) {
      throw new Error('Invalid or expired refresh token');
    }

    // Revoke old refresh token (rotation)
    await this.db.prepare(`
      UPDATE refresh_tokens SET is_revoked = 1, revoked_at = datetime('now')
      WHERE id = ?
    `).bind(storedToken.id).run();

    // Get client audience
    const client = await this.db.prepare(`
      SELECT audience FROM oauth_clients WHERE id = ?
    `).bind(storedToken.client_id).first();

    // Generate new tokens
    return this.generateTokens({
      userId: storedToken.user_id as string,
      clientId: storedToken.client_id as string,
      audience: client?.audience as string || storedToken.client_id as string,
      scope: storedToken.scope as string,
      sessionId: storedToken.session_id as string,
    });
  }

  /**
   * Token exchange - exchange token for different audience
   */
  async exchangeToken(params: {
    subjectToken: string;
    targetAudience: string;
    requestedScope?: string;
  }): Promise<GeneratedTokens> {
    // Verify subject token
    const claims = await this.verifyAccessToken(params.subjectToken);

    if (!claims) {
      throw new Error('Invalid subject token');
    }

    // Verify target client exists
    const targetClient = await this.db.prepare(`
      SELECT id, audience, allowed_scopes FROM oauth_clients WHERE id = ? OR audience = ?
    `).bind(params.targetAudience, params.targetAudience).first();

    if (!targetClient) {
      throw new Error('Invalid target audience');
    }

    // Determine scope for new token
    const requestedScope = params.requestedScope || claims.scope;

    // Generate new tokens for target audience
    return this.generateTokens({
      userId: claims.sub,
      clientId: targetClient.id as string,
      audience: targetClient.audience as string || targetClient.id as string,
      scope: requestedScope,
      sessionId: claims.session_id,
      tenantId: claims.tenant_id,
    });
  }

  /**
   * Introspect token
   */
  async introspect(token: string): Promise<IntrospectionResponse> {
    try {
      const claims = await this.verifyAccessToken(token);

      if (!claims) {
        return { active: false };
      }

      // Check if token is in revoked list
      const tokenHash = await hashToken(token);
      const appToken = await this.db.prepare(`
        SELECT is_revoked FROM app_tokens WHERE access_token_hash = ?
      `).bind(tokenHash).first();

      if (appToken?.is_revoked) {
        return { active: false };
      }

      return {
        active: true,
        scope: claims.scope,
        client_id: claims.client_id,
        username: claims.email,
        token_type: 'Bearer',
        exp: claims.exp,
        iat: claims.iat,
        nbf: claims.nbf,
        sub: claims.sub,
        aud: claims.aud,
        iss: claims.iss,
        jti: claims.jti,
        roles: claims.roles,
        permissions: claims.permissions,
        session_id: claims.session_id,
      };
    } catch {
      return { active: false };
    }
  }

  /**
   * Revoke all tokens for a session
   */
  async revokeSessionTokens(sessionId: string): Promise<{ revoked: number }> {
    const result = await this.db.batch([
      this.db.prepare(`
        UPDATE app_tokens SET is_revoked = 1, revoked_at = datetime('now'), revoke_reason = 'session_revoked'
        WHERE account_session_id = ?
      `).bind(sessionId),
      this.db.prepare(`
        UPDATE refresh_tokens SET is_revoked = 1, revoked_at = datetime('now')
        WHERE session_id = ?
      `).bind(sessionId),
    ]);

    return { revoked: (result[0].meta.changes || 0) + (result[1].meta.changes || 0) };
  }

  /**
   * Revoke all tokens for a user
   */
  async revokeUserTokens(userId: string): Promise<{ revoked: number }> {
    // Get all account sessions for user
    const sessions = await this.db.prepare(`
      SELECT id FROM account_sessions WHERE user_id = ?
    `).bind(userId).all();

    const sessionIds = sessions.results.map(s => s.id as string);

    if (sessionIds.length === 0) {
      return { revoked: 0 };
    }

    const placeholders = sessionIds.map(() => '?').join(',');

    const result = await this.db.batch([
      this.db.prepare(`
        UPDATE app_tokens SET is_revoked = 1, revoked_at = datetime('now'), revoke_reason = 'user_logout'
        WHERE account_session_id IN (${placeholders})
      `).bind(...sessionIds),
      this.db.prepare(`
        UPDATE refresh_tokens SET is_revoked = 1, revoked_at = datetime('now')
        WHERE user_id = ?
      `).bind(userId),
    ]);

    return { revoked: (result[0].meta.changes || 0) + (result[1].meta.changes || 0) };
  }

  // Private helper methods

  private async verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
    try {
      const { payload } = await jwtVerify(token, async (header) => {
        const key = await this.db.prepare(`
          SELECT public_key FROM jwt_keys WHERE kid = ? AND status IN ('active', 'expiring')
        `).bind(header.kid).first();

        if (!key) throw new Error('Key not found');

        return crypto.subtle.importKey(
          'spki',
          this.base64ToArrayBuffer(key.public_key as string),
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          true,
          ['verify']
        );
      }, {
        issuer: this.issuer,
      });

      return payload as unknown as AccessTokenClaims;
    } catch {
      return null;
    }
  }

  private async getUserWithRoles(userId: string): Promise<{ email: string; roles: string[] } | null> {
    const user = await this.db.prepare(`
      SELECT u.email,
        GROUP_CONCAT(r.name) as roles
      FROM user u
      LEFT JOIN user_roles ur ON u.id = ur.user_id AND (ur.expires_at IS NULL OR ur.expires_at > datetime('now'))
      LEFT JOIN roles r ON ur.role_id = r.id
      WHERE u.id = ?
      GROUP BY u.id
    `).bind(userId).first();

    if (!user) return null;

    return {
      email: user.email as string,
      roles: user.roles ? (user.roles as string).split(',') : [],
    };
  }

  private async getEffectivePermissions(userId: string, clientId: string): Promise<string[]> {
    // Get permissions from user's roles that are also granted to the client
    const result = await this.db.prepare(`
      SELECT DISTINCT p.name
      FROM permissions p
      JOIN role_permissions rp ON p.id = rp.permission_id
      JOIN user_roles ur ON rp.role_id = ur.role_id
      JOIN client_permissions cp ON p.id = cp.permission_id
      WHERE ur.user_id = ?
      AND cp.client_id = ?
      AND (ur.expires_at IS NULL OR ur.expires_at > datetime('now'))
    `).bind(userId, clientId).all();

    return result.results.map(r => r.name as string);
  }

  private async generateRefreshToken(
    claims: RefreshTokenClaims,
    privateKey: CryptoKey,
    keyId: string
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);

    return new SignJWT({
      ...claims,
      iat: now,
      exp: now + this.REFRESH_TOKEN_LIFETIME,
    } as unknown as Record<string, unknown>)
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: keyId })
      .sign(privateKey);
  }

  private async storeAppToken(params: {
    id: string;
    accountSessionId: string;
    clientId: string;
    accessTokenHash: string;
    scope: string;
    audience: string;
    expiresAt: string;
  }): Promise<void> {
    await this.db.prepare(`
      INSERT INTO app_tokens (id, account_session_id, client_id, access_token_hash, scope, audience, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      params.id,
      params.accountSessionId,
      params.clientId,
      params.accessTokenHash,
      params.scope,
      params.audience,
      params.expiresAt
    ).run();
  }

  private async storeRefreshToken(params: {
    id: string;
    userId: string;
    clientId: string;
    tokenHash: string;
    scope: string;
    sessionId: string;
    expiresAt: string;
  }): Promise<void> {
    await this.db.prepare(`
      INSERT INTO refresh_tokens (id, user_id, client_id, token_hash, scope, session_id, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      params.id,
      params.userId,
      params.clientId,
      params.tokenHash,
      params.scope,
      params.sessionId,
      params.expiresAt
    ).run();
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}
```

---

## Token Exchange Endpoint

### File: apps/auth/src/routes/token-exchange.ts

```typescript
import { Hono } from 'hono';
import { TokenService } from '../services/token.service';
import { validateClientCredentials } from '../middleware/client-auth';
import type { Env } from '../types/env';

const tokenExchangeRoute = new Hono<{ Bindings: Env }>();

/**
 * POST /token/exchange
 * RFC 8693 Token Exchange
 */
tokenExchangeRoute.post('/exchange', validateClientCredentials, async (c) => {
  const body = await c.req.parseBody();

  const grantType = body.grant_type as string;
  if (grantType !== 'urn:ietf:params:oauth:grant-type:token-exchange') {
    return c.json({
      error: 'unsupported_grant_type',
      error_description: 'Only token exchange grant type is supported',
    }, 400);
  }

  const subjectToken = body.subject_token as string;
  const subjectTokenType = body.subject_token_type as string;
  const audience = body.audience as string;
  const scope = body.scope as string | undefined;

  if (!subjectToken || !audience) {
    return c.json({
      error: 'invalid_request',
      error_description: 'subject_token and audience are required',
    }, 400);
  }

  if (subjectTokenType !== 'urn:ietf:params:oauth:token-type:access_token') {
    return c.json({
      error: 'invalid_request',
      error_description: 'Only access_token type is supported for subject_token',
    }, 400);
  }

  try {
    const tokenService = new TokenService(
      c.env.AUTH_DB,
      c.env.ISSUER,
      () => getActiveSigningKey(c.env)
    );

    const tokens = await tokenService.exchangeToken({
      subjectToken,
      targetAudience: audience,
      requestedScope: scope,
    });

    return c.json({
      access_token: tokens.accessToken,
      token_type: tokens.tokenType,
      expires_in: tokens.expiresIn,
      scope: tokens.scope,
      issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    });
  } catch (error) {
    return c.json({
      error: 'invalid_grant',
      error_description: error instanceof Error ? error.message : 'Token exchange failed',
    }, 400);
  }
});

export default tokenExchangeRoute;
```

---

## Client Permission Management

### File: apps/auth/src/routes/admin/client-permissions.ts

```typescript
import { Hono } from 'hono';
import { requireAdmin } from '../middleware/admin-auth';
import type { Env } from '../../types/env';

const clientPermissionsRoute = new Hono<{ Bindings: Env }>();

/**
 * GET /admin/clients/:clientId/permissions
 * List permissions granted to a client
 */
clientPermissionsRoute.get('/:clientId/permissions', requireAdmin, async (c) => {
  const clientId = c.req.param('clientId');

  const permissions = await c.env.AUTH_DB.prepare(`
    SELECT p.id, p.name, p.description, p.resource, p.action, cp.granted_at
    FROM client_permissions cp
    JOIN permissions p ON cp.permission_id = p.id
    WHERE cp.client_id = ?
    ORDER BY p.resource, p.action
  `).bind(clientId).all();

  return c.json({
    clientId,
    permissions: permissions.results,
  });
});

/**
 * POST /admin/clients/:clientId/permissions
 * Grant permissions to a client
 * Body: { permissionIds: string[] }
 */
clientPermissionsRoute.post('/:clientId/permissions', requireAdmin, async (c) => {
  const clientId = c.req.param('clientId');
  const { permissionIds } = await c.req.json<{ permissionIds: string[] }>();

  if (!Array.isArray(permissionIds) || permissionIds.length === 0) {
    return c.json({ error: 'permissionIds array is required' }, 400);
  }

  // Insert permissions (ignore duplicates)
  const statements = permissionIds.map(permId =>
    c.env.AUTH_DB.prepare(`
      INSERT OR IGNORE INTO client_permissions (id, client_id, permission_id)
      VALUES (?, ?, ?)
    `).bind(`cp_${clientId}_${permId}`, clientId, permId)
  );

  await c.env.AUTH_DB.batch(statements);

  return c.json({ success: true, granted: permissionIds.length });
});

/**
 * DELETE /admin/clients/:clientId/permissions/:permissionId
 * Revoke permission from client
 */
clientPermissionsRoute.delete('/:clientId/permissions/:permissionId', requireAdmin, async (c) => {
  const clientId = c.req.param('clientId');
  const permissionId = c.req.param('permissionId');

  await c.env.AUTH_DB.prepare(`
    DELETE FROM client_permissions WHERE client_id = ? AND permission_id = ?
  `).bind(clientId, permissionId).run();

  return c.json({ success: true });
});

export default clientPermissionsRoute;
```

---

## Testing Requirements

### Unit Tests

#### File: apps/auth/src/services/__tests__/token.service.test.ts

```typescript
describe('TokenService', () => {
  describe('generateTokens', () => {
    it('should generate access token with all required standard claims', async () => {
      // Acceptance: Token contains iss, sub, aud, exp, iat, nbf, jti
    });

    it('should include custom claims in access token', async () => {
      // Acceptance: Token contains email, roles, permissions, scope, client_id, session_id
    });

    it('should compute permissions as intersection of user roles and client grants', async () => {
      // Setup: User has roles with permissions A, B, C
      //        Client has grants for permissions B, C, D
      // Acceptance: Token permissions = [B, C]
    });

    it('should include session_id binding in token', async () => {
      // Acceptance: claims.session_id matches provided sessionId
    });

    it('should include tenant_id when provided', async () => {
      // Acceptance: claims.tenant_id matches provided tenantId
    });

    it('should omit tenant_id when not provided', async () => {
      // Acceptance: claims.tenant_id is undefined
    });

    it('should include nonce when provided (for OIDC)', async () => {
      // Acceptance: claims.nonce matches provided nonce
    });

    it('should set correct expiration (1 hour for access token)', async () => {
      // Acceptance: exp - iat = 3600
    });

    it('should store app token reference in database', async () => {
      // Acceptance: app_tokens table has entry with correct hash
    });

    it('should generate refresh token with 7 day expiration', async () => {
      // Acceptance: Refresh token exp - iat = 604800
    });

    it('should store refresh token hash in database', async () => {
      // Acceptance: refresh_tokens table has entry with correct hash
    });

    it('should throw error for non-existent user', async () => {
      // Acceptance: Throws 'User not found'
    });

    it('should use correct signing key from key rotation', async () => {
      // Acceptance: JWT header kid matches active key
    });
  });

  describe('refreshTokens', () => {
    it('should generate new access token from valid refresh token', async () => {
      // Acceptance: Returns new accessToken, same user context
    });

    it('should rotate refresh token (old revoked, new issued)', async () => {
      // Acceptance: Old refresh token marked revoked in DB
      //            New refresh token returned
    });

    it('should reject expired refresh token', async () => {
      // Setup: Refresh token with past expiration
      // Acceptance: Throws 'Invalid or expired refresh token'
    });

    it('should reject revoked refresh token', async () => {
      // Setup: Refresh token with is_revoked = 1
      // Acceptance: Throws 'Invalid or expired refresh token'
    });

    it('should reject malformed refresh token', async () => {
      // Acceptance: Throws error
    });

    it('should preserve session binding in new tokens', async () => {
      // Acceptance: New token has same session_id as original
    });

    it('should preserve scope in new tokens', async () => {
      // Acceptance: New token has same scope as original
    });

    it('should use client audience from database', async () => {
      // Acceptance: New token aud matches client.audience
    });
  });

  describe('exchangeToken', () => {
    it('should exchange valid token for new audience', async () => {
      // Acceptance: Returns tokens with new aud claim
    });

    it('should reject invalid subject token', async () => {
      // Acceptance: Throws 'Invalid subject token'
    });

    it('should reject expired subject token', async () => {
      // Acceptance: Throws 'Invalid subject token'
    });

    it('should reject unknown target audience', async () => {
      // Acceptance: Throws 'Invalid target audience'
    });

    it('should preserve session context in exchanged token', async () => {
      // Acceptance: session_id unchanged
    });

    it('should preserve tenant context in exchanged token', async () => {
      // Acceptance: tenant_id unchanged
    });

    it('should use requested scope if provided', async () => {
      // Acceptance: New token scope = requestedScope
    });

    it('should fallback to original scope if not requested', async () => {
      // Acceptance: New token scope = original scope
    });

    it('should compute new permissions for target client', async () => {
      // Setup: Target client has different permission grants
      // Acceptance: Permissions reflect target client grants
    });
  });

  describe('introspect', () => {
    it('should return active:true for valid token', async () => {
      // Acceptance: { active: true, ...claims }
    });

    it('should return active:false for expired token', async () => {
      // Acceptance: { active: false }
    });

    it('should return active:false for revoked token', async () => {
      // Setup: Token in app_tokens with is_revoked = 1
      // Acceptance: { active: false }
    });

    it('should return active:false for malformed token', async () => {
      // Acceptance: { active: false }
    });

    it('should return active:false for token with invalid signature', async () => {
      // Acceptance: { active: false }
    });

    it('should include all standard claims in response', async () => {
      // Acceptance: Response includes scope, client_id, username, token_type,
      //            exp, iat, nbf, sub, aud, iss, jti
    });

    it('should include custom claims in response', async () => {
      // Acceptance: Response includes roles, permissions, session_id
    });

    it('should not leak sensitive data in error case', async () => {
      // Acceptance: Only { active: false } returned, no error details
    });
  });

  describe('revokeSessionTokens', () => {
    it('should revoke all app_tokens for session', async () => {
      // Setup: 5 app_tokens with session_id
      // Acceptance: All 5 have is_revoked = 1
    });

    it('should revoke all refresh_tokens for session', async () => {
      // Setup: 2 refresh_tokens with session_id
      // Acceptance: All 2 have is_revoked = 1
    });

    it('should set revoke_reason to session_revoked', async () => {
      // Acceptance: revoke_reason = 'session_revoked'
    });

    it('should set revoked_at timestamp', async () => {
      // Acceptance: revoked_at is set to current time
    });

    it('should return count of revoked tokens', async () => {
      // Acceptance: { revoked: 7 } for 5 app + 2 refresh
    });

    it('should handle session with no tokens', async () => {
      // Acceptance: { revoked: 0 }
    });
  });

  describe('revokeUserTokens', () => {
    it('should revoke tokens across all user sessions', async () => {
      // Setup: User has 3 sessions, each with tokens
      // Acceptance: All tokens revoked
    });

    it('should set revoke_reason to user_logout', async () => {
      // Acceptance: revoke_reason = 'user_logout'
    });

    it('should return total count', async () => {
      // Acceptance: Returns sum of all revoked tokens
    });

    it('should handle user with no sessions', async () => {
      // Acceptance: { revoked: 0 }
    });
  });
});
```

### Token Exchange Endpoint Tests

```typescript
describe('Token Exchange Endpoint', () => {
  describe('POST /token/exchange', () => {
    it('should return 400 for unsupported grant_type', async () => {
      // Test: grant_type: 'authorization_code'
      // Acceptance: { error: 'unsupported_grant_type' }, status 400
    });

    it('should return 400 for missing subject_token', async () => {
      // Acceptance: { error: 'invalid_request', error_description: 'subject_token and audience are required' }
    });

    it('should return 400 for missing audience', async () => {
      // Acceptance: { error: 'invalid_request', error_description: 'subject_token and audience are required' }
    });

    it('should return 400 for unsupported subject_token_type', async () => {
      // Test: subject_token_type: 'urn:ietf:params:oauth:token-type:refresh_token'
      // Acceptance: { error: 'invalid_request', error_description: 'Only access_token type is supported' }
    });

    it('should return 400 for invalid subject_token', async () => {
      // Acceptance: { error: 'invalid_grant', error_description: 'Invalid subject token' }
    });

    it('should return 400 for unknown target audience', async () => {
      // Acceptance: { error: 'invalid_grant', error_description: 'Invalid target audience' }
    });

    it('should return tokens with correct response format', async () => {
      // Acceptance: {
      //   access_token: string,
      //   token_type: 'Bearer',
      //   expires_in: 3600,
      //   scope: string,
      //   issued_token_type: 'urn:ietf:params:oauth:token-type:access_token'
      // }
    });

    it('should require client authentication', async () => {
      // Test: No client credentials
      // Acceptance: 401 Unauthorized
    });
  });
});
```

### Client Permissions Tests

```typescript
describe('Client Permissions Routes', () => {
  describe('GET /admin/clients/:clientId/permissions', () => {
    it('should return all permissions for client', async () => {
      // Acceptance: Array of permissions with id, name, description, resource, action
    });

    it('should include granted_at timestamp', async () => {
      // Acceptance: Each permission has granted_at
    });

    it('should order by resource, action', async () => {
      // Acceptance: Results sorted alphabetically
    });

    it('should require admin authentication', async () => {
      // Acceptance: 401/403 without admin role
    });

    it('should return empty array for client with no permissions', async () => {
      // Acceptance: { clientId, permissions: [] }
    });
  });

  describe('POST /admin/clients/:clientId/permissions', () => {
    it('should grant permissions to client', async () => {
      // Acceptance: Permissions added to client_permissions table
    });

    it('should return 400 for empty permissionIds array', async () => {
      // Acceptance: { error: 'permissionIds array is required' }
    });

    it('should return 400 for non-array permissionIds', async () => {
      // Acceptance: { error: 'permissionIds array is required' }
    });

    it('should ignore duplicate permissions', async () => {
      // Acceptance: INSERT OR IGNORE behavior, no error
    });

    it('should return count of granted permissions', async () => {
      // Acceptance: { success: true, granted: N }
    });
  });

  describe('DELETE /admin/clients/:clientId/permissions/:permissionId', () => {
    it('should revoke permission from client', async () => {
      // Acceptance: Entry removed from client_permissions
    });

    it('should succeed for non-existent permission (idempotent)', async () => {
      // Acceptance: { success: true }
    });
  });
});
```

### Token Expiration & Cleanup Tests

```typescript
describe('Token Expiration & Cleanup', () => {
  describe('cleanupExpiredSessions', () => {
    it('should delete expired browser sessions', async () => {
      // Setup: 3 expired, 2 valid browser sessions
      // Acceptance: browserSessionsDeleted = 3
    });

    it('should delete revoked browser sessions', async () => {
      // Setup: 2 revoked browser sessions
      // Acceptance: Sessions deleted
    });

    it('should cascade delete account sessions via FK', async () => {
      // Acceptance: account_sessions for deleted browser_sessions also gone
    });

    it('should delete expired refresh tokens', async () => {
      // Setup: 5 expired refresh tokens
      // Acceptance: refreshTokensDeleted = 5
    });

    it('should delete revoked refresh tokens', async () => {
      // Acceptance: Revoked tokens deleted
    });

    it('should delete expired app tokens', async () => {
      // Setup: 10 expired app tokens
      // Acceptance: appTokensDeleted = 10
    });

    it('should return counts in result', async () => {
      // Acceptance: {
      //   browserSessionsDeleted: N,
      //   refreshTokensDeleted: N,
      //   appTokensDeleted: N,
      //   timestamp: string
      // }
    });

    it('should be idempotent', async () => {
      // Test: Run twice
      // Acceptance: Second run deletes 0
    });
  });

  describe('Sliding Window Sessions', () => {
    it('should extend session expiry on activity', async () => {
      // Setup: Session expiring in 1 day
      // Test: Touch session
      // Acceptance: expires_at extended to 7 days from now
    });

    it('should update last_activity on touch', async () => {
      // Acceptance: last_activity = current time
    });

    it('should not extend already-expired sessions', async () => {
      // Setup: Expired session
      // Test: Touch
      // Acceptance: No error, but session still expired for queries
    });
  });
});
```

### Token Revocation Cascade Tests

```typescript
describe('Token Revocation Cascade', () => {
  describe('Browser Session Revocation', () => {
    it('should cascade to all account sessions', async () => {
      // Setup: Browser session with 3 accounts
      // Test: Revoke browser session
      // Acceptance: All 3 account_sessions have is_revoked = 1
    });

    it('should cascade to all tokens via account sessions', async () => {
      // Setup: Each account has 2 tokens
      // Acceptance: All 6 tokens revoked
    });
  });

  describe('Account Session Revocation', () => {
    it('should revoke all tokens for that session only', async () => {
      // Setup: Browser with accounts A (2 tokens), B (2 tokens)
      // Test: Revoke account A session
      // Acceptance: A's 2 tokens revoked, B's 2 tokens active
    });

    it('should not affect other accounts in same browser', async () => {
      // Acceptance: Account B still active
    });
  });

  describe('Introspection After Revocation', () => {
    it('should return active:false immediately after session revoked', async () => {
      // Test: Generate token, revoke session, introspect
      // Acceptance: active: false
    });

    it('should return active:false for JWT even if signature valid', async () => {
      // Note: JWT signature is valid, but session check fails
      // Acceptance: active: false
    });
  });
});
```

### E2E Tests

```typescript
test.describe('Token Architecture E2E', () => {
  test('tokens have correct audience claim', async ({ request }) => {
    const tokens = await getTokensForClient(request, 'app-a');
    const decoded = decodeJwt(tokens.access_token);

    expect(decoded.aud).toBe('app-a');
  });

  test('token includes session binding', async ({ request, page }) => {
    await loginAs(page, 'user@test.com');
    const tokens = await getTokens(page);
    const decoded = decodeJwt(tokens.access_token);

    expect(decoded.session_id).toBeDefined();
    expect(decoded.session_id).toMatch(/^as_/);
  });

  test('token includes computed permissions', async ({ request }) => {
    // Setup: User with editor role, client with edit permissions
    const tokens = await getTokensForClient(request, 'app-with-permissions');
    const decoded = decodeJwt(tokens.access_token);

    expect(decoded.permissions).toBeInstanceOf(Array);
    expect(decoded.permissions.length).toBeGreaterThan(0);
  });

  test('token exchange returns token for new audience', async ({ request }) => {
    const originalTokens = await getTokensForClient(request, 'app-a');

    const response = await request.post('/token/exchange', {
      data: {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: originalTokens.access_token,
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        audience: 'app-b',
      },
    });

    expect(response.ok()).toBe(true);
    const newTokens = await response.json();
    const decoded = decodeJwt(newTokens.access_token);

    expect(decoded.aud).toBe('app-b');
    expect(decoded.sub).toBe(decodeJwt(originalTokens.access_token).sub);
    expect(decoded.session_id).toBe(decodeJwt(originalTokens.access_token).session_id);
  });

  test('exchanged token has different permissions per client', async ({ request }) => {
    // Setup: app-a has permissions [A, B], app-b has permissions [B, C]
    const appATokens = await getTokensForClient(request, 'app-a');

    const response = await request.post('/token/exchange', {
      data: {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: appATokens.access_token,
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        audience: 'app-b',
      },
    });

    const appBTokens = await response.json();
    const appADecoded = decodeJwt(appATokens.access_token);
    const appBDecoded = decodeJwt(appBTokens.access_token);

    // Permissions should differ based on client grants
    expect(appADecoded.permissions).not.toEqual(appBDecoded.permissions);
  });

  test('token introspection returns correct claims', async ({ request }) => {
    const tokens = await getTokensForClient(request, 'app-a');

    const response = await request.post('/token/introspect', {
      data: { token: tokens.access_token },
    });

    const introspection = await response.json();

    expect(introspection.active).toBe(true);
    expect(introspection.client_id).toBe('app-a');
    expect(introspection.permissions).toBeDefined();
    expect(introspection.session_id).toBeDefined();
  });

  test('revoked token returns inactive on introspection', async ({ request, page }) => {
    await loginAs(page, 'user@test.com');
    const tokens = await getTokens(page);

    // Revoke via logout
    await page.request.delete('/session/all');

    const response = await request.post('/token/introspect', {
      data: { token: tokens.access_token },
    });

    expect((await response.json()).active).toBe(false);
  });

  test('refresh token rotation works correctly', async ({ request, page }) => {
    await loginAs(page, 'user@test.com');
    const { refreshToken } = await getTokens(page);

    // Use refresh token
    const response1 = await request.post('/token', {
      data: { grant_type: 'refresh_token', refresh_token: refreshToken },
    });
    expect(response1.ok()).toBe(true);
    const newTokens = await response1.json();

    // Old refresh token should now be invalid
    const response2 = await request.post('/token', {
      data: { grant_type: 'refresh_token', refresh_token: refreshToken },
    });
    expect(response2.ok()).toBe(false);
    expect((await response2.json()).error).toBe('invalid_grant');

    // New refresh token should work
    const response3 = await request.post('/token', {
      data: { grant_type: 'refresh_token', refresh_token: newTokens.refresh_token },
    });
    expect(response3.ok()).toBe(true);
  });

  test('session revocation invalidates all session tokens', async ({ request, page, context }) => {
    await loginAs(page, 'user@test.com');

    // Get tokens for 2 different apps
    const appATokens = await getTokensForClient(request, 'app-a');
    const appBTokens = await getTokensForClient(request, 'app-b');

    // Sign out from one account
    await page.request.delete('/session/all');

    // Both tokens should be revoked
    const introspectA = await request.post('/token/introspect', {
      data: { token: appATokens.access_token },
    });
    const introspectB = await request.post('/token/introspect', {
      data: { token: appBTokens.access_token },
    });

    expect((await introspectA.json()).active).toBe(false);
    expect((await introspectB.json()).active).toBe(false);
  });
});
```

### Coverage Requirements

| Component | Target Coverage |
|-----------|----------------|
| TokenService | >90% |
| Token Exchange Endpoint | >90% |
| Client Permissions Routes | >80% |
| Introspection | 100% |
| Token Revocation | 100% |
| Cleanup Job | >80% |

**Overall Lane 4 Coverage Target: >85%**

**Critical Path Coverage**: The following must have 100% coverage:
- Token verification logic
- Refresh token rotation
- Session binding validation
- Revocation cascade

---

## Rollout Checklist

- [ ] Create migration 0025_app_tokens.sql
- [ ] Create migration 0026_oauth_clients_audience.sql
- [ ] Apply migrations locally
- [ ] Implement TokenService
- [ ] Implement token exchange endpoint
- [ ] Implement client permissions routes
- [ ] Update existing token generation to use new service
- [ ] Update introspection endpoint
- [ ] Write unit tests (>80% coverage)
- [ ] Write E2E tests
- [ ] Update OpenAuth integration
- [ ] Document token exchange flow
- [ ] Apply migrations to QA
- [ ] Performance test token generation

---

## Estimated Effort
- Database migrations: 1-2 hours
- TokenService: 6-8 hours
- Token exchange endpoint: 2-3 hours
- Client permissions management: 2-3 hours
- Integration with existing code: 4-6 hours
- Testing: 6-8 hours
- **Total: 21-30 hours**

## Security Considerations
- Tokens are bound to sessions (revocation cascades)
- Token exchange requires valid subject token
- Permissions are intersection of user's roles and client's grants
- All token operations are audited
- Token hashes stored, not raw tokens
- Key rotation support maintained
