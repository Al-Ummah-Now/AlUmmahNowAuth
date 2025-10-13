# JWT Token Implementation Guide

## Overview
This guide provides step-by-step instructions for implementing JWT access tokens with refresh token rotation in the Al Ummah Now authentication system.

## Prerequisites
- Cloudflare Workers environment with D1 database
- OpenAuth integration already configured
- Access to KV namespace for key storage

## Implementation Steps

### Step 1: Database Setup

#### 1.1 Create Refresh Tokens Table
Create a new migration file: `/apps/auth/migrations/0011_create_refresh_tokens_table.sql`

```sql
-- Migration number: 0011 	 2025-01-13T00:00:00.000Z
-- Create refresh tokens table for JWT token rotation
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    token_hash TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    issued_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL,
    last_used_at INTEGER,
    ip_address TEXT,
    user_agent TEXT,
    revoked INTEGER DEFAULT 0,  -- Using INTEGER for boolean (0/1)
    revoked_at INTEGER,
    revoked_reason TEXT,
    parent_token_id TEXT,
    rotation_count INTEGER DEFAULT 0,
    scope TEXT DEFAULT 'openid email profile',
    FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);

-- Create indexes for performance
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
CREATE INDEX idx_refresh_tokens_client_id ON refresh_tokens(client_id);

-- Create token usage analytics table
CREATE TABLE IF NOT EXISTS token_usage (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    token_id TEXT NOT NULL,
    action TEXT NOT NULL, -- 'generated', 'refreshed', 'revoked', 'expired'
    timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
    ip_address TEXT,
    user_agent TEXT,
    metadata TEXT, -- JSON string for additional data
    FOREIGN KEY (token_id) REFERENCES refresh_tokens(id) ON DELETE CASCADE
);

CREATE INDEX idx_token_usage_token_id ON token_usage(token_id);
CREATE INDEX idx_token_usage_timestamp ON token_usage(timestamp);
```

#### 1.2 Run Migration
```bash
npx wrangler d1 migrations apply al-ummah-now-d1 --local
npx wrangler d1 migrations apply al-ummah-now-d1 --remote
```

### Step 2: Key Management Service

#### 2.1 Create Key Service
File: `/apps/auth/src/services/key-service.ts`

```typescript
import { logger } from '../logger';

export interface SigningKey {
  kid: string;
  privateKey: string;
  publicKey: string;
  algorithm: 'RS256';
  createdAt: number;
  expiresAt: number;
}

export interface JWKS {
  keys: Array<{
    kty: string;
    use: string;
    kid: string;
    alg: string;
    n: string;
    e: string;
  }>;
}

export class KeyService {
  constructor(
    private storage: KVNamespace,
    private readonly keyRotationDays = 90
  ) {}

  /**
   * Get the current signing key
   */
  async getCurrentSigningKey(): Promise<SigningKey> {
    const currentKid = await this.storage.get('jwt:current_kid');

    if (!currentKid) {
      logger.info('No current key found, generating new key pair');
      return await this.generateNewKeyPair();
    }

    const keyData = await this.storage.get(`jwt:keys:${currentKid}`);
    if (!keyData) {
      logger.warn('Current key ID exists but key not found, generating new key pair');
      return await this.generateNewKeyPair();
    }

    const key = JSON.parse(keyData) as SigningKey;

    // Check if key is expired
    if (Date.now() > key.expiresAt) {
      logger.info('Current key expired, rotating keys');
      return await this.rotateKeys();
    }

    return key;
  }

  /**
   * Get all valid keys for token validation
   */
  async getValidationKeys(): Promise<SigningKey[]> {
    const keys: SigningKey[] = [];

    // List all keys with prefix
    const keyList = await this.storage.list({ prefix: 'jwt:keys:' });

    for (const key of keyList.keys) {
      const keyData = await this.storage.get(key.name);
      if (keyData) {
        const signingKey = JSON.parse(keyData) as SigningKey;
        // Include key if it's not expired or within grace period
        if (Date.now() < signingKey.expiresAt + 7 * 24 * 60 * 60 * 1000) {
          keys.push(signingKey);
        }
      }
    }

    return keys;
  }

  /**
   * Generate a new RSA key pair
   */
  private async generateNewKeyPair(): Promise<SigningKey> {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify']
    );

    const privateKey = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    const publicKey = await crypto.subtle.exportKey('spki', keyPair.publicKey);

    const kid = `key_${Date.now()}`;
    const now = Date.now();

    const signingKey: SigningKey = {
      kid,
      privateKey: this.arrayBufferToBase64(privateKey),
      publicKey: this.arrayBufferToBase64(publicKey),
      algorithm: 'RS256',
      createdAt: now,
      expiresAt: now + (this.keyRotationDays * 24 * 60 * 60 * 1000),
    };

    // Store the key
    await this.storage.put(
      `jwt:keys:${kid}`,
      JSON.stringify(signingKey),
      {
        expirationTtl: (this.keyRotationDays + 30) * 24 * 60 * 60 // Keep for grace period
      }
    );

    // Set as current key
    await this.storage.put('jwt:current_kid', kid);

    logger.info('Generated new RSA key pair', { kid });
    return signingKey;
  }

  /**
   * Rotate keys
   */
  async rotateKeys(): Promise<SigningKey> {
    const newKey = await this.generateNewKeyPair();

    logger.info('Key rotation completed', {
      newKid: newKey.kid,
      expiresAt: new Date(newKey.expiresAt).toISOString()
    });

    return newKey;
  }

  /**
   * Get JWKS for OIDC discovery
   */
  async getJWKS(): Promise<JWKS> {
    const keys = await this.getValidationKeys();

    const jwks: JWKS = {
      keys: await Promise.all(keys.map(async (key) => {
        const publicKey = await crypto.subtle.importKey(
          'spki',
          this.base64ToArrayBuffer(key.publicKey),
          {
            name: 'RSASSA-PKCS1-v1_5',
            hash: 'SHA-256',
          },
          true,
          ['verify']
        );

        const jwk = await crypto.subtle.exportKey('jwk', publicKey);

        return {
          kty: jwk.kty!,
          use: 'sig',
          kid: key.kid,
          alg: key.algorithm,
          n: jwk.n!,
          e: jwk.e!,
        };
      }))
    };

    return jwks;
  }

  /**
   * Utility: Convert ArrayBuffer to Base64
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Utility: Convert Base64 to ArrayBuffer
   */
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

### Step 3: Token Service Implementation

#### 3.1 Create Token Service
File: `/apps/auth/src/services/token-service.ts`

```typescript
import { SignJWT, jwtVerify, JWTPayload } from 'jose';
import { logger } from '../logger';
import { KeyService } from './key-service';
import * as v from 'valibot';

// Token configuration
const ACCESS_TOKEN_TTL = 15 * 60; // 15 minutes in seconds
const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60; // 7 days in seconds
const REFRESH_GRACE_PERIOD = 2 * 60; // 2 minutes grace period

export interface User {
  id: string;
  email: string;
  role: string;
}

export interface AccessTokenPayload extends JWTPayload {
  sub: string;
  email: string;
  role: string;
  client_id: string;
  scope: string;
}

export interface RefreshTokenRecord {
  id: string;
  token_hash: string;
  user_id: string;
  client_id: string;
  issued_at: number;
  expires_at: number;
  last_used_at?: number;
  ip_address?: string;
  user_agent?: string;
  revoked: boolean;
  revoked_at?: number;
  revoked_reason?: string;
  parent_token_id?: string;
  rotation_count: number;
  scope: string;
}

export interface TokenPair {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

const RefreshTokenSchema = v.object({
  grant_type: v.literal('refresh_token'),
  refresh_token: v.string(),
  client_id: v.string(),
  scope: v.optional(v.string()),
});

export class TokenService {
  private keyService: KeyService;

  constructor(
    private env: Env,
    private storage: KVNamespace
  ) {
    this.keyService = new KeyService(storage);
  }

  /**
   * Generate a new access token
   */
  async generateAccessToken(user: User, clientId: string, scope: string = 'openid email profile'): Promise<string> {
    const signingKey = await this.keyService.getCurrentSigningKey();

    // Import the private key
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      this.base64ToArrayBuffer(signingKey.privateKey),
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['sign']
    );

    const now = Math.floor(Date.now() / 1000);
    const jti = crypto.randomUUID();

    const jwt = await new SignJWT({
      email: user.email,
      role: user.role,
      client_id: clientId,
      scope: scope,
    })
      .setProtectedHeader({ alg: signingKey.algorithm, kid: signingKey.kid })
      .setIssuer('https://auth.alummahnow.net')
      .setSubject(user.id)
      .setAudience(['https://api.alummahnow.net'])
      .setExpirationTime(now + ACCESS_TOKEN_TTL)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setJti(jti)
      .sign(privateKey);

    logger.info('Access token generated', {
      userId: user.id,
      clientId,
      jti,
      expiresIn: ACCESS_TOKEN_TTL,
    });

    return jwt;
  }

  /**
   * Generate a new refresh token
   */
  async generateRefreshToken(
    userId: string,
    clientId: string,
    request?: Request,
    parentTokenId?: string
  ): Promise<string> {
    const token = crypto.randomUUID();
    const tokenHash = await this.hashToken(token);
    const now = Math.floor(Date.now() / 1000);

    // Get parent token's rotation count if exists
    let rotationCount = 0;
    if (parentTokenId) {
      const parentToken = await this.env.AUTH_DB.prepare(
        `SELECT rotation_count FROM refresh_tokens WHERE id = ?`
      )
        .bind(parentTokenId)
        .first<{ rotation_count: number }>();

      if (parentToken) {
        rotationCount = parentToken.rotation_count + 1;

        // Prevent infinite rotation chains
        if (rotationCount > 100) {
          logger.error('Rotation count exceeded maximum', {
            userId,
            clientId,
            rotationCount,
          });
          throw new Error('Maximum token rotation count exceeded');
        }
      }
    }

    // Store in database
    const result = await this.env.AUTH_DB.prepare(
      `INSERT INTO refresh_tokens (
        token_hash, user_id, client_id, issued_at, expires_at,
        ip_address, user_agent, parent_token_id, rotation_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id`
    )
      .bind(
        tokenHash,
        userId,
        clientId,
        now,
        now + REFRESH_TOKEN_TTL,
        request ? this.getClientIP(request) : null,
        request ? request.headers.get('User-Agent') : null,
        parentTokenId,
        rotationCount
      )
      .first<{ id: string }>();

    if (!result) {
      throw new Error('Failed to create refresh token');
    }

    logger.info('Refresh token generated', {
      tokenId: result.id,
      userId,
      clientId,
      rotationCount,
      parentTokenId,
    });

    // Log token generation event
    await this.logTokenUsage(result.id, 'generated', request);

    return token;
  }

  /**
   * Verify and decode an access token
   */
  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    const keys = await this.keyService.getValidationKeys();

    for (const key of keys) {
      try {
        const publicKey = await crypto.subtle.importKey(
          'spki',
          this.base64ToArrayBuffer(key.publicKey),
          {
            name: 'RSASSA-PKCS1-v1_5',
            hash: 'SHA-256',
          },
          false,
          ['verify']
        );

        const { payload } = await jwtVerify(token, publicKey, {
          issuer: 'https://auth.alummahnow.net',
          audience: 'https://api.alummahnow.net',
        });

        return payload as AccessTokenPayload;
      } catch (error) {
        // Try next key
        continue;
      }
    }

    throw new Error('Invalid access token');
  }

  /**
   * Validate a refresh token
   */
  async validateRefreshToken(token: string): Promise<RefreshTokenRecord | null> {
    const tokenHash = await this.hashToken(token);

    const record = await this.env.AUTH_DB.prepare(
      `SELECT * FROM refresh_tokens WHERE token_hash = ?`
    )
      .bind(tokenHash)
      .first<RefreshTokenRecord>();

    if (!record) {
      logger.warn('Refresh token not found', { tokenHash: tokenHash.substring(0, 10) });
      return null;
    }

    const now = Math.floor(Date.now() / 1000);

    // Check if token is expired
    if (now > record.expires_at) {
      logger.warn('Refresh token expired', {
        tokenId: record.id,
        expiredAt: new Date(record.expires_at * 1000).toISOString(),
      });
      return null;
    }

    // Check if token is revoked
    if (record.revoked) {
      logger.warn('Attempted use of revoked refresh token', {
        tokenId: record.id,
        revokedAt: record.revoked_at,
        reason: record.revoked_reason,
      });

      // Revoke entire token chain for security
      await this.revokeTokenChain(record.id, 'Attempted reuse of revoked token');

      return null;
    }

    return record;
  }

  /**
   * Refresh token pair
   */
  async refreshTokenPair(refreshToken: string, request?: Request): Promise<TokenPair> {
    const tokenRecord = await this.validateRefreshToken(refreshToken);

    if (!tokenRecord) {
      throw new Error('Invalid refresh token');
    }

    // Get user information
    const user = await this.env.AUTH_DB.prepare(
      `SELECT id, email, role FROM user WHERE id = ?`
    )
      .bind(tokenRecord.user_id)
      .first<User>();

    if (!user) {
      throw new Error('User not found');
    }

    // Check for token reuse within grace period
    if (tokenRecord.last_used_at) {
      const timeSinceLastUse = Math.floor(Date.now() / 1000) - tokenRecord.last_used_at;
      if (timeSinceLastUse < REFRESH_GRACE_PERIOD) {
        logger.info('Refresh token used within grace period', {
          tokenId: tokenRecord.id,
          timeSinceLastUse,
        });
        // Allow the refresh but don't rotate the token
        const accessToken = await this.generateAccessToken(user, tokenRecord.client_id, tokenRecord.scope);

        return {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: ACCESS_TOKEN_TTL,
          refresh_token: refreshToken, // Return same refresh token
          scope: tokenRecord.scope,
        };
      }
    }

    // Update last used timestamp
    await this.env.AUTH_DB.prepare(
      `UPDATE refresh_tokens SET last_used_at = ? WHERE id = ?`
    )
      .bind(Math.floor(Date.now() / 1000), tokenRecord.id)
      .run();

    // Log token refresh event
    await this.logTokenUsage(tokenRecord.id, 'refreshed', request);

    // Generate new token pair with rotation
    const [newAccessToken, newRefreshToken] = await Promise.all([
      this.generateAccessToken(user, tokenRecord.client_id, tokenRecord.scope),
      this.generateRefreshToken(user.id, tokenRecord.client_id, request, tokenRecord.id),
    ]);

    // Revoke the old refresh token (with grace period)
    setTimeout(() => {
      this.revokeRefreshToken(refreshToken, 'Token rotated').catch((error) => {
        logger.error('Failed to revoke rotated token', { error });
      });
    }, REFRESH_GRACE_PERIOD * 1000);

    logger.info('Token pair refreshed', {
      userId: user.id,
      oldTokenId: tokenRecord.id,
      rotationCount: tokenRecord.rotation_count + 1,
    });

    return {
      access_token: newAccessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: newRefreshToken,
      scope: tokenRecord.scope,
    };
  }

  /**
   * Revoke a refresh token
   */
  async revokeRefreshToken(token: string, reason: string): Promise<void> {
    const tokenHash = await this.hashToken(token);
    const now = Math.floor(Date.now() / 1000);

    const result = await this.env.AUTH_DB.prepare(
      `UPDATE refresh_tokens
       SET revoked = 1, revoked_at = ?, revoked_reason = ?
       WHERE token_hash = ?
       RETURNING id`
    )
      .bind(now, reason, tokenHash)
      .first<{ id: string }>();

    if (result) {
      logger.info('Refresh token revoked', {
        tokenId: result.id,
        reason,
      });

      // Log revocation event
      await this.logTokenUsage(result.id, 'revoked');
    }
  }

  /**
   * Revoke entire token chain
   */
  async revokeTokenChain(tokenId: string, reason: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    // Find all tokens in the chain
    const tokens = await this.env.AUTH_DB.prepare(
      `WITH RECURSIVE token_chain AS (
        SELECT id, parent_token_id FROM refresh_tokens WHERE id = ?
        UNION ALL
        SELECT rt.id, rt.parent_token_id
        FROM refresh_tokens rt
        INNER JOIN token_chain tc ON rt.parent_token_id = tc.id OR rt.id = tc.parent_token_id
      )
      SELECT id FROM token_chain`
    )
      .bind(tokenId)
      .all<{ id: string }>();

    if (tokens.results && tokens.results.length > 0) {
      const tokenIds = tokens.results.map(t => t.id);

      // Revoke all tokens in the chain
      await this.env.AUTH_DB.prepare(
        `UPDATE refresh_tokens
         SET revoked = 1, revoked_at = ?, revoked_reason = ?
         WHERE id IN (${tokenIds.map(() => '?').join(',')})`
      )
        .bind(now, reason, ...tokenIds)
        .run();

      logger.warn('Token chain revoked', {
        rootTokenId: tokenId,
        chainLength: tokenIds.length,
        reason,
      });
    }
  }

  /**
   * Revoke all tokens for a user
   */
  async revokeAllUserTokens(userId: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    const result = await this.env.AUTH_DB.prepare(
      `UPDATE refresh_tokens
       SET revoked = 1, revoked_at = ?, revoked_reason = ?
       WHERE user_id = ? AND revoked = 0`
    )
      .bind(now, 'User tokens revoked', userId)
      .run();

    logger.info('All user tokens revoked', {
      userId,
      tokensRevoked: result.meta?.changes || 0,
    });
  }

  /**
   * Clean up expired tokens
   */
  async cleanupExpiredTokens(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const cutoffTime = now - (30 * 24 * 60 * 60); // 30 days ago

    const result = await this.env.AUTH_DB.prepare(
      `DELETE FROM refresh_tokens
       WHERE expires_at < ? OR (revoked = 1 AND revoked_at < ?)`
    )
      .bind(cutoffTime, cutoffTime)
      .run();

    logger.info('Expired tokens cleaned up', {
      tokensDeleted: result.meta?.changes || 0,
    });
  }

  /**
   * Log token usage for analytics
   */
  private async logTokenUsage(tokenId: string, action: string, request?: Request): Promise<void> {
    try {
      await this.env.AUTH_DB.prepare(
        `INSERT INTO token_usage (token_id, action, ip_address, user_agent)
         VALUES (?, ?, ?, ?)`
      )
        .bind(
          tokenId,
          action,
          request ? this.getClientIP(request) : null,
          request ? request.headers.get('User-Agent') : null
        )
        .run();
    } catch (error) {
      logger.warn('Failed to log token usage', { error, tokenId, action });
    }
  }

  /**
   * Hash a token using SHA-256
   */
  private async hashToken(token: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(token);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Get client IP from request
   */
  private getClientIP(request: Request): string | null {
    return request.headers.get('CF-Connecting-IP') ||
           request.headers.get('X-Forwarded-For')?.split(',')[0] ||
           null;
  }

  /**
   * Convert Base64 to ArrayBuffer
   */
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

### Step 4: API Endpoints

#### 4.1 Token Endpoint
Add to `/apps/auth/src/index.ts`:

```typescript
// Add to imports
import { TokenService } from './services/token-service';

// In the fetch handler, add new route
if (url.pathname === '/token' && request.method === 'POST') {
  try {
    const body = await request.json();
    const tokenService = new TokenService(env, env.AUTH_STORAGE);

    if (body.grant_type === 'refresh_token') {
      const tokenPair = await tokenService.refreshTokenPair(body.refresh_token, request);

      return new Response(JSON.stringify(tokenPair), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      });
    }

    return new Response(JSON.stringify({ error: 'unsupported_grant_type' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    logger.error('Token endpoint error', { error });
    return new Response(JSON.stringify({ error: 'invalid_request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
```

#### 4.2 Introspection Endpoint
```typescript
if (url.pathname === '/introspect' && request.method === 'POST') {
  try {
    const body = await request.json();
    const tokenService = new TokenService(env, env.AUTH_STORAGE);

    if (body.token_type_hint === 'refresh_token') {
      const tokenRecord = await tokenService.validateRefreshToken(body.token);

      if (tokenRecord && !tokenRecord.revoked) {
        const now = Math.floor(Date.now() / 1000);
        return new Response(JSON.stringify({
          active: now < tokenRecord.expires_at,
          scope: tokenRecord.scope,
          client_id: tokenRecord.client_id,
          username: tokenRecord.user_id,
          exp: tokenRecord.expires_at,
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } else {
      // Assume access token
      try {
        const payload = await tokenService.verifyAccessToken(body.token);
        return new Response(JSON.stringify({
          active: true,
          scope: payload.scope,
          client_id: payload.client_id,
          username: payload.email,
          exp: payload.exp,
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch {
        // Invalid token
      }
    }

    return new Response(JSON.stringify({ active: false }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    logger.error('Introspection endpoint error', { error });
    return new Response(JSON.stringify({ error: 'invalid_request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
```

#### 4.3 Revocation Endpoint
```typescript
if (url.pathname === '/revoke' && request.method === 'POST') {
  try {
    const body = await request.json();
    const tokenService = new TokenService(env, env.AUTH_STORAGE);

    if (body.token_type_hint === 'refresh_token' || !body.token_type_hint) {
      await tokenService.revokeRefreshToken(body.token, 'Client requested revocation');
    }

    // Always return 200 OK per RFC 7009
    return new Response(null, { status: 200 });
  } catch (error) {
    logger.error('Revocation endpoint error', { error });
    // Still return 200 OK even on error per RFC 7009
    return new Response(null, { status: 200 });
  }
}
```

#### 4.4 JWKS Endpoint for OIDC Discovery
```typescript
if (url.pathname === '/.well-known/jwks.json') {
  const keyService = new KeyService(env.AUTH_STORAGE);
  const jwks = await keyService.getJWKS();

  return new Response(JSON.stringify(jwks), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
```

### Step 5: Update OpenAuth Success Handler

Update the success callback in `/apps/auth/src/index.ts`:

```typescript
success: async (oauthCtx, value) => {
  logger.info('Authentication successful', { email: value.email });
  try {
    const user = await getOrCreateUser(env, value.email);
    const isNewUser = user.isNew;

    // Generate tokens
    const tokenService = new TokenService(env, env.AUTH_STORAGE);
    const [accessToken, refreshToken] = await Promise.all([
      tokenService.generateAccessToken(
        { id: user.id, email: value.email, role: user.role },
        'profile-app'
      ),
      tokenService.generateRefreshToken(user.id, 'profile-app', request),
    ]);

    // Store tokens in session (for backward compatibility)
    const sessionData = {
      user: {
        id: user.id,
        email: value.email,
        role: user.role,
      },
      tokens: {
        access: accessToken,
        refresh: refreshToken,
      },
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    const sessionToken = await createSession(env.AUTH_STORAGE, sessionData);

    // Emit audit events...

    // Return with tokens in response
    return oauthCtx.subject("user", {
      id: user.id,
      email: value.email,
      role: user.role,
    });
  } catch (error) {
    // Handle error...
  }
}
```

### Step 6: Client Implementation

#### 6.1 Token Refresh Handler
File: `/apps/profile/src/lib/auth-client.ts`

```typescript
export class AuthClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(private authServerUrl: string) {}

  /**
   * Get a valid access token, refreshing if necessary
   */
  async getAccessToken(): Promise<string | null> {
    // Check if current token is still valid (with 1 minute buffer)
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.accessToken;
    }

    // Try to refresh
    if (this.refreshToken) {
      try {
        const response = await fetch(`${this.authServerUrl}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: this.refreshToken,
            client_id: 'profile-app',
          }),
        });

        if (response.ok) {
          const data = await response.json();
          this.accessToken = data.access_token;
          this.refreshToken = data.refresh_token;
          this.tokenExpiresAt = Date.now() + (data.expires_in * 1000);

          // Store in session
          await this.storeTokens(data.access_token, data.refresh_token);

          return this.accessToken;
        }
      } catch (error) {
        console.error('Token refresh failed:', error);
      }
    }

    return null;
  }

  /**
   * Make an authenticated request
   */
  async authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
    const token = await this.getAccessToken();

    if (!token) {
      throw new Error('No valid authentication token');
    }

    return fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${token}`,
      },
    });
  }

  /**
   * Store tokens in session storage
   */
  private async storeTokens(accessToken: string, refreshToken: string): Promise<void> {
    // Implementation depends on your session storage strategy
    // This is a placeholder
  }
}
```

### Step 7: Middleware for Protected Routes

File: `/apps/auth/src/middleware/auth.ts`

```typescript
import { TokenService } from '../services/token-service';

export async function requireAuth(request: Request, env: Env): Promise<User | Response> {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="api"',
      },
    });
  }

  const token = authHeader.substring(7);
  const tokenService = new TokenService(env, env.AUTH_STORAGE);

  try {
    const payload = await tokenService.verifyAccessToken(token);

    // Get full user information
    const user = await env.AUTH_DB.prepare(
      `SELECT id, email, role FROM user WHERE id = ?`
    )
      .bind(payload.sub)
      .first<User>();

    if (!user) {
      throw new Error('User not found');
    }

    return user;
  } catch (error) {
    logger.warn('Authentication failed', { error });
    return new Response(JSON.stringify({ error: 'invalid_token' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="api", error="invalid_token"',
      },
    });
  }
}

// Usage in routes
if (url.pathname === '/api/protected') {
  const authResult = await requireAuth(request, env);

  if (authResult instanceof Response) {
    return authResult;
  }

  const user = authResult;
  // Handle authenticated request...
}
```

### Step 8: Scheduled Token Cleanup

Add to `wrangler.json`:
```json
{
  "triggers": {
    "crons": ["0 2 * * *"]
  }
}
```

Add scheduled handler to `/apps/auth/src/index.ts`:
```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // ... existing code
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const tokenService = new TokenService(env, env.AUTH_STORAGE);
    await tokenService.cleanupExpiredTokens();
    logger.info('Scheduled token cleanup completed');
  }
} satisfies ExportedHandler<Env>;
```

## Testing the Implementation

### Manual Testing Steps

1. **Test Initial Authentication**:
   ```bash
   # Authenticate and get tokens
   curl -X POST https://auth.alummahnow.net/authorize \
     -H "Content-Type: application/json" \
     -d '{"email": "test@example.com"}'
   ```

2. **Test Token Refresh**:
   ```bash
   # Refresh tokens
   curl -X POST https://auth.alummahnow.net/token \
     -H "Content-Type: application/json" \
     -d '{
       "grant_type": "refresh_token",
       "refresh_token": "your-refresh-token",
       "client_id": "profile-app"
     }'
   ```

3. **Test Token Introspection**:
   ```bash
   # Check token status
   curl -X POST https://auth.alummahnow.net/introspect \
     -H "Content-Type: application/json" \
     -d '{
       "token": "your-token",
       "token_type_hint": "access_token"
     }'
   ```

4. **Test Token Revocation**:
   ```bash
   # Revoke a token
   curl -X POST https://auth.alummahnow.net/revoke \
     -H "Content-Type: application/json" \
     -d '{
       "token": "your-refresh-token",
       "token_type_hint": "refresh_token"
     }'
   ```

5. **Test Protected Endpoint**:
   ```bash
   # Access protected resource
   curl -X GET https://api.alummahnow.net/protected \
     -H "Authorization: Bearer your-access-token"
   ```

### Automated Tests

Create test file: `/apps/auth/tests/token-service.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { TokenService } from '../src/services/token-service';

describe('TokenService', () => {
  let tokenService: TokenService;

  beforeEach(() => {
    // Setup mock environment
    const mockEnv = {
      AUTH_DB: createMockD1(),
      AUTH_STORAGE: createMockKV(),
    };
    tokenService = new TokenService(mockEnv as any, mockEnv.AUTH_STORAGE);
  });

  describe('generateAccessToken', () => {
    it('should generate valid JWT with correct claims', async () => {
      const user = { id: 'user123', email: 'test@example.com', role: 'user' };
      const token = await tokenService.generateAccessToken(user, 'test-client');

      const payload = await tokenService.verifyAccessToken(token);
      expect(payload.sub).toBe(user.id);
      expect(payload.email).toBe(user.email);
      expect(payload.role).toBe(user.role);
      expect(payload.client_id).toBe('test-client');
    });

    it('should set correct expiration time', async () => {
      const user = { id: 'user123', email: 'test@example.com', role: 'user' };
      const token = await tokenService.generateAccessToken(user, 'test-client');

      const payload = await tokenService.verifyAccessToken(token);
      const now = Math.floor(Date.now() / 1000);
      expect(payload.exp).toBeGreaterThan(now);
      expect(payload.exp).toBeLessThanOrEqual(now + 900); // 15 minutes
    });
  });

  describe('refreshTokenPair', () => {
    it('should generate new token pair and rotate refresh token', async () => {
      // Create initial refresh token
      const initialToken = await tokenService.generateRefreshToken('user123', 'test-client');

      // Wait to avoid grace period
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Refresh the token
      const newPair = await tokenService.refreshTokenPair(initialToken);

      expect(newPair.access_token).toBeDefined();
      expect(newPair.refresh_token).toBeDefined();
      expect(newPair.refresh_token).not.toBe(initialToken);
    });

    it('should handle grace period correctly', async () => {
      const initialToken = await tokenService.generateRefreshToken('user123', 'test-client');

      // Immediately try to refresh (within grace period)
      const pair1 = await tokenService.refreshTokenPair(initialToken);
      const pair2 = await tokenService.refreshTokenPair(initialToken);

      // Should return same refresh token during grace period
      expect(pair1.refresh_token).toBe(initialToken);
      expect(pair2.refresh_token).toBe(initialToken);
    });
  });

  describe('revokeRefreshToken', () => {
    it('should mark token as revoked', async () => {
      const token = await tokenService.generateRefreshToken('user123', 'test-client');

      await tokenService.revokeRefreshToken(token, 'Test revocation');

      const validated = await tokenService.validateRefreshToken(token);
      expect(validated).toBeNull();
    });
  });

  describe('token rotation security', () => {
    it('should revoke entire chain on token reuse', async () => {
      const token1 = await tokenService.generateRefreshToken('user123', 'test-client');

      // Wait and rotate
      await new Promise(resolve => setTimeout(resolve, 3000));
      const pair2 = await tokenService.refreshTokenPair(token1);

      // Wait and rotate again
      await new Promise(resolve => setTimeout(resolve, 3000));
      const pair3 = await tokenService.refreshTokenPair(pair2.refresh_token);

      // Try to reuse old token (attack simulation)
      await expect(
        tokenService.refreshTokenPair(token1)
      ).rejects.toThrow('Invalid refresh token');

      // All tokens in chain should be revoked
      expect(await tokenService.validateRefreshToken(pair2.refresh_token)).toBeNull();
      expect(await tokenService.validateRefreshToken(pair3.refresh_token)).toBeNull();
    });
  });
});
```

## Security Best Practices

1. **Token Storage**:
   - Never store tokens in localStorage (XSS vulnerable)
   - Use httpOnly cookies or secure session storage
   - Implement proper CORS policies

2. **Token Validation**:
   - Always validate token signature
   - Check expiration time
   - Validate audience and issuer claims
   - Implement rate limiting on token endpoints

3. **Refresh Token Security**:
   - Store as hash in database
   - Bind to client_id and user_id
   - Implement rotation with grace period
   - Track IP and User-Agent for anomaly detection

4. **Key Management**:
   - Rotate signing keys regularly
   - Keep old keys for validation during grace period
   - Use RS256 for public key distribution
   - Store keys securely in KV namespace

5. **Monitoring**:
   - Log all token operations
   - Alert on suspicious patterns
   - Track rotation chains
   - Monitor for token reuse

## Troubleshooting

### Common Issues

1. **Token Verification Fails**:
   - Check key rotation timing
   - Verify issuer and audience claims
   - Ensure clock sync (allow small skew)

2. **Refresh Token Invalid**:
   - Check if token expired
   - Verify token hasn't been revoked
   - Check rotation count limit

3. **Race Conditions**:
   - Grace period handles concurrent refreshes
   - Use database transactions where possible
   - Implement retry logic with backoff

4. **Performance Issues**:
   - Cache validation keys in memory
   - Use database indexes efficiently
   - Implement connection pooling

## Deployment Checklist

- [ ] Run database migration for refresh_tokens table
- [ ] Generate initial RSA key pair
- [ ] Deploy updated auth service
- [ ] Update client applications with refresh logic
- [ ] Configure monitoring and alerts
- [ ] Test full authentication flow
- [ ] Document API changes for developers
- [ ] Set up scheduled cleanup job
- [ ] Review security configurations
- [ ] Plan key rotation schedule

## API Documentation

Document the new endpoints in your OpenAPI specification:

```yaml
paths:
  /token:
    post:
      summary: Exchange or refresh tokens
      requestBody:
        content:
          application/json:
            schema:
              oneOf:
                - type: object
                  properties:
                    grant_type:
                      type: string
                      enum: [refresh_token]
                    refresh_token:
                      type: string
                    client_id:
                      type: string
      responses:
        200:
          description: Token response
          content:
            application/json:
              schema:
                type: object
                properties:
                  access_token:
                    type: string
                  token_type:
                    type: string
                  expires_in:
                    type: integer
                  refresh_token:
                    type: string
                  scope:
                    type: string

  /introspect:
    post:
      summary: Check token status
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                token:
                  type: string
                token_type_hint:
                  type: string
                  enum: [access_token, refresh_token]
      responses:
        200:
          description: Token introspection response

  /revoke:
    post:
      summary: Revoke a token
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                token:
                  type: string
                token_type_hint:
                  type: string
                  enum: [access_token, refresh_token]
      responses:
        200:
          description: Token revoked

  /.well-known/jwks.json:
    get:
      summary: Get JSON Web Key Set
      responses:
        200:
          description: JWKS for token validation
```

## Conclusion

This implementation provides a robust, secure JWT token system with refresh token rotation that integrates seamlessly with the existing OpenAuth infrastructure. The design follows OAuth 2.0/OIDC standards while being optimized for the Cloudflare Workers edge environment.