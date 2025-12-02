# SDK Plan: @alummahnow/auth-client

## Overview

A TypeScript SDK for client applications to integrate with AlUmmahNow Auth. Built on top of OpenAuth's official client library, adding multi-account session management for our platform.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         @alummahnow/auth-client                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                         AuthClient (Main API)                        │    │
│  │  - Unified interface for all auth operations                         │    │
│  │  - Configurable, framework-agnostic                                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                      │                                       │
│            ┌─────────────────────────┼─────────────────────────┐            │
│            ▼                         ▼                         ▼            │
│  ┌─────────────────┐    ┌─────────────────────┐    ┌─────────────────┐     │
│  │  OAuthManager   │    │   SessionManager    │    │  TokenManager   │     │
│  │                 │    │                     │    │                 │     │
│  │  - login()      │    │  - getAccounts()    │    │  - store()      │     │
│  │  - silentLogin()│    │  - switchAccount()  │    │  - refresh()    │     │
│  │  - addAccount() │    │  - signOut()        │    │  - exchange()   │     │
│  │  - callback()   │    │  - getDevices()     │    │  - decode()     │     │
│  └────────┬────────┘    └─────────────────────┘    └────────┬────────┘     │
│           │                                                  │              │
│           ▼                                                  ▼              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    External Dependencies                             │    │
│  │  - @meywd/openauth/client (AlUmmahNow OpenAuth fork)                │    │
│  │  - jose (JWT handling / token decoding)                              │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Dependencies

| Package | Purpose | Why |
|---------|---------|-----|
| `@meywd/openauth` | OpenAuth client SDK (AlUmmahNow fork) | Our fork - handles PKCE, state, authorize, exchange, verify + enterprise features |
| `jose` | JWT operations | Decode tokens for claims extraction (verification done server-side) |

**Why use OpenAuth client?**
- Our auth server IS OpenAuth - use the native client
- OpenAuth client handles PKCE, state, code challenge automatically
- Built-in `authorize()`, `exchange()`, `verify()` methods
- Tight integration with OpenAuth server features
- We focus on multi-account session layer

### OpenAuth Client API Reference

```typescript
import { createClient } from "@meywd/openauth/client"

// Initialize client
const client = createClient({
  clientID: "my-client-id",
  issuer: "https://auth.example.com"
})

// 1. authorize() - Start authorization flow
const { challenge, url } = await client.authorize(redirectUri, "code", {
  pkce: true,        // Enable PKCE (recommended)
  prompt: "login",   // Optional OIDC prompt
  // ... additional parameters
})
// - challenge: Contains code_verifier for PKCE (store this!)
// - url: Authorization URL to redirect user to

// 2. exchange() - Exchange code for tokens
const result = await client.exchange(
  code,           // Authorization code from callback
  redirectUri,    // Must match authorize() call
  verifier        // PKCE code_verifier from challenge
)
// Returns: { tokens: { access, refresh }, err? }

// 3. verify() - Verify tokens and get subject claims
const verified = await client.verify(
  subjects,       // Array of subject types to accept
  accessToken,    // Access token to verify
  { refresh }     // Optional refresh token for rotation
)
// Returns: { subject, tokens?, err? }
```

Our SDK wraps these methods, adding:
- Multi-account session management
- React hooks and providers
- Token storage strategies
- Error handling and retry logic

### Enterprise Features (from meywd/openauth fork)

The SDK supports enterprise features when available:

```typescript
// Feature detection - check what the server supports
const info = await client.getAuthInfo()
console.log(info.features.introspection)  // true/false
console.log(info.features.revocation)     // true/false
console.log(info.validationMethod)        // 'jwt' | 'introspection'

// Hybrid validation strategy
// - JWT for regular operations (fast, client-side)
// - Introspection for sensitive operations (real-time, server-side)
const user = await client.checkAuth({
  preferIntrospection: true  // Use introspection if available
})

// Server-side logout with token revocation
async function logout() {
  if (revocationAvailable) {
    await client.revokeOnServer(refreshToken)
  }
  await client.clearLocalTokens()
}

// API Gateway middleware (for backend services)
const authMiddleware = await createAuthMiddleware({
  issuer: "https://auth.example.com",
  clientID: "api-gateway",
  clientSecret: process.env.CLIENT_SECRET,
})

// Force introspection for sensitive endpoints
app.delete("/api/users/:id",
  authMiddleware({ forceIntrospection: true }),
  handler
)
```

---

## Package Structure

```
packages/auth-client/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                    # Main exports
│   ├── client.ts                   # AuthClient class
│   ├── openauth/
│   │   ├── manager.ts              # OAuthManager - wraps @meywd/openauth/client
│   │   ├── storage.ts              # Challenge/state storage for PKCE
│   │   └── types.ts                # OpenAuth specific types
│   ├── session/
│   │   ├── manager.ts              # SessionManager - multi-account
│   │   └── types.ts                # Session types
│   ├── token/
│   │   ├── manager.ts              # TokenManager - storage & refresh
│   │   ├── storage.ts              # Token storage strategies
│   │   └── types.ts                # Token types
│   ├── react/
│   │   ├── provider.tsx            # AuthProvider
│   │   ├── hooks.ts                # useAuth, useAccounts, etc.
│   │   └── components/
│   │       └── AccountSwitcher.tsx # Ready-to-use component
│   ├── errors.ts                   # Error types
│   ├── types.ts                    # Shared types
│   └── utils.ts                    # Utilities
├── tests/
│   ├── client.test.ts
│   ├── oauth/
│   ├── session/
│   └── token/
└── README.md
```

---

## Core Implementation

### AuthClient (Main Entry Point)

```typescript
// File: packages/auth-client/src/client.ts

import { createClient } from '@openauthjs/openauth/client';
import { OAuthManager } from './openauth/manager';
import { SessionManager } from './session/manager';
import { TokenManager } from './token/manager';
import type {
  AuthClientConfig,
  AuthResult,
  Account,
  AccountsResponse,
  SignOutResult,
  SessionCheck,
  DevicesResponse,
  LoginOptions,
  TokenExchangeOptions,
} from './types';

export class AuthClient {
  private oauth: OAuthManager;
  private session: SessionManager;
  private tokens: TokenManager;
  public readonly config: AuthClientConfig;

  constructor(config: AuthClientConfig) {
    this.config = {
      ...config,
      scope: config.scope || 'openid profile email',
    };

    this.oauth = new OAuthManager(this.config);
    this.session = new SessionManager(this.config.authServerUrl);
    this.tokens = new TokenManager(this.config);
  }

  // ─────────────────────────────────────────────────────────────────
  // OAuth / OIDC Methods (delegated to OAuthManager)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Redirect user to login page
   */
  async login(options?: LoginOptions): Promise<void> {
    return this.oauth.login(options);
  }

  /**
   * Silent login - check for existing SSO session
   * Uses prompt=none, returns tokens if session exists
   */
  async silentLogin(): Promise<AuthResult> {
    return this.oauth.silentLogin();
  }

  /**
   * Add another account to browser session
   * Redirects to login with action=add_account
   */
  async addAccount(): Promise<void> {
    return this.oauth.addAccount();
  }

  /**
   * Show account selector
   * Uses prompt=select_account
   */
  async selectAccount(): Promise<void> {
    return this.oauth.selectAccount();
  }

  /**
   * Handle OAuth callback
   * Exchanges code for tokens
   */
  async handleCallback(callbackUrl?: string): Promise<AuthResult> {
    const result = await this.oauth.handleCallback(callbackUrl);

    // Store tokens
    await this.tokens.store(result);

    return result;
  }

  // ─────────────────────────────────────────────────────────────────
  // Session Methods (delegated to SessionManager)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Get all logged-in accounts in browser
   */
  async getAccounts(): Promise<AccountsResponse> {
    return this.session.getAccounts();
  }

  /**
   * Switch active account
   */
  async switchAccount(userId: string): Promise<void> {
    await this.session.switchAccount(userId);
    // Clear stored tokens - need fresh ones for new account
    await this.tokens.clear();
  }

  /**
   * Sign out one account (HARD sign-out - revokes all tokens)
   */
  async signOutAccount(userId: string): Promise<SignOutResult> {
    const result = await this.session.signOutAccount(userId);

    // Clear tokens if active account was signed out
    if (result.wasActive) {
      await this.tokens.clear();
    }

    return result;
  }

  /**
   * Sign out all accounts (destroys browser session)
   */
  async signOutAll(): Promise<void> {
    await this.session.signOutAll();
    await this.tokens.clear();
  }

  /**
   * Check current session status
   */
  async checkSession(): Promise<SessionCheck> {
    return this.session.checkSession();
  }

  /**
   * Get all user's sessions across devices
   */
  async getDevices(): Promise<DevicesResponse> {
    return this.session.getDevices();
  }

  /**
   * Revoke session on another device
   */
  async revokeDevice(sessionId: string): Promise<void> {
    return this.session.revokeDevice(sessionId);
  }

  // ─────────────────────────────────────────────────────────────────
  // Token Methods (delegated to TokenManager)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Get current access token (refreshes if needed)
   */
  async getAccessToken(): Promise<string | null> {
    return this.tokens.getAccessToken();
  }

  /**
   * Refresh tokens using refresh token
   */
  async refreshTokens(): Promise<AuthResult> {
    return this.tokens.refresh();
  }

  /**
   * Exchange token for different audience (cross-app)
   */
  async exchangeToken(options: TokenExchangeOptions): Promise<AuthResult> {
    return this.oauth.exchangeToken(options);
  }

  /**
   * Get decoded token claims (without verification)
   */
  getTokenClaims(): TokenClaims | null {
    return this.tokens.getClaims();
  }

  // ─────────────────────────────────────────────────────────────────
  // Utility Methods
  // ─────────────────────────────────────────────────────────────────

  /**
   * Check if user is authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    const token = await this.getAccessToken();
    return token !== null;
  }

  /**
   * Get current user from token claims
   */
  getCurrentUser(): { id: string; email: string; roles: string[] } | null {
    const claims = this.getTokenClaims();
    if (!claims) return null;

    return {
      id: claims.sub,
      email: claims.email,
      roles: claims.roles || [],
    };
  }

  /**
   * Create authorization header value
   */
  async getAuthHeader(): Promise<string | null> {
    const token = await this.getAccessToken();
    return token ? `Bearer ${token}` : null;
  }
}
```

### OAuthManager (OpenAuth Client Wrapper)

```typescript
// File: packages/auth-client/src/openauth/manager.ts

import { createClient, type Client } from '@meywd/openauth/client';
import { ChallengeStorage, createStorage } from './storage';
import type { AuthClientConfig, AuthResult, LoginOptions, TokenExchangeOptions } from '../types';
import { AuthError, AuthErrorCode } from '../errors';

/**
 * OAuthManager wraps OpenAuth's official client SDK
 * Handles PKCE, state management, and token exchange
 */
export class OAuthManager {
  private openauth: Client;
  private storage: ChallengeStorage;

  constructor(private config: AuthClientConfig) {
    // Initialize OpenAuth client
    this.openauth = createClient({
      clientID: config.clientId,
      issuer: config.authServerUrl,
    });

    this.storage = createStorage(config.challengeStorage || 'sessionStorage');
  }

  /**
   * Redirect to authorization endpoint
   * OpenAuth's authorize() handles PKCE and state automatically
   */
  async login(options?: LoginOptions): Promise<void> {
    // OpenAuth authorize returns { challenge, url }
    // - challenge: Contains code_verifier for PKCE (must be stored)
    // - url: Authorization URL to redirect to
    const { challenge, url } = await this.openauth.authorize(
      this.config.redirectUri,
      'code',
      {
        pkce: true,
        // Pass additional OIDC parameters
        ...this.buildAuthorizeOptions(options),
      }
    );

    // Store challenge for callback
    await this.storage.set('auth_challenge', JSON.stringify(challenge));

    // Redirect to authorization server
    window.location.href = url;
  }

  /**
   * Build authorize options from LoginOptions
   */
  private buildAuthorizeOptions(options?: LoginOptions): Record<string, string> {
    const params: Record<string, string> = {};

    if (options?.prompt) {
      params.prompt = options.prompt;
    }
    if (options?.loginHint) {
      params.login_hint = options.loginHint;
    }
    if (options?.accountHint) {
      params.account_hint = options.accountHint;
    }
    if (options?.maxAge !== undefined) {
      params.max_age = options.maxAge.toString();
    }
    if (options?.scope) {
      params.scope = options.scope;
    }

    return params;
  }

  /**
   * Silent login using hidden iframe with prompt=none
   */
  async silentLogin(): Promise<AuthResult> {
    const { challenge, url } = await this.openauth.authorize(
      this.config.redirectUri,
      'code',
      {
        pkce: true,
        prompt: 'none',
      }
    );

    // Store challenge
    await this.storage.set('auth_challenge', JSON.stringify(challenge));

    // Execute in hidden iframe
    return new Promise((resolve, reject) => {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';

      const timeout = setTimeout(() => {
        cleanup();
        reject(new AuthError(AuthErrorCode.TIMEOUT, 'Silent login timeout'));
      }, 10000);

      const handleMessage = async (event: MessageEvent) => {
        if (event.origin !== new URL(this.config.redirectUri).origin) return;

        try {
          const url = new URL(event.data);
          const result = await this.processCallback(url);
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          cleanup();
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        window.removeEventListener('message', handleMessage);
        iframe.remove();
      };

      window.addEventListener('message', handleMessage);
      iframe.src = url;
      document.body.appendChild(iframe);
    });
  }

  /**
   * Add another account - redirect with prompt=login
   */
  async addAccount(): Promise<void> {
    return this.login({ prompt: 'login' });
  }

  /**
   * Show account selector - use prompt=select_account
   */
  async selectAccount(): Promise<void> {
    return this.login({ prompt: 'select_account' });
  }

  /**
   * Handle OAuth callback
   */
  async handleCallback(callbackUrl?: string): Promise<AuthResult> {
    const url = new URL(callbackUrl || window.location.href);
    return this.processCallback(url);
  }

  /**
   * Process callback URL and exchange code for tokens
   * Uses OpenAuth's exchange() method
   */
  private async processCallback(url: URL): Promise<AuthResult> {
    // Check for error from authorization server
    const error = url.searchParams.get('error');
    if (error) {
      const description = url.searchParams.get('error_description') || error;
      throw new AuthError(error as AuthErrorCode, description);
    }

    // Get authorization code
    const code = url.searchParams.get('code');
    if (!code) {
      throw new AuthError(AuthErrorCode.INVALID_RESPONSE, 'No authorization code in callback');
    }

    // Retrieve stored challenge
    const storedChallenge = await this.storage.get('auth_challenge');
    if (!storedChallenge) {
      throw new AuthError(AuthErrorCode.PKCE_ERROR, 'No challenge found - session may have expired');
    }

    const challenge = JSON.parse(storedChallenge);
    await this.storage.remove('auth_challenge');

    // Exchange code for tokens using OpenAuth's exchange() method
    // This automatically handles PKCE verification
    const exchanged = await this.openauth.exchange(
      code,
      this.config.redirectUri,
      challenge.verifier // PKCE code_verifier from stored challenge
    );

    if (exchanged.err) {
      throw new AuthError(
        AuthErrorCode.TOKEN_EXCHANGE_FAILED,
        exchanged.err.message || 'Token exchange failed'
      );
    }

    const tokens = exchanged.tokens;

    return {
      success: true,
      accessToken: tokens.access,
      refreshToken: tokens.refresh,
      expiresIn: this.calculateExpiresIn(tokens.access),
      tokenType: 'Bearer',
      scope: this.config.scope || 'openid profile email',
    };
  }

  /**
   * Verify tokens using OpenAuth's verify() method
   * Returns subject claims if valid
   */
  async verifyTokens(accessToken: string, refreshToken?: string): Promise<{
    valid: boolean;
    subject?: any;
    tokens?: { access: string; refresh: string };
  }> {
    const result = await this.openauth.verify(
      this.getSubjectTypes(),
      accessToken,
      { refresh: refreshToken }
    );

    if (result.err) {
      return { valid: false };
    }

    return {
      valid: true,
      subject: result.subject,
      tokens: result.tokens,
    };
  }

  /**
   * Get configured subject types for verification
   */
  private getSubjectTypes(): string[] {
    // Return the subject types our auth server supports
    return ['user', 'client'];
  }

  /**
   * Calculate expires_in from JWT access token
   */
  private calculateExpiresIn(accessToken: string): number {
    try {
      // Decode JWT without verification (verification done server-side)
      const [, payload] = accessToken.split('.');
      const decoded = JSON.parse(atob(payload));

      if (decoded.exp) {
        const expiresIn = decoded.exp - Math.floor(Date.now() / 1000);
        return Math.max(0, expiresIn);
      }
    } catch {
      // Fall through to default
    }
    return 3600; // Default 1 hour
  }

  /**
   * Exchange token for different audience (cross-app token exchange)
   */
  async exchangeToken(options: TokenExchangeOptions): Promise<AuthResult> {
    // Token exchange endpoint - standard OAuth 2.0 token exchange
    const response = await fetch(`${this.config.authServerUrl}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: options.subjectToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        audience: options.targetAudience,
        scope: options.scope || '',
        client_id: this.config.clientId,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new AuthError(
        error.error || AuthErrorCode.TOKEN_EXCHANGE_FAILED,
        error.error_description || 'Token exchange failed'
      );
    }

    const result = await response.json();

    return {
      success: true,
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresIn: result.expires_in || 3600,
      tokenType: result.token_type || 'Bearer',
      scope: result.scope || options.scope || '',
    };
  }
}
```

### Challenge Storage (PKCE State)

```typescript
// File: packages/auth-client/src/openauth/storage.ts

export interface ChallengeStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * SessionStorage-based challenge storage (recommended)
 * Cleared when browser tab closes - good security
 */
class SessionStorageAdapter implements ChallengeStorage {
  async get(key: string): Promise<string | null> {
    return sessionStorage.getItem(key);
  }

  async set(key: string, value: string): Promise<void> {
    sessionStorage.setItem(key, value);
  }

  async remove(key: string): Promise<void> {
    sessionStorage.removeItem(key);
  }
}

/**
 * Memory-based challenge storage
 * Most secure - cleared on page refresh
 */
class MemoryStorageAdapter implements ChallengeStorage {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) || null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export type ChallengeStorageType = 'sessionStorage' | 'memory';

export function createStorage(type: ChallengeStorageType): ChallengeStorage {
  switch (type) {
    case 'sessionStorage':
      return new SessionStorageAdapter();
    case 'memory':
    default:
      return new MemoryStorageAdapter();
  }
}
```

### SessionManager (Multi-Account Sessions)

```typescript
// File: packages/auth-client/src/session/manager.ts

import type {
  AccountsResponse,
  SignOutResult,
  SessionCheck,
  DevicesResponse,
} from '../types';
import { AuthError, AuthErrorCode } from '../errors';

export class SessionManager {
  constructor(private baseUrl: string) {}

  /**
   * Get all logged-in accounts in current browser
   */
  async getAccounts(): Promise<AccountsResponse> {
    const response = await fetch(`${this.baseUrl}/session/accounts`, {
      credentials: 'include',
    });

    if (!response.ok) {
      if (response.status === 401) {
        return { accounts: [], activeAccount: null };
      }
      throw new AuthError(AuthErrorCode.SESSION_ERROR, 'Failed to get accounts');
    }

    return response.json();
  }

  /**
   * Switch active account
   */
  async switchAccount(userId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/session/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new AuthError(
        error.error || AuthErrorCode.SWITCH_FAILED,
        error.message || 'Failed to switch account'
      );
    }
  }

  /**
   * Sign out one account (HARD sign-out)
   */
  async signOutAccount(userId: string): Promise<SignOutResult> {
    const response = await fetch(`${this.baseUrl}/session/accounts/${userId}`, {
      method: 'DELETE',
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new AuthError(
        error.error || AuthErrorCode.SIGNOUT_FAILED,
        error.message || 'Failed to sign out account'
      );
    }

    return response.json();
  }

  /**
   * Sign out all accounts
   */
  async signOutAll(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/session/all`, {
      method: 'DELETE',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new AuthError(AuthErrorCode.SIGNOUT_FAILED, 'Failed to sign out');
    }
  }

  /**
   * Check current session status
   */
  async checkSession(): Promise<SessionCheck> {
    const response = await fetch(`${this.baseUrl}/session/check`, {
      credentials: 'include',
    });

    if (!response.ok && response.status !== 401) {
      throw new AuthError(AuthErrorCode.SESSION_ERROR, 'Failed to check session');
    }

    return response.json();
  }

  /**
   * Get all sessions for current user across devices
   */
  async getDevices(): Promise<DevicesResponse> {
    const response = await fetch(`${this.baseUrl}/session/devices`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new AuthError(AuthErrorCode.SESSION_ERROR, 'Failed to get devices');
    }

    return response.json();
  }

  /**
   * Revoke a session on another device
   */
  async revokeDevice(sessionId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/session/devices/${sessionId}`, {
      method: 'DELETE',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new AuthError(AuthErrorCode.REVOKE_FAILED, 'Failed to revoke session');
    }
  }
}
```

### TokenManager (Storage & Refresh)

```typescript
// File: packages/auth-client/src/token/manager.ts

import { decodeJwt } from 'jose';
import type { AuthClientConfig, AuthResult, TokenClaims } from '../types';
import { AuthError, AuthErrorCode } from '../errors';
import { TokenStorage, createStorage } from './storage';

export class TokenManager {
  private storage: TokenStorage;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private expiresAt: number = 0;

  constructor(private config: AuthClientConfig) {
    this.storage = createStorage(config.tokenStorage || 'memory');
    this.loadFromStorage();
  }

  /**
   * Load tokens from storage
   */
  private async loadFromStorage(): Promise<void> {
    const stored = await this.storage.get();
    if (stored) {
      this.accessToken = stored.accessToken;
      this.refreshToken = stored.refreshToken;
      this.expiresAt = stored.expiresAt;
    }
  }

  /**
   * Store tokens
   */
  async store(result: AuthResult): Promise<void> {
    this.accessToken = result.accessToken;
    this.refreshToken = result.refreshToken || null;
    this.expiresAt = Date.now() + (result.expiresIn * 1000);

    await this.storage.set({
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt,
    });
  }

  /**
   * Clear all tokens
   */
  async clear(): Promise<void> {
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    await this.storage.clear();
  }

  /**
   * Get access token (refreshes if expired)
   */
  async getAccessToken(): Promise<string | null> {
    // No token
    if (!this.accessToken) {
      return null;
    }

    // Token still valid (with 60 second buffer)
    if (Date.now() < this.expiresAt - 60000) {
      return this.accessToken;
    }

    // Try to refresh
    if (this.refreshToken) {
      try {
        await this.refresh();
        return this.accessToken;
      } catch {
        return null;
      }
    }

    return null;
  }

  /**
   * Refresh tokens
   */
  async refresh(): Promise<AuthResult> {
    if (!this.refreshToken) {
      throw new AuthError(AuthErrorCode.NO_REFRESH_TOKEN, 'No refresh token available');
    }

    const response = await fetch(`${this.config.authServerUrl}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      credentials: 'include',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.config.clientId,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new AuthError(
        error.error || AuthErrorCode.REFRESH_FAILED,
        error.error_description || 'Token refresh failed'
      );
    }

    const result = await response.json();

    const authResult: AuthResult = {
      success: true,
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresIn: result.expires_in || 3600,
      tokenType: result.token_type || 'Bearer',
      scope: result.scope || '',
    };

    await this.store(authResult);

    return authResult;
  }

  /**
   * Get decoded token claims
   */
  getClaims(): TokenClaims | null {
    if (!this.accessToken) return null;

    try {
      return decodeJwt(this.accessToken) as TokenClaims;
    } catch {
      return null;
    }
  }
}
```

### Token Storage Strategies

```typescript
// File: packages/auth-client/src/token/storage.ts

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

export interface TokenStorage {
  get(): Promise<StoredTokens | null>;
  set(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

export type StorageType = 'memory' | 'localStorage' | 'sessionStorage' | 'cookie';

/**
 * In-memory storage (most secure, lost on refresh)
 */
class MemoryStorage implements TokenStorage {
  private tokens: StoredTokens | null = null;

  async get(): Promise<StoredTokens | null> {
    return this.tokens;
  }

  async set(tokens: StoredTokens): Promise<void> {
    this.tokens = tokens;
  }

  async clear(): Promise<void> {
    this.tokens = null;
  }
}

/**
 * localStorage storage (persists across sessions)
 * WARNING: Vulnerable to XSS
 */
class LocalStorage implements TokenStorage {
  private readonly KEY = 'auth_tokens';

  async get(): Promise<StoredTokens | null> {
    try {
      const stored = localStorage.getItem(this.KEY);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  }

  async set(tokens: StoredTokens): Promise<void> {
    localStorage.setItem(this.KEY, JSON.stringify(tokens));
  }

  async clear(): Promise<void> {
    localStorage.removeItem(this.KEY);
  }
}

/**
 * sessionStorage storage (persists until tab closed)
 */
class SessionStorageImpl implements TokenStorage {
  private readonly KEY = 'auth_tokens';

  async get(): Promise<StoredTokens | null> {
    try {
      const stored = sessionStorage.getItem(this.KEY);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  }

  async set(tokens: StoredTokens): Promise<void> {
    sessionStorage.setItem(this.KEY, JSON.stringify(tokens));
  }

  async clear(): Promise<void> {
    sessionStorage.removeItem(this.KEY);
  }
}

/**
 * Create storage based on type
 */
export function createStorage(type: StorageType): TokenStorage {
  switch (type) {
    case 'localStorage':
      return new LocalStorage();
    case 'sessionStorage':
      return new SessionStorageImpl();
    case 'memory':
    default:
      return new MemoryStorage();
  }
}
```

---

## React Integration

### AuthProvider

```typescript
// File: packages/auth-client/src/react/provider.tsx

import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { AuthClient } from '../client';
import type { AuthClientConfig, Account, AccountsResponse, TokenClaims } from '../types';

interface AuthContextValue {
  // State
  isAuthenticated: boolean;
  isLoading: boolean;
  accounts: Account[];
  activeAccount: Account | null;
  user: { id: string; email: string; roles: string[] } | null;
  claims: TokenClaims | null;

  // Auth methods
  login: (options?: { prompt?: string }) => Promise<void>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;

  // Account methods
  switchAccount: (userId: string) => Promise<void>;
  addAccount: () => Promise<void>;
  refreshAccounts: () => Promise<void>;

  // Token methods
  getAccessToken: () => Promise<string | null>;
  getAuthHeader: () => Promise<string | null>;

  // Utilities
  client: AuthClient;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: ReactNode;
  config: AuthClientConfig;
  onAuthChange?: (isAuthenticated: boolean) => void;
  onError?: (error: Error) => void;
}

export function AuthProvider({
  children,
  config,
  onAuthChange,
  onError,
}: AuthProviderProps) {
  const [client] = useState(() => new AuthClient(config));
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccount, setActiveAccount] = useState<Account | null>(null);
  const [claims, setClaims] = useState<TokenClaims | null>(null);

  // Initialize auth state
  useEffect(() => {
    initializeAuth();
  }, []);

  // Notify on auth change
  useEffect(() => {
    onAuthChange?.(isAuthenticated);
  }, [isAuthenticated, onAuthChange]);

  async function initializeAuth() {
    setIsLoading(true);

    try {
      // Try silent login first (SSO)
      await client.silentLogin();
      await loadState();
    } catch (error: any) {
      // login_required is expected when no session
      if (error.code !== 'login_required') {
        console.error('Auth initialization error:', error);
        onError?.(error);
      }

      // Still try to load accounts (might have session but silent login failed)
      try {
        await loadAccounts();
      } catch {
        // No session at all
        setIsAuthenticated(false);
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function loadState() {
    await loadAccounts();
    loadClaims();
  }

  async function loadAccounts() {
    const result = await client.getAccounts();
    setAccounts(result.accounts);
    setActiveAccount(result.activeAccount);
    setIsAuthenticated(result.accounts.length > 0);
  }

  function loadClaims() {
    setClaims(client.getTokenClaims());
  }

  const refreshAccounts = useCallback(async () => {
    await loadAccounts();
    loadClaims();
  }, []);

  const login = useCallback(async (options?: { prompt?: string }) => {
    await client.login(options);
  }, [client]);

  const logout = useCallback(async () => {
    if (!activeAccount) return;

    try {
      const result = await client.signOutAccount(activeAccount.userId);

      if (result.remainingAccounts === 0) {
        setIsAuthenticated(false);
        setAccounts([]);
        setActiveAccount(null);
        setClaims(null);
      } else {
        await loadState();
        if (result.wasActive) {
          // Active account changed, reload to get new tokens
          window.location.reload();
        }
      }
    } catch (error: any) {
      onError?.(error);
      throw error;
    }
  }, [activeAccount, client, onError]);

  const logoutAll = useCallback(async () => {
    try {
      await client.signOutAll();
      setIsAuthenticated(false);
      setAccounts([]);
      setActiveAccount(null);
      setClaims(null);
    } catch (error: any) {
      onError?.(error);
      throw error;
    }
  }, [client, onError]);

  const switchAccount = useCallback(async (userId: string) => {
    try {
      await client.switchAccount(userId);
      await loadState();
      // Reload to get new tokens for switched account
      window.location.reload();
    } catch (error: any) {
      onError?.(error);
      throw error;
    }
  }, [client, onError]);

  const addAccount = useCallback(async () => {
    await client.addAccount();
  }, [client]);

  const getAccessToken = useCallback(async () => {
    return client.getAccessToken();
  }, [client]);

  const getAuthHeader = useCallback(async () => {
    return client.getAuthHeader();
  }, [client]);

  const user = claims ? {
    id: claims.sub,
    email: claims.email,
    roles: claims.roles || [],
  } : null;

  return (
    <AuthContext.Provider value={{
      isAuthenticated,
      isLoading,
      accounts,
      activeAccount,
      user,
      claims,
      login,
      logout,
      logoutAll,
      switchAccount,
      addAccount,
      refreshAccounts,
      getAccessToken,
      getAuthHeader,
      client,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
```

### Hooks

```typescript
// File: packages/auth-client/src/react/hooks.ts

import { useAuth } from './provider';
import { useCallback, useState } from 'react';

/**
 * Hook for account switching operations
 */
export function useAccounts() {
  const { accounts, activeAccount, switchAccount, addAccount, logout, logoutAll } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const canAddAccount = accounts.length < 3;

  const handleSwitch = useCallback(async (userId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      await switchAccount(userId);
    } catch (e: any) {
      setError(e);
    } finally {
      setIsLoading(false);
    }
  }, [switchAccount]);

  const handleAdd = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      await addAccount();
    } catch (e: any) {
      setError(e);
    } finally {
      setIsLoading(false);
    }
  }, [addAccount]);

  const handleSignOut = useCallback(async (userId?: string) => {
    setIsLoading(true);
    setError(null);
    try {
      if (userId && userId !== activeAccount?.userId) {
        // Sign out non-active account - need direct API call
        // (logout() only works for active account)
        const { client } = useAuth();
        await client.signOutAccount(userId);
      } else {
        await logout();
      }
    } catch (e: any) {
      setError(e);
    } finally {
      setIsLoading(false);
    }
  }, [activeAccount, logout]);

  return {
    accounts,
    activeAccount,
    canAddAccount,
    isLoading,
    error,
    switchAccount: handleSwitch,
    addAccount: handleAdd,
    signOut: handleSignOut,
    signOutAll: logoutAll,
  };
}

/**
 * Hook for authenticated API calls
 */
export function useAuthenticatedFetch() {
  const { getAuthHeader, isAuthenticated } = useAuth();

  const authFetch = useCallback(async (
    url: string,
    options: RequestInit = {}
  ): Promise<Response> => {
    const authHeader = await getAuthHeader();

    if (!authHeader) {
      throw new Error('Not authenticated');
    }

    return fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': authHeader,
      },
    });
  }, [getAuthHeader]);

  return {
    authFetch,
    isAuthenticated,
  };
}

/**
 * Hook for session/device management
 */
export function useDevices() {
  const { client } = useAuth();
  const [devices, setDevices] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const loadDevices = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await client.getDevices();
      setDevices(result.sessions);
    } catch (e: any) {
      setError(e);
    } finally {
      setIsLoading(false);
    }
  }, [client]);

  const revokeDevice = useCallback(async (sessionId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      await client.revokeDevice(sessionId);
      await loadDevices();
    } catch (e: any) {
      setError(e);
    } finally {
      setIsLoading(false);
    }
  }, [client, loadDevices]);

  return {
    devices,
    isLoading,
    error,
    loadDevices,
    revokeDevice,
  };
}
```

---

## Types

```typescript
// File: packages/auth-client/src/types.ts

export interface AuthClientConfig {
  authServerUrl: string;  // OpenAuth issuer URL
  clientId: string;
  redirectUri: string;
  scope?: string;
  tokenStorage?: 'memory' | 'localStorage' | 'sessionStorage';
  challengeStorage?: 'sessionStorage' | 'memory'; // For PKCE challenge (default: sessionStorage)
}

export interface LoginOptions {
  prompt?: 'none' | 'login' | 'select_account' | 'consent';
  loginHint?: string;
  accountHint?: string;
  maxAge?: number;
  nonce?: string;
  state?: string;
  scope?: string;
}

export interface AuthResult {
  success: boolean;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn: number;
  tokenType: string;
  scope: string;
}

export interface Account {
  userId: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  isActive: boolean;
  authenticatedAt: string;
  lastUsed: string;
}

export interface AccountsResponse {
  accounts: Account[];
  activeAccount: Account | null;
}

export interface SignOutResult {
  success: boolean;
  wasActive: boolean;
  newActiveUserId: string | null;
  remainingAccounts: number;
}

export interface SessionCheck {
  authenticated: boolean;
  session: {
    userId: string;
    email: string;
    authenticatedAt: string;
    expiresAt: string;
    deviceType: string;
    deviceName: string;
  } | null;
}

export interface DeviceSession {
  id: string;
  deviceType: string;
  deviceName: string;
  ipAddress: string;
  lastActivity: string;
  createdAt: string;
  isCurrentSession: boolean;
}

export interface DevicesResponse {
  sessions: DeviceSession[];
  total: number;
}

export interface TokenExchangeOptions {
  subjectToken: string;
  targetAudience: string;
  scope?: string;
}

export interface TokenClaims {
  // Standard JWT claims
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  nbf?: number;
  jti?: string;

  // OIDC claims
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;

  // Custom claims
  roles?: string[];
  permissions?: string[];
  session_id?: string;
  tenant_id?: string;
}
```

---

## Errors

```typescript
// File: packages/auth-client/src/errors.ts

export enum AuthErrorCode {
  // OAuth errors
  LOGIN_REQUIRED = 'login_required',
  CONSENT_REQUIRED = 'consent_required',
  ACCOUNT_SELECTION_REQUIRED = 'account_selection_required',
  INTERACTION_REQUIRED = 'interaction_required',
  INVALID_REQUEST = 'invalid_request',
  UNAUTHORIZED_CLIENT = 'unauthorized_client',
  ACCESS_DENIED = 'access_denied',
  INVALID_SCOPE = 'invalid_scope',
  SERVER_ERROR = 'server_error',

  // Session errors
  SESSION_EXPIRED = 'session_expired',
  SESSION_REVOKED = 'session_revoked',
  MAX_ACCOUNTS_REACHED = 'max_accounts_reached',
  SESSION_ERROR = 'session_error',

  // Token errors
  TOKEN_EXPIRED = 'token_expired',
  TOKEN_REVOKED = 'token_revoked',
  INVALID_TOKEN = 'invalid_token',
  REFRESH_FAILED = 'refresh_failed',
  NO_REFRESH_TOKEN = 'no_refresh_token',
  TOKEN_EXCHANGE_FAILED = 'token_exchange_failed',

  // Client errors
  STATE_MISMATCH = 'state_mismatch',
  PKCE_ERROR = 'pkce_error',
  INVALID_RESPONSE = 'invalid_response',
  TIMEOUT = 'timeout',

  // Operation errors
  SWITCH_FAILED = 'switch_failed',
  SIGNOUT_FAILED = 'signout_failed',
  REVOKE_FAILED = 'revoke_failed',
}

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode | string,
    message: string
  ) {
    super(message);
    this.name = 'AuthError';
  }

  static isAuthError(error: unknown): error is AuthError {
    return error instanceof AuthError;
  }
}
```

---

## Package.json

```json
{
  "name": "@alummahnow/auth-client",
  "version": "2.0.0",
  "description": "Auth client SDK for AlUmmahNow Identity Platform (built on OpenAuth)",
  "main": "dist/index.js",
  "module": "dist/index.mjs",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./react": {
      "import": "./dist/react/index.mjs",
      "require": "./dist/react/index.js",
      "types": "./dist/react/index.d.ts"
    }
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsup src/index.ts src/react/index.ts --format cjs,esm --dts",
    "test": "vitest",
    "test:coverage": "vitest --coverage",
    "lint": "eslint src --ext .ts,.tsx",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@meywd/openauth": "^1.0.1",
    "jose": "^5.2.0"
  },
  "peerDependencies": {
    "react": ">=17.0.0"
  },
  "peerDependenciesMeta": {
    "react": {
      "optional": true
    }
  },
  "devDependencies": {
    "@types/react": "^18.2.0",
    "react": "^18.2.0",
    "tsup": "^8.0.0",
    "typescript": "^5.3.0",
    "vitest": "^1.2.0"
  },
  "keywords": [
    "auth",
    "oauth",
    "oidc",
    "openauth",
    "sso",
    "authentication",
    "alummahnow"
  ],
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/alummahnow/auth-client"
  }
}
```

---

## Testing Requirements

### Unit Tests

```typescript
// File: packages/auth-client/tests/client.test.ts

describe('AuthClient', () => {
  describe('constructor', () => {
    it('should initialize with config', () => {});
    it('should use default scope if not provided', () => {});
  });

  describe('login', () => {
    it('should redirect to authorization endpoint', () => {});
    it('should include PKCE parameters', () => {});
    it('should include state parameter', () => {});
    it('should pass optional OIDC parameters', () => {});
  });

  describe('silentLogin', () => {
    it('should use hidden iframe', () => {});
    it('should timeout after 10 seconds', () => {});
    it('should throw login_required if no session', () => {});
    it('should return tokens on success', () => {});
  });

  describe('handleCallback', () => {
    it('should validate state parameter', () => {});
    it('should exchange code for tokens', () => {});
    it('should store tokens after success', () => {});
    it('should handle error responses', () => {});
  });

  describe('switchAccount', () => {
    it('should call session API', () => {});
    it('should clear tokens after switch', () => {});
  });

  describe('signOutAccount', () => {
    it('should call session API', () => {});
    it('should clear tokens if active account', () => {});
    it('should not clear tokens if other account', () => {});
  });
});

describe('SessionManager', () => {
  describe('getAccounts', () => {
    it('should return accounts from API', () => {});
    it('should return empty array on 401', () => {});
  });

  describe('switchAccount', () => {
    it('should POST to switch endpoint', () => {});
    it('should throw on error', () => {});
  });

  describe('signOutAccount', () => {
    it('should DELETE to account endpoint', () => {});
    it('should return SignOutResult', () => {});
  });
});

describe('TokenManager', () => {
  describe('store', () => {
    it('should store tokens in memory by default', () => {});
    it('should calculate expiresAt', () => {});
  });

  describe('getAccessToken', () => {
    it('should return token if valid', () => {});
    it('should refresh if expired', () => {});
    it('should return null if no token', () => {});
  });

  describe('refresh', () => {
    it('should call token endpoint', () => {});
    it('should store new tokens', () => {});
    it('should throw if no refresh token', () => {});
  });
});
```

### Coverage Requirements

| Component | Target |
|-----------|--------|
| AuthClient | >90% |
| OAuthManager | >85% |
| SessionManager | >90% |
| TokenManager | >90% |
| React Provider | >80% |
| React Hooks | >80% |

---

## Rollout Checklist

- [ ] Create package structure
- [ ] Implement OAuthManager wrapping `@meywd/openauth/client`
- [ ] Implement Challenge Storage for PKCE
- [ ] Implement SessionManager
- [ ] Implement TokenManager with storage strategies
- [ ] Implement AuthClient (main entry point)
- [ ] Implement React provider and hooks
- [ ] Write unit tests (>85% coverage)
- [ ] Write integration tests against OpenAuth server
- [ ] Create README with examples
- [ ] Publish to npm as `@alummahnow/auth-client@2.0.0`
- [ ] Update CLIENT-INTEGRATION-GUIDE.md with SDK usage
- [ ] Update CLIENT-MIGRATION-GUIDE.md to reference SDK

---

## Estimated Effort

| Component | Hours | Notes |
|-----------|-------|-------|
| OAuthManager (OpenAuth wrapper) | 3-4 | Simpler - OpenAuth handles PKCE/state |
| Challenge Storage | 1 | PKCE state management |
| SessionManager | 2-3 | Multi-account session API calls |
| TokenManager | 2-3 | Storage strategies, refresh |
| AuthClient | 2-3 | Main entry point composition |
| React integration | 4-6 | Provider, hooks, types |
| Tests | 5-7 | Unit + integration with OpenAuth |
| Documentation | 2-3 | README, examples |
| **Total** | **21-30 hours** | Reduced from oauth4webapi approach |

**Why faster with OpenAuth?**
- OpenAuth's `authorize()` generates PKCE challenge automatically
- OpenAuth's `exchange()` handles code verification
- OpenAuth's `verify()` validates tokens with built-in refresh
- Less boilerplate = fewer bugs = faster testing
