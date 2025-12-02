# Lane 3: Session Management APIs

## Overview
Implement comprehensive session management APIs for users to list, switch, and manage their logged-in accounts and active sessions across devices.

## Priority: P1 (High)
**Dependencies**: Lane 1 (Browser Sessions), Lane 2 (OIDC Parameters)
**Blocks**: Lane 6 (Admin Session Controls)

---

## Current State Analysis

### What Exists:
- Basic logout functionality
- Token revocation endpoint
- Single session per user in KV

### What's Missing:
- List logged-in accounts API
- Switch active account API
- Sign out single account API
- Sign out all accounts API
- Session check endpoint
- List all user sessions (across devices) API
- Remote session revocation

---

## API Specifications

### Session APIs (User-facing)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/session/accounts` | GET | List all logged-in accounts in current browser |
| `/session/switch` | POST | Switch active account |
| `/session/accounts/:userId` | DELETE | Sign out one account from browser |
| `/session/all` | DELETE | Sign out all accounts from browser |
| `/session/check` | GET | Silent session check (returns JSON) |
| `/session/devices` | GET | List all sessions for current user (all devices) |
| `/session/devices/:sessionId` | DELETE | Revoke specific session (remote logout) |

---

## Route Implementations

### File: apps/auth/src/routes/session.ts

```typescript
import { Hono } from 'hono';
import { BrowserSessionService } from '../services/browser-session.service';
import { AccountSessionService } from '../services/account-session.service';
import { TokenService } from '../services/token.service';
import { requireSession } from '../middleware/session';
import { clearSessionCookie, createSessionCookie } from '../utils/session-cookie';
import { emitAuditEvent } from '../services/audit';
import { getActiveSigningKey } from '../utils/keys';
import type { Env } from '../types/env';

const sessionRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /session/accounts
 * List all logged-in accounts in current browser session
 */
sessionRoutes.get('/accounts', requireSession, async (c) => {
  const browserSession = c.get('browserSession');
  const browserSessionService = new BrowserSessionService(c.env.AUTH_DB);

  const sessionWithAccounts = await browserSessionService.getBrowserSessionWithAccounts(browserSession.id);

  if (!sessionWithAccounts) {
    return c.json({ accounts: [], activeAccount: null });
  }

  return c.json({
    accounts: sessionWithAccounts.accounts.map(account => ({
      userId: account.userId,
      email: account.user.email,
      name: account.user.name,
      avatarUrl: account.user.avatarUrl,
      isActive: account.isActive,
      authenticatedAt: account.authenticatedAt,
      lastUsed: account.lastUsed,
    })),
    activeAccount: sessionWithAccounts.activeAccount ? {
      userId: sessionWithAccounts.activeAccount.userId,
      email: sessionWithAccounts.activeAccount.user.email,
    } : null,
  });
});

/**
 * POST /session/switch
 * Switch active account in current browser session
 * Body: { userId: string }
 */
sessionRoutes.post('/switch', requireSession, async (c) => {
  const browserSession = c.get('browserSession');
  const { userId } = await c.req.json<{ userId: string }>();

  if (!userId) {
    return c.json({ error: 'userId is required' }, 400);
  }

  const accountSessionService = new AccountSessionService(c.env.AUTH_DB);
  const newActiveAccount = await accountSessionService.setActiveAccountByUserId(browserSession.id, userId);

  if (!newActiveAccount) {
    return c.json({ error: 'Account not found in session' }, 404);
  }

  // Emit audit event
  await emitAuditEvent(c.env, {
    type: 'session.switch_account',
    userId: newActiveAccount.userId,
    severity: 'info',
    metadata: {
      browserSessionId: browserSession.id,
      previousUserId: c.get('activeAccount')?.userId,
    },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({
    success: true,
    activeAccount: {
      userId: newActiveAccount.userId,
    },
  });
});

/**
 * DELETE /session/accounts/:userId
 * Sign out one account from current browser session
 * IMPORTANT: This performs a HARD sign out - revokes session AND all tokens
 */
sessionRoutes.delete('/accounts/:userId', requireSession, async (c) => {
  const browserSession = c.get('browserSession');
  const activeAccount = c.get('activeAccount');
  const userId = c.req.param('userId');

  const accountSessionService = new AccountSessionService(c.env.AUTH_DB);

  // Get the account session ID before removing (needed for token revocation)
  const accountSession = await accountSessionService.getAccountSessionByUserId(browserSession.id, userId);

  if (!accountSession) {
    return c.json({ error: 'Account not found in session' }, 404);
  }

  // Remove account from session (marks as revoked)
  const result = await accountSessionService.removeAccountFromSession(browserSession.id, userId);

  // CRITICAL: Revoke all tokens for this account session
  const tokenService = new TokenService(c.env.AUTH_DB, c.env.ISSUER, () => getActiveSigningKey(c.env));
  const revokedTokens = await tokenService.revokeSessionTokens(accountSession.id);

  // Emit audit event
  await emitAuditEvent(c.env, {
    type: 'session.signout_account',
    userId: userId,
    severity: 'info',
    metadata: {
      browserSessionId: browserSession.id,
      accountSessionId: accountSession.id,
      wasActive: result.wasActive,
      newActiveUserId: result.newActiveId,
      tokensRevoked: revokedTokens.revoked,
    },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  // Check if any accounts remain
  const browserSessionService = new BrowserSessionService(c.env.AUTH_DB);
  const sessionWithAccounts = await browserSessionService.getBrowserSessionWithAccounts(browserSession.id);

  const remainingAccounts = sessionWithAccounts?.accounts.length || 0;

  // If no accounts remain, clear the session cookie
  if (remainingAccounts === 0) {
    c.header('Set-Cookie', clearSessionCookie());
  }

  return c.json({
    success: true,
    wasActive: result.wasActive,
    newActiveUserId: result.newActiveId,
    remainingAccounts,
    tokensRevoked: revokedTokens.revoked,
  });
});

/**
 * DELETE /session/all
 * Sign out all accounts and destroy browser session
 * IMPORTANT: This performs a HARD sign out - revokes all sessions AND all tokens
 */
sessionRoutes.delete('/all', requireSession, async (c) => {
  const browserSession = c.get('browserSession');
  const activeAccount = c.get('activeAccount');

  // Get all account sessions in this browser before revoking
  const accountSessionService = new AccountSessionService(c.env.AUTH_DB);
  const accountSessions = await accountSessionService.getAccountsForBrowserSession(browserSession.id);

  // CRITICAL: Revoke all tokens for all account sessions in this browser
  const tokenService = new TokenService(c.env.AUTH_DB, c.env.ISSUER, () => getActiveSigningKey(c.env));
  let totalTokensRevoked = 0;

  for (const accountSession of accountSessions) {
    const result = await tokenService.revokeSessionTokens(accountSession.id);
    totalTokensRevoked += result.revoked;
  }

  // Revoke browser session (cascades to account sessions)
  const browserSessionService = new BrowserSessionService(c.env.AUTH_DB);
  await browserSessionService.revokeBrowserSession(browserSession.id);

  // Emit audit event
  await emitAuditEvent(c.env, {
    type: 'session.signout_all',
    userId: activeAccount?.userId || 'unknown',
    severity: 'info',
    metadata: {
      browserSessionId: browserSession.id,
      accountsSignedOut: accountSessions.length,
      tokensRevoked: totalTokensRevoked,
    },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  // Clear session cookie
  c.header('Set-Cookie', clearSessionCookie());

  return c.json({
    success: true,
    accountsSignedOut: accountSessions.length,
    tokensRevoked: totalTokensRevoked,
  });
});

/**
 * GET /session/check
 * Silent session check - returns current session status
 * Used for checking if user is logged in without redirecting
 */
sessionRoutes.get('/check', async (c) => {
  const browserSession = c.get('browserSession');
  const activeAccount = c.get('activeAccount');

  if (!browserSession || !activeAccount) {
    return c.json({
      authenticated: false,
      session: null,
    });
  }

  // Get user details
  const user = await c.env.AUTH_DB.prepare(`
    SELECT id, email FROM user WHERE id = ?
  `).bind(activeAccount.userId).first();

  return c.json({
    authenticated: true,
    session: {
      userId: activeAccount.userId,
      email: user?.email,
      authenticatedAt: activeAccount.authenticatedAt,
      expiresAt: activeAccount.expiresAt,
      deviceType: browserSession.deviceType,
      deviceName: browserSession.deviceName,
    },
  });
});

/**
 * GET /session/devices
 * List all active sessions for current user across all devices
 * Requires authentication
 */
sessionRoutes.get('/devices', requireSession, async (c) => {
  const activeAccount = c.get('activeAccount');
  const browserSession = c.get('browserSession');

  const accountSessionService = new AccountSessionService(c.env.AUTH_DB);
  const sessions = await accountSessionService.getUserSessions(activeAccount.userId);

  return c.json({
    sessions: sessions.map(session => ({
      id: session.id,
      deviceType: session.browserSession.deviceType,
      deviceName: session.browserSession.deviceName,
      ipAddress: session.browserSession.ipAddress,
      lastActivity: session.browserSession.lastActivity,
      createdAt: session.browserSession.createdAt,
      isCurrentSession: session.browserSessionId === browserSession.id,
    })),
    total: sessions.length,
  });
});

/**
 * DELETE /session/devices/:sessionId
 * Revoke a specific session (remote logout)
 * IMPORTANT: This performs a HARD sign out - revokes session AND all tokens
 */
sessionRoutes.delete('/devices/:sessionId', requireSession, async (c) => {
  const activeAccount = c.get('activeAccount');
  const browserSession = c.get('browserSession');
  const sessionId = c.req.param('sessionId');

  // Verify session belongs to current user
  const accountSessionService = new AccountSessionService(c.env.AUTH_DB);
  const targetSession = await accountSessionService.getAccountSessionById(sessionId);

  if (!targetSession || targetSession.userId !== activeAccount.userId) {
    return c.json({ error: 'Session not found' }, 404);
  }

  // Prevent revoking current session via this endpoint
  if (targetSession.browserSessionId === browserSession.id) {
    return c.json({ error: 'Cannot revoke current session. Use /session/all instead.' }, 400);
  }

  // CRITICAL: Revoke all tokens for this session FIRST
  const tokenService = new TokenService(c.env.AUTH_DB, c.env.ISSUER, () => getActiveSigningKey(c.env));
  const revokedTokens = await tokenService.revokeSessionTokens(sessionId);

  // Then revoke the session
  await c.env.AUTH_DB.prepare(`
    UPDATE account_sessions SET is_revoked = 1 WHERE id = ?
  `).bind(sessionId).run();

  // Emit audit event
  await emitAuditEvent(c.env, {
    type: 'session.remote_revoke',
    userId: activeAccount.userId,
    severity: 'warning',
    metadata: {
      revokedSessionId: sessionId,
      revokedBrowserSessionId: targetSession.browserSessionId,
      tokensRevoked: revokedTokens.revoked,
    },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({
    success: true,
    tokensRevoked: revokedTokens.revoked,
  });
});

export default sessionRoutes;
```

---

## Middleware

### File: apps/auth/src/middleware/session.ts

```typescript
import { createMiddleware } from 'hono/factory';
import type { Env } from '../types/env';

/**
 * Middleware that requires a valid browser session with active account
 */
export const requireSession = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const browserSession = c.get('browserSession');
  const activeAccount = c.get('activeAccount');

  if (!browserSession) {
    return c.json({ error: 'No session found' }, 401);
  }

  if (!activeAccount) {
    return c.json({ error: 'No active account in session' }, 401);
  }

  await next();
});

/**
 * Middleware that requires browser session but not necessarily active account
 */
export const requireBrowserSession = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const browserSession = c.get('browserSession');

  if (!browserSession) {
    return c.json({ error: 'No session found' }, 401);
  }

  await next();
});

/**
 * Optional session middleware - doesn't fail if no session
 */
export const optionalSession = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  // Session is already loaded in the main middleware
  // This just marks the route as session-aware
  await next();
});
```

---

## Response Types

### File: apps/auth/src/types/api-responses.ts

```typescript
export interface AccountInfo {
  userId: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  isActive: boolean;
  authenticatedAt: string;
  lastUsed: string;
}

export interface SessionAccountsResponse {
  accounts: AccountInfo[];
  activeAccount: {
    userId: string;
    email: string;
  } | null;
}

export interface SwitchAccountResponse {
  success: boolean;
  activeAccount: {
    userId: string;
  };
}

export interface RemoveAccountResponse {
  success: boolean;
  wasActive: boolean;
  newActiveUserId: string | null;
  remainingAccounts: number;
}

export interface SessionCheckResponse {
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

export interface DeviceSessionsResponse {
  sessions: DeviceSession[];
  total: number;
}
```

---

## Client SDK

### File: packages/auth-client/src/session.ts

```typescript
export interface AuthSession {
  accounts: AccountInfo[];
  activeAccount: AccountInfo | null;
}

export class SessionManager {
  constructor(private baseUrl: string) {}

  /**
   * Get all logged-in accounts in current browser
   */
  async getAccounts(): Promise<SessionAccountsResponse> {
    const response = await fetch(`${this.baseUrl}/session/accounts`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to get accounts');
    }

    return response.json();
  }

  /**
   * Switch active account
   */
  async switchAccount(userId: string): Promise<SwitchAccountResponse> {
    const response = await fetch(`${this.baseUrl}/session/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId }),
    });

    if (!response.ok) {
      throw new Error('Failed to switch account');
    }

    return response.json();
  }

  /**
   * Sign out one account
   */
  async signOutAccount(userId: string): Promise<RemoveAccountResponse> {
    const response = await fetch(`${this.baseUrl}/session/accounts/${userId}`, {
      method: 'DELETE',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to sign out account');
    }

    return response.json();
  }

  /**
   * Sign out all accounts
   */
  async signOutAll(): Promise<{ success: boolean }> {
    const response = await fetch(`${this.baseUrl}/session/all`, {
      method: 'DELETE',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to sign out');
    }

    return response.json();
  }

  /**
   * Check current session status
   */
  async checkSession(): Promise<SessionCheckResponse> {
    const response = await fetch(`${this.baseUrl}/session/check`, {
      credentials: 'include',
    });

    return response.json();
  }

  /**
   * Get all sessions for current user across devices
   */
  async getDevices(): Promise<DeviceSessionsResponse> {
    const response = await fetch(`${this.baseUrl}/session/devices`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to get devices');
    }

    return response.json();
  }

  /**
   * Revoke a session on another device
   */
  async revokeDevice(sessionId: string): Promise<{ success: boolean }> {
    const response = await fetch(`${this.baseUrl}/session/devices/${sessionId}`, {
      method: 'DELETE',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to revoke session');
    }

    return response.json();
  }
}
```

---

## Integration with Profile App

### File: apps/profile/src/components/AccountSwitcher.tsx

```tsx
import { useState, useEffect } from 'react';
import { SessionManager, type AccountInfo } from '@alummahnow/auth-client';

interface AccountSwitcherProps {
  authUrl: string;
  onAccountChange?: (account: AccountInfo) => void;
}

export function AccountSwitcher({ authUrl, onAccountChange }: AccountSwitcherProps) {
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [activeAccount, setActiveAccount] = useState<AccountInfo | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const sessionManager = new SessionManager(authUrl);

  useEffect(() => {
    loadAccounts();
  }, []);

  async function loadAccounts() {
    try {
      const data = await sessionManager.getAccounts();
      setAccounts(data.accounts);
      setActiveAccount(data.accounts.find(a => a.isActive) || null);
    } catch (error) {
      console.error('Failed to load accounts', error);
    } finally {
      setLoading(false);
    }
  }

  async function handleSwitchAccount(userId: string) {
    try {
      await sessionManager.switchAccount(userId);
      const newActive = accounts.find(a => a.userId === userId);
      if (newActive) {
        setActiveAccount(newActive);
        onAccountChange?.(newActive);
      }
      setIsOpen(false);
      // Reload to get fresh tokens
      window.location.reload();
    } catch (error) {
      console.error('Failed to switch account', error);
    }
  }

  async function handleSignOut(userId: string) {
    try {
      const result = await sessionManager.signOutAccount(userId);
      if (result.remainingAccounts === 0) {
        // All accounts signed out - redirect to home
        window.location.href = '/';
      } else {
        await loadAccounts();
      }
    } catch (error) {
      console.error('Failed to sign out', error);
    }
  }

  async function handleAddAccount() {
    // Redirect to auth with add_account action
    const redirectUri = window.location.href;
    window.location.href = `${authUrl}/authorize?client_id=${CLIENT_ID}&action=add_account&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }

  if (loading) {
    return <div className="account-switcher-loading">...</div>;
  }

  return (
    <div className="account-switcher">
      <button onClick={() => setIsOpen(!isOpen)} className="account-switcher-trigger">
        <span className="avatar">{activeAccount?.email.charAt(0).toUpperCase()}</span>
        <span className="email">{activeAccount?.email}</span>
      </button>

      {isOpen && (
        <div className="account-switcher-dropdown">
          {accounts.map(account => (
            <div key={account.userId} className="account-item">
              <button
                onClick={() => handleSwitchAccount(account.userId)}
                disabled={account.isActive}
                className="account-select"
              >
                <span className="avatar">{account.email.charAt(0).toUpperCase()}</span>
                <span className="email">{account.email}</span>
                {account.isActive && <span className="active-badge">Active</span>}
              </button>
              <button
                onClick={() => handleSignOut(account.userId)}
                className="sign-out-btn"
              >
                Sign out
              </button>
            </div>
          ))}

          {accounts.length < 3 && (
            <button onClick={handleAddAccount} className="add-account-btn">
              + Add another account
            </button>
          )}

          <button
            onClick={() => sessionManager.signOutAll().then(() => window.location.href = '/')}
            className="sign-out-all-btn"
          >
            Sign out of all accounts
          </button>
        </div>
      )}
    </div>
  );
}
```

---

## Testing Requirements

### Unit Tests

#### File: apps/auth/src/routes/__tests__/session.routes.test.ts

```typescript
describe('Session Routes', () => {
  describe('GET /session/accounts', () => {
    it('should return all accounts in browser session with user details', async () => {
      // Setup: Browser session with 2 accounts
      // Acceptance: Response contains both accounts with userId, email, name, avatarUrl
    });

    it('should return empty array when no accounts in session', async () => {
      // Setup: Browser session exists but no account_sessions
      // Acceptance: { accounts: [], activeAccount: null }
    });

    it('should return 401 without valid session cookie', async () => {
      // Acceptance: { error: 'No session found' }, status 401
    });

    it('should identify active account correctly', async () => {
      // Setup: 3 accounts, account 2 is active
      // Acceptance: activeAccount.userId matches account 2
    });

    it('should include authenticatedAt and lastUsed for each account', async () => {
      // Acceptance: All accounts have valid ISO timestamps
    });

    it('should not include revoked accounts', async () => {
      // Setup: 3 accounts, 1 revoked
      // Acceptance: Returns 2 accounts
    });
  });

  describe('POST /session/switch', () => {
    it('should switch active account and return new active', async () => {
      // Setup: 2 accounts, account 1 active
      // Test: Switch to account 2
      // Acceptance: activeAccount.userId = account2.userId
    });

    it('should return 404 for userId not in session', async () => {
      // Acceptance: { error: 'Account not found in session' }, status 404
    });

    it('should return 400 without userId in body', async () => {
      // Acceptance: { error: 'userId is required' }, status 400
    });

    it('should emit audit event on switch', async () => {
      // Acceptance: Audit event type = 'session.switch_account'
    });

    it('should update lastUsed timestamp on switched account', async () => {
      // Acceptance: lastUsed is updated to current time
    });

    it('should allow switching to already-active account (no-op)', async () => {
      // Acceptance: Success response, account remains active
    });
  });

  describe('DELETE /session/accounts/:userId', () => {
    it('should remove account from session and revoke tokens', async () => {
      // CRITICAL TEST
      // Setup: Account has 3 access tokens, 1 refresh token
      // Test: DELETE /session/accounts/:userId
      // Acceptance:
      //   - Account session marked revoked
      //   - All 4 tokens revoked (check DB)
      //   - Response includes tokensRevoked: 4
    });

    it('should switch active to next account when removing active', async () => {
      // Setup: 3 accounts, account 1 active
      // Test: Remove account 1
      // Acceptance: wasActive: true, newActiveUserId: account2 or account3
    });

    it('should not change active when removing inactive account', async () => {
      // Setup: 3 accounts, account 1 active
      // Test: Remove account 2
      // Acceptance: wasActive: false, newActiveUserId: null
    });

    it('should clear session cookie when last account removed', async () => {
      // Setup: Only 1 account in session
      // Test: Remove that account
      // Acceptance: Set-Cookie header clears __session
    });

    it('should return 404 if userId not in session', async () => {
      // Acceptance: { error: 'Account not found in session' }, status 404
    });

    it('should emit audit event with token revocation count', async () => {
      // Acceptance: Audit event includes tokensRevoked in metadata
    });

    it('should not affect other users tokens in same browser', async () => {
      // Setup: Browser with User A and User B, both have tokens
      // Test: Sign out User A
      // Acceptance: User B's tokens unchanged
    });
  });

  describe('DELETE /session/all', () => {
    it('should revoke browser session and all account sessions', async () => {
      // Setup: Browser with 3 accounts
      // Acceptance: browser_session.is_revoked = true
      //            all account_sessions.is_revoked = true
    });

    it('should revoke all tokens for all accounts', async () => {
      // CRITICAL TEST
      // Setup: 3 accounts, each with 2 tokens (6 total)
      // Test: DELETE /session/all
      // Acceptance:
      //   - All 6 tokens revoked
      //   - Response: tokensRevoked: 6, accountsSignedOut: 3
    });

    it('should clear session cookie', async () => {
      // Acceptance: Set-Cookie header with Max-Age=0
    });

    it('should emit audit event', async () => {
      // Acceptance: Audit type = 'session.signout_all'
    });

    it('should work even with no active account', async () => {
      // Setup: Browser session with accounts but none active
      // Acceptance: Still revokes all, returns success
    });
  });

  describe('GET /session/check', () => {
    it('should return session info when authenticated', async () => {
      // Acceptance: {
      //   authenticated: true,
      //   session: { userId, email, authenticatedAt, expiresAt, deviceType, deviceName }
      // }
    });

    it('should return authenticated:false when no session cookie', async () => {
      // Acceptance: { authenticated: false, session: null }
    });

    it('should return authenticated:false when session expired', async () => {
      // Setup: Expired session cookie
      // Acceptance: { authenticated: false, session: null }
    });

    it('should return authenticated:false when no active account', async () => {
      // Setup: Valid browser session but no active account
      // Acceptance: { authenticated: false, session: null }
    });

    it('should not require CORS preflight (GET)', async () => {
      // Acceptance: Simple GET request works cross-origin
    });
  });

  describe('GET /session/devices', () => {
    it('should return all user sessions across devices', async () => {
      // Setup: User logged into 3 different browsers
      // Acceptance: sessions array length = 3
    });

    it('should mark current session with isCurrentSession: true', async () => {
      // Acceptance: Exactly one session has isCurrentSession: true
    });

    it('should include device details for each session', async () => {
      // Acceptance: Each session has deviceType, deviceName, ipAddress, lastActivity
    });

    it('should order by lastActivity descending', async () => {
      // Acceptance: Most recent session first
    });

    it('should not include revoked sessions', async () => {
      // Setup: 3 sessions, 1 revoked
      // Acceptance: Returns 2 sessions
    });

    it('should return total count', async () => {
      // Acceptance: { sessions: [...], total: N }
    });
  });

  describe('DELETE /session/devices/:sessionId', () => {
    it('should revoke remote session and its tokens', async () => {
      // CRITICAL TEST
      // Setup: User has 2 sessions, remote session has 2 tokens
      // Test: Revoke remote session
      // Acceptance:
      //   - Remote session marked revoked
      //   - 2 tokens revoked
      //   - Response: tokensRevoked: 2
    });

    it('should prevent revoking current session', async () => {
      // Acceptance: { error: 'Cannot revoke current session. Use /session/all instead.' }, status 400
    });

    it('should return 404 for session of another user', async () => {
      // Setup: Try to revoke another user's session
      // Acceptance: { error: 'Session not found' }, status 404
    });

    it('should return 404 for non-existent session', async () => {
      // Acceptance: { error: 'Session not found' }, status 404
    });

    it('should emit audit event with warning severity', async () => {
      // Acceptance: Audit type = 'session.remote_revoke', severity = 'warning'
    });

    it('should include revokedSessionId in audit metadata', async () => {
      // Acceptance: metadata.revokedSessionId = target session ID
    });
  });
});
```

### Middleware Tests

```typescript
describe('Session Middleware', () => {
  describe('requireSession', () => {
    it('should allow request with valid session and active account', async () => {
      // Acceptance: next() called, no error response
    });

    it('should return 401 when no browser session', async () => {
      // Acceptance: { error: 'No session found' }, status 401
    });

    it('should return 401 when browser session but no active account', async () => {
      // Acceptance: { error: 'No active account in session' }, status 401
    });
  });

  describe('requireBrowserSession', () => {
    it('should allow request with browser session (no account needed)', async () => {
      // Acceptance: next() called even without active account
    });

    it('should return 401 when no browser session', async () => {
      // Acceptance: { error: 'No session found' }, status 401
    });
  });

  describe('optionalSession', () => {
    it('should always call next()', async () => {
      // Acceptance: Request proceeds regardless of session state
    });
  });
});
```

### Client SDK Tests

```typescript
describe('SessionManager', () => {
  describe('getAccounts', () => {
    it('should fetch accounts with credentials', async () => {
      // Acceptance: fetch called with credentials: 'include'
    });

    it('should throw on non-ok response', async () => {
      // Acceptance: Throws 'Failed to get accounts'
    });

    it('should return parsed JSON response', async () => {
      // Acceptance: Returns SessionAccountsResponse
    });
  });

  describe('switchAccount', () => {
    it('should POST with userId in body', async () => {
      // Acceptance: Body contains { userId }
    });

    it('should include credentials', async () => {
      // Acceptance: credentials: 'include'
    });
  });

  describe('signOutAccount', () => {
    it('should DELETE to correct endpoint', async () => {
      // Acceptance: DELETE /session/accounts/{userId}
    });

    it('should include credentials', async () => {
      // Acceptance: credentials: 'include'
    });
  });

  describe('signOutAll', () => {
    it('should DELETE to /session/all', async () => {
      // Acceptance: DELETE /session/all with credentials
    });
  });

  describe('checkSession', () => {
    it('should not throw on unauthenticated response', async () => {
      // Acceptance: Returns { authenticated: false } without throwing
    });
  });

  describe('getDevices', () => {
    it('should fetch all user sessions', async () => {
      // Acceptance: GET /session/devices with credentials
    });
  });

  describe('revokeDevice', () => {
    it('should DELETE to correct endpoint', async () => {
      // Acceptance: DELETE /session/devices/{sessionId}
    });
  });
});
```

### AccountSwitcher Component Tests

```typescript
describe('AccountSwitcher', () => {
  it('should load accounts on mount', async () => {
    // Acceptance: Calls sessionManager.getAccounts()
  });

  it('should display active account in trigger', async () => {
    // Acceptance: Shows active account email
  });

  it('should toggle dropdown on click', async () => {
    // Acceptance: Dropdown appears/disappears
  });

  it('should list all accounts in dropdown', async () => {
    // Acceptance: All accounts visible with email
  });

  it('should mark active account with badge', async () => {
    // Acceptance: Active account shows "Active" badge
  });

  it('should disable switch button for active account', async () => {
    // Acceptance: Active account button disabled
  });

  it('should call switchAccount on account click', async () => {
    // Acceptance: sessionManager.switchAccount called
  });

  it('should reload page after switching', async () => {
    // Acceptance: window.location.reload called
  });

  it('should call signOutAccount on sign out click', async () => {
    // Acceptance: sessionManager.signOutAccount called
  });

  it('should redirect to home when all accounts signed out', async () => {
    // Acceptance: If remainingAccounts = 0, redirect to '/'
  });

  it('should show "Add another account" when < 3 accounts', async () => {
    // Acceptance: Button visible when accounts.length < 3
  });

  it('should hide "Add another account" when 3 accounts', async () => {
    // Acceptance: Button not visible when accounts.length >= 3
  });

  it('should redirect to auth with add_account on add click', async () => {
    // Acceptance: Redirects to /authorize?action=add_account
  });

  it('should handle sign out all', async () => {
    // Acceptance: Calls signOutAll then redirects to '/'
  });
});
```

### Hard Sign Out Verification Tests

```typescript
describe('Hard Sign Out - Token Revocation Verification', () => {
  /**
   * These tests verify that ALL sign-out paths properly revoke tokens
   */

  describe('Single Account Sign Out', () => {
    it('should revoke all access tokens for account session', async () => {
      // Setup: Create account session with 3 access tokens
      const tokens = await Promise.all([
        createAccessToken(accountSessionId, 'app1'),
        createAccessToken(accountSessionId, 'app2'),
        createAccessToken(accountSessionId, 'app3'),
      ]);

      // Act
      await request.delete(`/session/accounts/${userId}`);

      // Assert: All tokens should be revoked in DB
      for (const token of tokens) {
        const dbToken = await getToken(token.id);
        expect(dbToken.is_revoked).toBe(true);
      }
    });

    it('should revoke refresh tokens for account session', async () => {
      // Setup: Create refresh token
      const refreshToken = await createRefreshToken(accountSessionId);

      // Act
      await request.delete(`/session/accounts/${userId}`);

      // Assert
      const dbToken = await getRefreshToken(refreshToken.id);
      expect(dbToken.is_revoked).toBe(true);
    });

    it('should fail token refresh after sign out', async () => {
      // Setup: Get valid refresh token
      const { refreshToken } = await login(userId);

      // Act: Sign out
      await request.delete(`/session/accounts/${userId}`);

      // Assert: Refresh should fail
      const response = await request.post('/token', {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_grant');
    });
  });

  describe('All Accounts Sign Out', () => {
    it('should revoke tokens for ALL account sessions in browser', async () => {
      // Setup: 3 accounts, each with tokens
      const accounts = [
        { userId: 'user1', tokens: await createTokensForUser('user1') },
        { userId: 'user2', tokens: await createTokensForUser('user2') },
        { userId: 'user3', tokens: await createTokensForUser('user3') },
      ];

      // Act
      const response = await request.delete('/session/all');

      // Assert: All tokens revoked
      expect(response.body.tokensRevoked).toBe(9); // 3 per user
      for (const account of accounts) {
        for (const token of account.tokens) {
          const dbToken = await getToken(token.id);
          expect(dbToken.is_revoked).toBe(true);
        }
      }
    });
  });

  describe('Remote Device Sign Out', () => {
    it('should revoke tokens on remote device only', async () => {
      // Setup: User on 2 devices
      const device1Tokens = await createTokensForSession(device1SessionId);
      const device2Tokens = await createTokensForSession(device2SessionId);

      // Act: Revoke device 2 from device 1
      await request.delete(`/session/devices/${device2SessionId}`);

      // Assert: Only device 2 tokens revoked
      for (const token of device1Tokens) {
        const dbToken = await getToken(token.id);
        expect(dbToken.is_revoked).toBe(false);
      }
      for (const token of device2Tokens) {
        const dbToken = await getToken(token.id);
        expect(dbToken.is_revoked).toBe(true);
      }
    });

    it('should prevent use of revoked device tokens', async () => {
      // Setup: Get valid access token on device 2
      const { accessToken } = await loginOnDevice(device2SessionId);

      // Act: Revoke device 2 from device 1
      await request.delete(`/session/devices/${device2SessionId}`);

      // Assert: Access token still works (JWT) but refresh fails
      // Access tokens are stateless - valid until expiry
      // But new tokens cannot be obtained
    });
  });
});
```

### E2E Tests

```typescript
test.describe('Session Management E2E', () => {
  test('user can see all logged-in accounts', async ({ page }) => {
    // Login as user 1
    await loginAs(page, 'user1@test.com');

    // Add user 2
    await addAccount(page, 'user2@test.com');

    // Check accounts
    const response = await page.request.get('/session/accounts');
    const data = await response.json();

    expect(data.accounts).toHaveLength(2);
    expect(data.accounts.map(a => a.email)).toContain('user1@test.com');
    expect(data.accounts.map(a => a.email)).toContain('user2@test.com');
  });

  test('user can switch between accounts', async ({ page }) => {
    await loginAs(page, 'user1@test.com');
    await addAccount(page, 'user2@test.com');

    // user2 should be active (most recent)
    let check = await page.request.get('/session/check');
    expect((await check.json()).session.email).toBe('user2@test.com');

    // Switch to user1
    await page.request.post('/session/switch', {
      data: { userId: 'user1-id' },
    });

    check = await page.request.get('/session/check');
    expect((await check.json()).session.email).toBe('user1@test.com');
  });

  test('signing out account revokes its tokens', async ({ page }) => {
    await loginAs(page, 'user1@test.com');
    const { refreshToken } = await getTokens(page);

    await addAccount(page, 'user2@test.com');

    // Sign out user1
    const signOutResponse = await page.request.delete('/session/accounts/user1-id');
    const signOutData = await signOutResponse.json();

    expect(signOutData.tokensRevoked).toBeGreaterThan(0);

    // Verify user1's refresh token is invalid
    const refreshResponse = await page.request.post('/token', {
      data: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      },
    });
    expect(refreshResponse.status()).toBe(400);
  });

  test('sign out all revokes all tokens', async ({ page }) => {
    await loginAs(page, 'user1@test.com');
    await addAccount(page, 'user2@test.com');

    const response = await page.request.delete('/session/all');
    const data = await response.json();

    expect(data.accountsSignedOut).toBe(2);
    expect(data.tokensRevoked).toBeGreaterThan(0);

    // Session check should fail
    const check = await page.request.get('/session/check');
    expect((await check.json()).authenticated).toBe(false);
  });

  test('user can see all their sessions across devices', async ({ page, context }) => {
    await loginAs(page, 'user1@test.com');

    // Login in another "browser"
    const page2 = await context.newPage();
    await loginAs(page2, 'user1@test.com');

    // Check devices
    const response = await page.request.get('/session/devices');
    const data = await response.json();

    expect(data.sessions.length).toBeGreaterThanOrEqual(2);
    expect(data.sessions.filter(s => s.isCurrentSession)).toHaveLength(1);
  });

  test('user can revoke session on another device', async ({ page, context }) => {
    await loginAs(page, 'user1@test.com');

    const page2 = await context.newPage();
    await loginAs(page2, 'user1@test.com');
    const page2RefreshToken = await getRefreshToken(page2);

    // Get sessions from page 1
    const response = await page.request.get('/session/devices');
    const data = await response.json();

    // Find and revoke the other session
    const otherSession = data.sessions.find(s => !s.isCurrentSession);
    const revokeResponse = await page.request.delete(`/session/devices/${otherSession.id}`);
    expect((await revokeResponse.json()).tokensRevoked).toBeGreaterThan(0);

    // page2 should no longer be authenticated
    const check = await page2.request.get('/session/check');
    expect((await check.json()).authenticated).toBe(false);

    // page2's refresh token should be invalid
    const refreshResponse = await page2.request.post('/token', {
      data: { grant_type: 'refresh_token', refresh_token: page2RefreshToken },
    });
    expect(refreshResponse.status()).toBe(400);
  });

  test('cannot revoke current session via remote endpoint', async ({ page }) => {
    await loginAs(page, 'user1@test.com');

    const response = await page.request.get('/session/devices');
    const data = await response.json();
    const currentSession = data.sessions.find(s => s.isCurrentSession);

    const revokeResponse = await page.request.delete(`/session/devices/${currentSession.id}`);
    expect(revokeResponse.status()).toBe(400);
    expect((await revokeResponse.json()).error).toContain('current session');
  });

  test('AccountSwitcher component works correctly', async ({ page }) => {
    await loginAs(page, 'user1@test.com');
    await addAccount(page, 'user2@test.com');

    // Open profile page with AccountSwitcher
    await page.goto('/profile');

    // Click account switcher
    await page.click('.account-switcher-trigger');

    // Should see both accounts
    await expect(page.locator('.account-item')).toHaveCount(2);

    // Active account should have badge
    await expect(page.locator('.active-badge')).toBeVisible();

    // Click non-active account to switch
    await page.click('.account-select:not([disabled])');

    // Page should reload with new active account
    await page.waitForNavigation();
  });
});
```

### Coverage Requirements

| Component | Target Coverage |
|-----------|----------------|
| Session Routes | >90% |
| Session Middleware | 100% |
| SessionManager SDK | >90% |
| AccountSwitcher Component | >80% |
| Token Revocation Logic | 100% |

**Overall Lane 3 Coverage Target: >85%**

**Critical Path Coverage**: The following must have 100% coverage:
- Token revocation in all sign-out endpoints
- Session validation in middleware
- Error responses for invalid sessions

---

## Rollout Checklist

- [ ] Implement session routes
- [ ] Implement requireSession middleware
- [ ] Define API response types
- [ ] Create client SDK (SessionManager)
- [ ] Integrate AccountSwitcher component in profile app
- [ ] Add audit events for all session operations
- [ ] Write unit tests (>80% coverage)
- [ ] Write E2E tests for all flows
- [ ] Update API documentation
- [ ] Test CORS for cross-origin requests
- [ ] Test cookie handling across subdomains

---

## Estimated Effort
- Session routes: 4-6 hours
- Middleware: 1-2 hours
- Client SDK: 2-3 hours
- UI components: 3-4 hours
- Testing: 6-8 hours
- Documentation: 2 hours
- **Total: 18-25 hours**

## Security Considerations
- All session operations require valid browser session cookie
- Users can only manage their own sessions
- Remote revocation logged as warning-level audit event
- Rate limiting on session switch operations
- Cannot revoke current session via remote revoke endpoint

### Hard Sign Out Policy

**All sign-out operations perform HARD sign out:**

| Operation | Session Revoked | Tokens Revoked |
|-----------|-----------------|----------------|
| Sign out single account | ✓ Account session | ✓ All tokens for that session |
| Sign out all accounts | ✓ Browser + all account sessions | ✓ All tokens for all sessions |
| Remote device logout | ✓ Account session on that device | ✓ All tokens for that session |

This ensures:
1. When users sign out, they are **fully** signed out
2. Compromised accounts can be secured by signing out
3. Client apps with existing tokens will fail on next refresh
4. Access tokens remain valid until expiry (1 hour max) but refresh fails immediately

**Token Revocation Flow:**
```
User clicks "Sign Out"
    ↓
API receives DELETE /session/accounts/:userId
    ↓
1. Get account session ID
2. TokenService.revokeSessionTokens(sessionId)
   - Revokes all refresh_tokens for this session
   - Revokes all app_tokens for this session
3. Mark account_session as revoked
4. Return success with tokensRevoked count
```
