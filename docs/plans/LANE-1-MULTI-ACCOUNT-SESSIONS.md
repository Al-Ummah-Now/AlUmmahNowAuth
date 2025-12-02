# Lane 1: Multi-Account Sessions & Browser Sessions

## Overview
Implement the foundational browser session and multi-account session architecture that enables users to have multiple accounts logged in simultaneously (up to 3 accounts per browser).

## Priority: P0 (Critical Foundation)
**Dependencies**: None (foundation layer)
**Blocks**: Lane 2, Lane 3, Lane 6

---

## Current State Analysis

### What Exists:
- Single session per user stored in KV (`auth_session:{userId}`)
- Session contains: userId, email, roles, accessToken, refreshToken, expiresAt
- Cookie-based session (`auth_session`)
- Session expiration checking

### What's Missing:
- Browser session concept (device/browser level)
- Multiple account sessions per browser
- Active account designation
- Session device tracking (UA, IP)

---

## Database Schema Changes

### Migration: 0023_browser_sessions.sql

```sql
-- Browser Sessions: One per browser/device
CREATE TABLE browser_sessions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT DEFAULT 'default',
    session_token_hash TEXT NOT NULL UNIQUE,
    user_agent TEXT,
    ip_address TEXT,
    device_type TEXT, -- 'desktop', 'mobile', 'tablet'
    device_name TEXT, -- Parsed from UA: 'Chrome on Windows'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_activity TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    is_revoked INTEGER DEFAULT 0
);

CREATE INDEX idx_browser_sessions_token ON browser_sessions(session_token_hash);
CREATE INDEX idx_browser_sessions_tenant ON browser_sessions(tenant_id);
CREATE INDEX idx_browser_sessions_expires ON browser_sessions(expires_at);

-- Account Sessions: Multiple accounts per browser session
CREATE TABLE account_sessions (
    id TEXT PRIMARY KEY,
    browser_session_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    is_active INTEGER DEFAULT 0, -- Only one active per browser session
    authenticated_at TEXT NOT NULL DEFAULT (datetime('now')),
    auth_method TEXT DEFAULT 'email', -- 'email', 'google', 'mfa'
    last_used TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    is_revoked INTEGER DEFAULT 0,
    FOREIGN KEY (browser_session_id) REFERENCES browser_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE INDEX idx_account_sessions_browser ON account_sessions(browser_session_id);
CREATE INDEX idx_account_sessions_user ON account_sessions(user_id);
CREATE INDEX idx_account_sessions_active ON account_sessions(browser_session_id, is_active);
CREATE UNIQUE INDEX idx_account_sessions_unique_user ON account_sessions(browser_session_id, user_id);

-- Constraint: Max 3 accounts per browser session (enforced in application layer)
-- Constraint: Only 1 active account per browser session (enforced via trigger or app)
```

### Migration: 0024_account_sessions_trigger.sql

```sql
-- Trigger to ensure only one active account per browser session
CREATE TRIGGER ensure_single_active_account
BEFORE UPDATE ON account_sessions
WHEN NEW.is_active = 1
BEGIN
    UPDATE account_sessions
    SET is_active = 0
    WHERE browser_session_id = NEW.browser_session_id
    AND id != NEW.id;
END;
```

---

## New Types & Interfaces

### File: apps/auth/src/types/sessions.ts

```typescript
export interface BrowserSession {
  id: string;
  tenantId: string;
  sessionTokenHash: string;
  userAgent: string | null;
  ipAddress: string | null;
  deviceType: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  deviceName: string | null;
  createdAt: string;
  lastActivity: string;
  expiresAt: string;
  isRevoked: boolean;
}

export interface AccountSession {
  id: string;
  browserSessionId: string;
  userId: string;
  isActive: boolean;
  authenticatedAt: string;
  authMethod: 'email' | 'google' | 'mfa' | 'password';
  lastUsed: string;
  expiresAt: string;
  isRevoked: boolean;
}

export interface AccountSessionWithUser extends AccountSession {
  user: {
    id: string;
    email: string;
    name?: string;
    avatarUrl?: string;
  };
}

export interface BrowserSessionWithAccounts extends BrowserSession {
  accounts: AccountSessionWithUser[];
  activeAccount: AccountSessionWithUser | null;
}

export interface SessionContext {
  browserSession: BrowserSession;
  activeAccount: AccountSession | null;
  accounts: AccountSession[];
}

export const SESSION_CONSTRAINTS = {
  MAX_ACCOUNTS_PER_BROWSER: 3,
  MAX_SESSIONS_PER_USER: 10,
  SESSION_LIFETIME_DAYS: 7,
  IDLE_TIMEOUT_HOURS: 24,
} as const;

// Error codes for session operations
export const SESSION_ERRORS = {
  MAX_ACCOUNTS_REACHED: 'MAX_ACCOUNTS_REACHED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_REVOKED: 'SESSION_REVOKED',
  INVALID_SESSION: 'INVALID_SESSION',
} as const;

export type SessionError = typeof SESSION_ERRORS[keyof typeof SESSION_ERRORS];
```

---

## Max Accounts Enforcement Strategy

### Overview

The max accounts constraint (3 accounts per browser session) is enforced at **two levels**:

1. **Database Level**: Unique constraint prevents duplicate user-browser combinations
2. **Service Level**: Count check before adding new accounts

### Why Service-Level Enforcement?

The service level check provides:
- Better error messages for users
- Ability to handle gracefully (e.g., show account picker instead of error)
- Option to implement account replacement flows in the future
- Logging/audit of max account attempts

### Enforcement Flow - Graceful Handling

**Important**: Max accounts should NEVER break the user's login flow to a client app.

```
User tries to log in to Client App with new credentials
    ↓
User already has 3 accounts in browser session
    ↓
BEFORE attempting new login, check account count
    ↓
If count >= 3:
    ↓
Redirect to Account Picker with special mode
    ↓
Account Picker shows:
  - Existing 3 accounts (can select to continue)
  - "Sign out of an account to use a different one" option
    ↓
User either:
  A) Selects existing account → Continue OAuth flow
  B) Signs out of one account → Redirect back to login → Add new account
```

### Pre-Login Check (Not Post-Login Error)

The key is to check BEFORE attempting authentication, not after:

```typescript
// In OIDC authorize handler - BEFORE showing login form
async function handleAuthorize(req: Request, browserSession: BrowserSession) {
  const accountSessionService = new AccountSessionService(db);
  const accounts = await accountSessionService.getAccountsForBrowserSession(browserSession.id);

  const prompt = url.searchParams.get('prompt');
  const isAddingNewAccount = prompt === 'login' || !accounts.some(a => a.isActive);

  // If user wants to add new account but already at max
  if (isAddingNewAccount && accounts.length >= 3) {
    // Don't show login form - redirect to account picker
    const pickerUrl = new URL('/account-picker', req.url);
    pickerUrl.searchParams.set('mode', 'max_reached');
    // Preserve OAuth params
    pickerUrl.searchParams.set('client_id', clientId);
    pickerUrl.searchParams.set('redirect_uri', redirectUri);
    pickerUrl.searchParams.set('state', state);
    return Response.redirect(pickerUrl);
  }

  // Otherwise proceed with normal flow
  // ...
}
```

### Account Picker Max Accounts Mode

When `mode=max_reached`, the Account Picker shows a different UI:

```typescript
// In Account Picker page
if (mode === 'max_reached') {
  return (
    <div className="account-picker-page">
      <div className="picker-container">
        <div className="picker-header">
          <h1>Choose an account</h1>
          <p>to continue to <strong>{clientId}</strong></p>
        </div>

        <div className="info-banner">
          You have 3 accounts signed in. Select one below, or sign out
          of an account to use a different one.
        </div>

        <div className="accounts-list">
          {accounts.map((account) => (
            <AccountOption
              key={account.userId}
              account={account}
              onSelect={() => handleSelectAccount(account.userId)}
            />
          ))}
        </div>

        <div className="divider">or</div>

        <div className="sign-out-section">
          <p>Sign out of an account to add a different one:</p>
          {accounts.map((account) => (
            <SignOutOption
              key={account.userId}
              account={account}
              onSignOut={() => handleSignOutAndRedirectToLogin(account.userId)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
```

### Sign Out and Continue Flow

When user signs out of an account to make room:

```typescript
async function handleSignOutAndRedirectToLogin(userIdToRemove: string) {
  // Sign out the selected account
  await fetch(`${authUrl}/session/accounts/${userIdToRemove}`, {
    method: 'DELETE',
    credentials: 'include',
  });

  // Redirect back to login with original OAuth params
  // Now they have only 2 accounts, so login form will show
  const loginUrl = new URL('/authorize', window.location.origin);
  loginUrl.searchParams.set('client_id', oauthParams.clientId);
  loginUrl.searchParams.set('redirect_uri', oauthParams.redirectUri);
  loginUrl.searchParams.set('prompt', 'login'); // Force login form
  loginUrl.searchParams.set('state', oauthParams.state);

  window.location.href = loginUrl.toString();
}
```

### Summary: No Broken Flows

| Scenario | Behavior |
|----------|----------|
| User has 0-2 accounts, logs in | Normal login, adds account |
| User has 3 accounts, prompt=none | SSO with active account |
| User has 3 accounts, prompt=select_account | Show picker, select existing |
| User has 3 accounts, prompt=login | Show picker with sign-out option |
| User has 3 accounts, no active, needs to log in | Show picker with sign-out option |

The login flow to a client app is **never broken** - user always has a path forward.

---

## Service Implementation

### File: apps/auth/src/services/browser-session.service.ts

```typescript
import { generateId } from '../utils/id';
import { hashToken } from '../utils/crypto';
import { parseUserAgent } from '../utils/user-agent';
import type { D1Database } from '@cloudflare/workers-types';
import type { BrowserSession, AccountSession, BrowserSessionWithAccounts, SESSION_CONSTRAINTS } from '../types/sessions';

export class BrowserSessionService {
  constructor(private db: D1Database) {}

  /**
   * Create a new browser session
   */
  async createBrowserSession(params: {
    tenantId?: string;
    userAgent: string;
    ipAddress: string;
  }): Promise<{ session: BrowserSession; token: string }> {
    const id = generateId('bs');
    const token = generateId('bst', 32); // Browser session token
    const tokenHash = await hashToken(token);
    const { deviceType, deviceName } = parseUserAgent(params.userAgent);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + SESSION_CONSTRAINTS.SESSION_LIFETIME_DAYS);

    await this.db.prepare(`
      INSERT INTO browser_sessions (id, tenant_id, session_token_hash, user_agent, ip_address, device_type, device_name, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      params.tenantId || 'default',
      tokenHash,
      params.userAgent,
      params.ipAddress,
      deviceType,
      deviceName,
      expiresAt.toISOString()
    ).run();

    const session = await this.getBrowserSessionById(id);
    return { session: session!, token };
  }

  /**
   * Get browser session by token
   */
  async getBrowserSessionByToken(token: string): Promise<BrowserSession | null> {
    const tokenHash = await hashToken(token);
    const result = await this.db.prepare(`
      SELECT * FROM browser_sessions
      WHERE session_token_hash = ?
      AND is_revoked = 0
      AND expires_at > datetime('now')
    `).bind(tokenHash).first();

    return result ? this.mapBrowserSession(result) : null;
  }

  /**
   * Get browser session by ID
   */
  async getBrowserSessionById(id: string): Promise<BrowserSession | null> {
    const result = await this.db.prepare(`
      SELECT * FROM browser_sessions WHERE id = ?
    `).bind(id).first();

    return result ? this.mapBrowserSession(result) : null;
  }

  /**
   * Get browser session with all accounts
   */
  async getBrowserSessionWithAccounts(sessionId: string): Promise<BrowserSessionWithAccounts | null> {
    const session = await this.getBrowserSessionById(sessionId);
    if (!session) return null;

    const accounts = await this.db.prepare(`
      SELECT
        a.*,
        u.id as user_id,
        u.email as user_email
      FROM account_sessions a
      JOIN user u ON a.user_id = u.id
      WHERE a.browser_session_id = ?
      AND a.is_revoked = 0
      AND a.expires_at > datetime('now')
      ORDER BY a.is_active DESC, a.last_used DESC
    `).bind(sessionId).all();

    const mappedAccounts = accounts.results.map(this.mapAccountSessionWithUser);

    return {
      ...session,
      accounts: mappedAccounts,
      activeAccount: mappedAccounts.find(a => a.isActive) || null,
    };
  }

  /**
   * Update last activity timestamp
   */
  async touchBrowserSession(sessionId: string): Promise<void> {
    await this.db.prepare(`
      UPDATE browser_sessions
      SET last_activity = datetime('now')
      WHERE id = ?
    `).bind(sessionId).run();
  }

  /**
   * Revoke browser session (logs out all accounts)
   */
  async revokeBrowserSession(sessionId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare(`UPDATE browser_sessions SET is_revoked = 1 WHERE id = ?`).bind(sessionId),
      this.db.prepare(`UPDATE account_sessions SET is_revoked = 1 WHERE browser_session_id = ?`).bind(sessionId),
    ]);
  }

  /**
   * Clean up expired sessions
   */
  async cleanupExpiredSessions(): Promise<{ deleted: number }> {
    const result = await this.db.prepare(`
      DELETE FROM browser_sessions
      WHERE expires_at < datetime('now') OR is_revoked = 1
    `).run();

    return { deleted: result.meta.changes || 0 };
  }

  private mapBrowserSession(row: any): BrowserSession {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      sessionTokenHash: row.session_token_hash,
      userAgent: row.user_agent,
      ipAddress: row.ip_address,
      deviceType: row.device_type,
      deviceName: row.device_name,
      createdAt: row.created_at,
      lastActivity: row.last_activity,
      expiresAt: row.expires_at,
      isRevoked: Boolean(row.is_revoked),
    };
  }

  private mapAccountSessionWithUser(row: any): AccountSessionWithUser {
    return {
      id: row.id,
      browserSessionId: row.browser_session_id,
      userId: row.user_id,
      isActive: Boolean(row.is_active),
      authenticatedAt: row.authenticated_at,
      authMethod: row.auth_method,
      lastUsed: row.last_used,
      expiresAt: row.expires_at,
      isRevoked: Boolean(row.is_revoked),
      user: {
        id: row.user_id,
        email: row.user_email,
      },
    };
  }
}
```

### File: apps/auth/src/services/account-session.service.ts

```typescript
import { generateId } from '../utils/id';
import type { D1Database } from '@cloudflare/workers-types';
import type { AccountSession, SESSION_CONSTRAINTS } from '../types/sessions';

export class AccountSessionService {
  constructor(private db: D1Database) {}

  /**
   * Add an account to browser session
   * Enforces max 3 accounts constraint
   */
  async addAccountToSession(params: {
    browserSessionId: string;
    userId: string;
    authMethod?: string;
    setActive?: boolean;
  }): Promise<AccountSession> {
    // Check account limit
    const count = await this.db.prepare(`
      SELECT COUNT(*) as count FROM account_sessions
      WHERE browser_session_id = ? AND is_revoked = 0
    `).bind(params.browserSessionId).first<{ count: number }>();

    if (count && count.count >= SESSION_CONSTRAINTS.MAX_ACCOUNTS_PER_BROWSER) {
      throw new Error(`Maximum ${SESSION_CONSTRAINTS.MAX_ACCOUNTS_PER_BROWSER} accounts per browser session`);
    }

    // Check if user already has session in this browser
    const existing = await this.db.prepare(`
      SELECT id FROM account_sessions
      WHERE browser_session_id = ? AND user_id = ? AND is_revoked = 0
    `).bind(params.browserSessionId, params.userId).first();

    if (existing) {
      // Reactivate existing session
      if (params.setActive !== false) {
        await this.setActiveAccount(params.browserSessionId, existing.id as string);
      }
      return this.getAccountSessionById(existing.id as string) as Promise<AccountSession>;
    }

    const id = generateId('as');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + SESSION_CONSTRAINTS.SESSION_LIFETIME_DAYS);

    // If setActive, deactivate others first
    if (params.setActive !== false) {
      await this.db.prepare(`
        UPDATE account_sessions SET is_active = 0
        WHERE browser_session_id = ?
      `).bind(params.browserSessionId).run();
    }

    await this.db.prepare(`
      INSERT INTO account_sessions (id, browser_session_id, user_id, auth_method, is_active, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      params.browserSessionId,
      params.userId,
      params.authMethod || 'email',
      params.setActive !== false ? 1 : 0,
      expiresAt.toISOString()
    ).run();

    return this.getAccountSessionById(id) as Promise<AccountSession>;
  }

  /**
   * Switch active account in browser session
   */
  async setActiveAccount(browserSessionId: string, accountSessionId: string): Promise<void> {
    await this.db.batch([
      // Deactivate all accounts in this browser session
      this.db.prepare(`
        UPDATE account_sessions SET is_active = 0
        WHERE browser_session_id = ?
      `).bind(browserSessionId),
      // Activate the specified account
      this.db.prepare(`
        UPDATE account_sessions SET is_active = 1, last_used = datetime('now')
        WHERE id = ? AND browser_session_id = ?
      `).bind(accountSessionId, browserSessionId),
    ]);
  }

  /**
   * Switch active account by user ID
   */
  async setActiveAccountByUserId(browserSessionId: string, userId: string): Promise<AccountSession | null> {
    const account = await this.db.prepare(`
      SELECT id FROM account_sessions
      WHERE browser_session_id = ? AND user_id = ? AND is_revoked = 0
    `).bind(browserSessionId, userId).first();

    if (!account) return null;

    await this.setActiveAccount(browserSessionId, account.id as string);
    return this.getAccountSessionById(account.id as string);
  }

  /**
   * Remove account from browser session
   */
  async removeAccountFromSession(browserSessionId: string, userId: string): Promise<{ wasActive: boolean; newActiveId: string | null }> {
    const account = await this.db.prepare(`
      SELECT id, is_active FROM account_sessions
      WHERE browser_session_id = ? AND user_id = ?
    `).bind(browserSessionId, userId).first();

    if (!account) {
      return { wasActive: false, newActiveId: null };
    }

    const wasActive = Boolean(account.is_active);

    // Revoke the account session
    await this.db.prepare(`
      UPDATE account_sessions SET is_revoked = 1, is_active = 0
      WHERE id = ?
    `).bind(account.id).run();

    let newActiveId: string | null = null;

    // If was active, make another account active
    if (wasActive) {
      const nextAccount = await this.db.prepare(`
        SELECT id FROM account_sessions
        WHERE browser_session_id = ? AND is_revoked = 0
        ORDER BY last_used DESC
        LIMIT 1
      `).bind(browserSessionId).first();

      if (nextAccount) {
        newActiveId = nextAccount.id as string;
        await this.db.prepare(`
          UPDATE account_sessions SET is_active = 1
          WHERE id = ?
        `).bind(newActiveId).run();
      }
    }

    return { wasActive, newActiveId };
  }

  /**
   * Get account session by ID
   */
  async getAccountSessionById(id: string): Promise<AccountSession | null> {
    const result = await this.db.prepare(`
      SELECT * FROM account_sessions WHERE id = ?
    `).bind(id).first();

    return result ? this.mapAccountSession(result) : null;
  }

  /**
   * Get all sessions for a user across all browsers
   */
  async getUserSessions(userId: string): Promise<Array<AccountSession & { browserSession: any }>> {
    const results = await this.db.prepare(`
      SELECT
        a.*,
        b.device_type,
        b.device_name,
        b.ip_address,
        b.last_activity as browser_last_activity,
        b.created_at as browser_created_at
      FROM account_sessions a
      JOIN browser_sessions b ON a.browser_session_id = b.id
      WHERE a.user_id = ? AND a.is_revoked = 0 AND b.is_revoked = 0
      ORDER BY a.last_used DESC
    `).bind(userId).all();

    return results.results.map(row => ({
      ...this.mapAccountSession(row),
      browserSession: {
        deviceType: row.device_type,
        deviceName: row.device_name,
        ipAddress: row.ip_address,
        lastActivity: row.browser_last_activity,
        createdAt: row.browser_created_at,
      },
    }));
  }

  /**
   * Revoke all sessions for a user
   */
  async revokeAllUserSessions(userId: string): Promise<{ revoked: number }> {
    const result = await this.db.prepare(`
      UPDATE account_sessions SET is_revoked = 1, is_active = 0
      WHERE user_id = ?
    `).bind(userId).run();

    return { revoked: result.meta.changes || 0 };
  }

  /**
   * Touch session (update last_used)
   */
  async touchAccountSession(accountSessionId: string): Promise<void> {
    await this.db.prepare(`
      UPDATE account_sessions SET last_used = datetime('now')
      WHERE id = ?
    `).bind(accountSessionId).run();
  }

  /**
   * Get active account for browser session
   */
  async getActiveAccount(browserSessionId: string): Promise<AccountSession | null> {
    const result = await this.db.prepare(`
      SELECT * FROM account_sessions
      WHERE browser_session_id = ? AND is_active = 1 AND is_revoked = 0
    `).bind(browserSessionId).first();

    return result ? this.mapAccountSession(result) : null;
  }

  private mapAccountSession(row: any): AccountSession {
    return {
      id: row.id,
      browserSessionId: row.browser_session_id,
      userId: row.user_id,
      isActive: Boolean(row.is_active),
      authenticatedAt: row.authenticated_at,
      authMethod: row.auth_method,
      lastUsed: row.last_used,
      expiresAt: row.expires_at,
      isRevoked: Boolean(row.is_revoked),
    };
  }
}
```

---

## Utility Functions

### File: apps/auth/src/utils/user-agent.ts

```typescript
export interface ParsedUserAgent {
  deviceType: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  deviceName: string;
  browser: string;
  os: string;
}

export function parseUserAgent(ua: string): ParsedUserAgent {
  const result: ParsedUserAgent = {
    deviceType: 'unknown',
    deviceName: 'Unknown Device',
    browser: 'Unknown',
    os: 'Unknown',
  };

  if (!ua) return result;

  // Detect OS
  if (ua.includes('Windows')) result.os = 'Windows';
  else if (ua.includes('Mac OS X')) result.os = 'macOS';
  else if (ua.includes('Linux')) result.os = 'Linux';
  else if (ua.includes('Android')) result.os = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) result.os = 'iOS';
  else if (ua.includes('CrOS')) result.os = 'Chrome OS';

  // Detect Browser
  if (ua.includes('Chrome') && !ua.includes('Edg')) result.browser = 'Chrome';
  else if (ua.includes('Firefox')) result.browser = 'Firefox';
  else if (ua.includes('Safari') && !ua.includes('Chrome')) result.browser = 'Safari';
  else if (ua.includes('Edg')) result.browser = 'Edge';
  else if (ua.includes('Opera') || ua.includes('OPR')) result.browser = 'Opera';

  // Detect Device Type
  if (ua.includes('Mobile') || ua.includes('Android') && !ua.includes('Tablet')) {
    result.deviceType = 'mobile';
  } else if (ua.includes('iPad') || ua.includes('Tablet')) {
    result.deviceType = 'tablet';
  } else if (ua.includes('Windows') || ua.includes('Macintosh') || ua.includes('Linux')) {
    result.deviceType = 'desktop';
  }

  // Build device name
  result.deviceName = `${result.browser} on ${result.os}`;

  return result;
}
```

### File: apps/auth/src/utils/crypto.ts (add to existing)

```typescript
export async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function generateSecureToken(length: number = 32): Promise<string> {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}
```

---

## Cookie Management

### File: apps/auth/src/utils/session-cookie.ts

```typescript
export interface SessionCookieOptions {
  domain?: string;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  maxAge?: number;
}

export const SESSION_COOKIE_NAME = '__session';
export const SESSION_COOKIE_DEFAULTS: SessionCookieOptions = {
  secure: true,
  sameSite: 'Lax',
  maxAge: 604800, // 7 days
};

export function createSessionCookie(token: string, options: SessionCookieOptions = {}): string {
  const opts = { ...SESSION_COOKIE_DEFAULTS, ...options };
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'HttpOnly',
    `Max-Age=${opts.maxAge}`,
    `SameSite=${opts.sameSite}`,
  ];

  if (opts.secure) parts.push('Secure');
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  parts.push('Path=/');

  return parts.join('; ');
}

export function clearSessionCookie(domain?: string): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'Max-Age=0',
    'SameSite=Lax',
    'Path=/',
  ];

  if (domain) parts.push(`Domain=${domain}`);

  return parts.join('; ');
}

export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';').map(c => c.trim());
  const sessionCookie = cookies.find(c => c.startsWith(`${SESSION_COOKIE_NAME}=`));

  if (!sessionCookie) return null;

  return sessionCookie.slice(SESSION_COOKIE_NAME.length + 1);
}
```

---

## Integration Points

### Modify: apps/auth/src/index.ts

Add session middleware and routes:

```typescript
import { BrowserSessionService } from './services/browser-session.service';
import { AccountSessionService } from './services/account-session.service';
import { parseSessionCookie, createSessionCookie } from './utils/session-cookie';

// Session middleware - extract and validate browser session
app.use('*', async (c, next) => {
  const cookieHeader = c.req.header('Cookie');
  const sessionToken = parseSessionCookie(cookieHeader);

  if (sessionToken) {
    const browserSessionService = new BrowserSessionService(c.env.AUTH_DB);
    const browserSession = await browserSessionService.getBrowserSessionByToken(sessionToken);

    if (browserSession) {
      // Touch session to extend activity
      await browserSessionService.touchBrowserSession(browserSession.id);

      const accountSessionService = new AccountSessionService(c.env.AUTH_DB);
      const activeAccount = await accountSessionService.getActiveAccount(browserSession.id);

      c.set('browserSession', browserSession);
      c.set('activeAccount', activeAccount);
    }
  }

  await next();
});
```

---

## Testing Requirements

### Unit Tests

#### File: apps/auth/src/services/__tests__/browser-session.service.test.ts

```typescript
describe('BrowserSessionService', () => {
  describe('createBrowserSession', () => {
    it('should create session with valid params and return token', async () => {
      // Acceptance: Session created in DB with correct tenant, UA, IP
      // Token returned is non-empty and unique
    });

    it('should parse user agent into device type and name', async () => {
      // Test: Chrome on Windows → deviceType: 'desktop', deviceName: 'Chrome on Windows'
      // Test: Safari on iPhone → deviceType: 'mobile', deviceName: 'Safari on iOS'
      // Test: Firefox on iPad → deviceType: 'tablet', deviceName: 'Firefox on iOS'
    });

    it('should set correct expiration (7 days from now)', async () => {
      // Acceptance: expiresAt is exactly SESSION_LIFETIME_DAYS in future
    });

    it('should hash token before storing', async () => {
      // Acceptance: sessionTokenHash !== raw token
      // Acceptance: Same token produces same hash (deterministic)
    });

    it('should use default tenant when not specified', async () => {
      // Acceptance: tenantId = 'default' when not provided
    });
  });

  describe('getBrowserSessionByToken', () => {
    it('should return session for valid token', async () => {
      // Acceptance: Returns full BrowserSession object
    });

    it('should return null for invalid token', async () => {
      // Acceptance: No error thrown, returns null
    });

    it('should return null for expired session', async () => {
      // Acceptance: Session with expiresAt in past returns null
    });

    it('should return null for revoked session', async () => {
      // Acceptance: Session with isRevoked=true returns null
    });

    it('should be case-sensitive for tokens', async () => {
      // Acceptance: 'Token123' !== 'token123'
    });
  });

  describe('getBrowserSessionWithAccounts', () => {
    it('should return session with empty accounts array when no accounts', async () => {
      // Acceptance: accounts = [], activeAccount = null
    });

    it('should return session with all non-revoked accounts', async () => {
      // Setup: 3 accounts, 1 revoked
      // Acceptance: Returns 2 accounts, not the revoked one
    });

    it('should identify active account correctly', async () => {
      // Acceptance: activeAccount matches account with isActive=true
    });

    it('should include user details (email, name) with accounts', async () => {
      // Acceptance: Each account has user.email, user.id populated
    });

    it('should order accounts by active first, then by last_used', async () => {
      // Acceptance: Active account at index 0, then most recently used
    });

    it('should exclude expired account sessions', async () => {
      // Acceptance: Accounts with expiresAt in past not returned
    });
  });

  describe('touchBrowserSession', () => {
    it('should update last_activity timestamp', async () => {
      // Acceptance: last_activity changes after touch
    });

    it('should not extend expiration', async () => {
      // Acceptance: expiresAt remains unchanged
    });

    it('should handle non-existent session gracefully', async () => {
      // Acceptance: No error thrown for invalid ID
    });
  });

  describe('revokeBrowserSession', () => {
    it('should mark browser session as revoked', async () => {
      // Acceptance: isRevoked = true in DB
    });

    it('should cascade revocation to all account sessions', async () => {
      // Setup: Browser session with 3 accounts
      // Acceptance: All 3 account_sessions have isRevoked = true
    });

    it('should be idempotent (multiple revocations ok)', async () => {
      // Acceptance: Second revocation doesn't error
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('should delete sessions past expiration', async () => {
      // Setup: 2 expired, 1 valid session
      // Acceptance: deleted = 2, valid session remains
    });

    it('should delete revoked sessions', async () => {
      // Acceptance: isRevoked = true sessions deleted
    });

    it('should return count of deleted sessions', async () => {
      // Acceptance: { deleted: N } matches actual count
    });

    it('should cascade delete account_sessions via FK', async () => {
      // Acceptance: account_sessions for deleted browser_sessions also gone
    });
  });
});
```

#### File: apps/auth/src/services/__tests__/account-session.service.test.ts

```typescript
describe('AccountSessionService', () => {
  describe('addAccountToSession', () => {
    it('should add first account and set as active', async () => {
      // Acceptance: Account created with isActive = true
    });

    it('should add second account as inactive by default', async () => {
      // Acceptance: Second account isActive = false
      // Acceptance: First account remains active
    });

    it('should set second account active when setActive=true', async () => {
      // Acceptance: Second account isActive = true
      // Acceptance: First account isActive = false (trigger fired)
    });

    it('should enforce max 3 accounts limit', async () => {
      // Setup: Add 3 accounts successfully
      // Test: 4th account throws "Maximum 3 accounts per browser session"
    });

    it('should reactivate existing account instead of creating duplicate', async () => {
      // Setup: User A logged in, then logged out (revoked)
      // Test: User A logs in again → existing session reactivated, not new row
    });

    it('should record auth method correctly', async () => {
      // Test: authMethod='google' → stored as 'google'
      // Test: authMethod=undefined → defaults to 'email'
    });

    it('should set correct expiration for account session', async () => {
      // Acceptance: expiresAt = SESSION_LIFETIME_DAYS from now
    });
  });

  describe('setActiveAccount', () => {
    it('should activate specified account', async () => {
      // Acceptance: Target account isActive = true
    });

    it('should deactivate all other accounts', async () => {
      // Setup: 3 accounts, account 2 active
      // Test: Set account 3 active
      // Acceptance: Only account 3 isActive = true
    });

    it('should update last_used timestamp', async () => {
      // Acceptance: last_used changes after activation
    });

    it('should handle account from different browser session', async () => {
      // Acceptance: Only affects accounts in same browser session
    });
  });

  describe('setActiveAccountByUserId', () => {
    it('should find and activate account by user ID', async () => {
      // Acceptance: Returns activated AccountSession
    });

    it('should return null for non-existent user in session', async () => {
      // Acceptance: Returns null, no error
    });

    it('should return null for revoked account session', async () => {
      // Acceptance: Revoked accounts not reactivated
    });
  });

  describe('removeAccountFromSession', () => {
    it('should revoke account session', async () => {
      // Acceptance: isRevoked = true, isActive = false
    });

    it('should auto-activate next account when removing active', async () => {
      // Setup: 3 accounts, account 1 active
      // Test: Remove account 1
      // Acceptance: Account 2 or 3 becomes active (by last_used)
    });

    it('should not change active when removing inactive', async () => {
      // Setup: 3 accounts, account 1 active
      // Test: Remove account 2
      // Acceptance: Account 1 still active
    });

    it('should return wasActive=true when removed active account', async () => {
      // Acceptance: { wasActive: true, newActiveId: 'as_xxx' }
    });

    it('should return wasActive=false when removed inactive account', async () => {
      // Acceptance: { wasActive: false, newActiveId: null }
    });

    it('should return newActiveId=null when no accounts remain', async () => {
      // Setup: 1 account, active
      // Test: Remove only account
      // Acceptance: { wasActive: true, newActiveId: null }
    });
  });

  describe('getUserSessions', () => {
    it('should return all active sessions for user across browsers', async () => {
      // Setup: User logged into 3 different browsers
      // Acceptance: Returns 3 sessions with browser details
    });

    it('should include browser session details', async () => {
      // Acceptance: Each result has browserSession.deviceType, deviceName, ipAddress
    });

    it('should exclude revoked sessions', async () => {
      // Acceptance: Revoked account sessions not returned
    });

    it('should exclude sessions from revoked browser sessions', async () => {
      // Acceptance: If browser_session revoked, account_sessions not returned
    });

    it('should order by last_used descending', async () => {
      // Acceptance: Most recently used session first
    });
  });

  describe('revokeAllUserSessions', () => {
    it('should revoke all sessions for user', async () => {
      // Setup: User in 5 browser sessions
      // Acceptance: All 5 have isRevoked = true
    });

    it('should return count of revoked sessions', async () => {
      // Acceptance: { revoked: 5 }
    });

    it('should set isActive=false on all revoked sessions', async () => {
      // Acceptance: No active sessions remain
    });

    it('should not affect other users in same browser sessions', async () => {
      // Setup: Browser with User A and User B
      // Test: Revoke all User A sessions
      // Acceptance: User B session unchanged
    });
  });

  describe('getActiveAccount', () => {
    it('should return active account for browser session', async () => {
      // Acceptance: Returns AccountSession with isActive = true
    });

    it('should return null when no active account', async () => {
      // Setup: All accounts inactive or revoked
      // Acceptance: Returns null
    });

    it('should return null for revoked active account', async () => {
      // Setup: Active account is also revoked
      // Acceptance: Returns null (revoked filter applied)
    });
  });
});
```

### Max Accounts Enforcement Tests

```typescript
describe('Max Accounts Enforcement', () => {
  describe('Pre-login check flow', () => {
    it('should allow login when user has 0-2 accounts', async () => {
      // Acceptance: Login form shown, no redirect
    });

    it('should redirect to account picker when user has 3 accounts and prompt=login', async () => {
      // Acceptance: Redirect to /account-picker?mode=max_reached
    });

    it('should preserve OAuth params in redirect', async () => {
      // Acceptance: client_id, redirect_uri, state all in picker URL
    });

    it('should allow SSO (prompt=none) even with 3 accounts', async () => {
      // Acceptance: Silent auth with active account, no picker redirect
    });

    it('should show account picker (not error) for prompt=select_account with 3 accounts', async () => {
      // Acceptance: Normal picker shown, user can select existing account
    });
  });

  describe('Account Picker max_reached mode', () => {
    it('should show info banner about 3 account limit', async () => {
      // Acceptance: Banner text mentions limit
    });

    it('should allow selecting existing account to continue', async () => {
      // Acceptance: Click account → OAuth flow continues
    });

    it('should show sign-out option for each account', async () => {
      // Acceptance: 3 sign-out buttons visible
    });

    it('should redirect to login after sign-out', async () => {
      // Acceptance: After DELETE /session/accounts/:userId, redirect to /authorize?prompt=login
    });
  });
});
```

### Session Cookie Tests

```typescript
describe('Session Cookie Management', () => {
  describe('createSessionCookie', () => {
    it('should create HttpOnly cookie', async () => {
      // Acceptance: Cookie string contains 'HttpOnly'
    });

    it('should set Secure flag in production', async () => {
      // Acceptance: Cookie string contains 'Secure'
    });

    it('should set SameSite=Lax by default', async () => {
      // Acceptance: Cookie string contains 'SameSite=Lax'
    });

    it('should set Max-Age to 7 days', async () => {
      // Acceptance: Cookie contains 'Max-Age=604800'
    });

    it('should include domain when specified', async () => {
      // Acceptance: Cookie contains 'Domain=example.com'
    });

    it('should set Path=/', async () => {
      // Acceptance: Cookie contains 'Path=/'
    });
  });

  describe('parseSessionCookie', () => {
    it('should extract session token from cookie header', async () => {
      // Input: '__session=abc123; other=xyz'
      // Acceptance: Returns 'abc123'
    });

    it('should return null for missing cookie', async () => {
      // Input: 'other=xyz; another=123'
      // Acceptance: Returns null
    });

    it('should return null for empty cookie header', async () => {
      // Input: null or ''
      // Acceptance: Returns null
    });
  });

  describe('clearSessionCookie', () => {
    it('should return cookie with Max-Age=0', async () => {
      // Acceptance: Cookie expires immediately
    });

    it('should include domain when specified', async () => {
      // Acceptance: Domain preserved for proper clearing
    });
  });
});
```

### User Agent Parser Tests

```typescript
describe('parseUserAgent', () => {
  const testCases = [
    {
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      expected: { deviceType: 'desktop', browser: 'Chrome', os: 'Windows' }
    },
    {
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
      expected: { deviceType: 'desktop', browser: 'Safari', os: 'macOS' }
    },
    {
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1',
      expected: { deviceType: 'mobile', browser: 'Safari', os: 'iOS' }
    },
    {
      ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0 Mobile Safari/537.36',
      expected: { deviceType: 'mobile', browser: 'Chrome', os: 'Android' }
    },
    {
      ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Safari/604.1',
      expected: { deviceType: 'tablet', browser: 'Safari', os: 'iOS' }
    },
    {
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/120.0.0.0',
      expected: { deviceType: 'desktop', browser: 'Edge', os: 'Windows' }
    },
    {
      ua: '',
      expected: { deviceType: 'unknown', browser: 'Unknown', os: 'Unknown' }
    },
  ];

  testCases.forEach(({ ua, expected }) => {
    it(`should parse: ${ua.substring(0, 50)}...`, () => {
      const result = parseUserAgent(ua);
      expect(result.deviceType).toBe(expected.deviceType);
      expect(result.browser).toBe(expected.browser);
      expect(result.os).toBe(expected.os);
    });
  });
});
```

### Integration Tests

```typescript
describe('Session Middleware Integration', () => {
  it('should create browser session on first request', async () => {
    // Request: No cookie
    // Acceptance: Response sets __session cookie
  });

  it('should restore browser session from valid cookie', async () => {
    // Request: Valid __session cookie
    // Acceptance: c.get('browserSession') populated
  });

  it('should set activeAccount in context when available', async () => {
    // Request: Cookie with active account
    // Acceptance: c.get('activeAccount') populated
  });

  it('should touch session on each request', async () => {
    // Acceptance: last_activity updated after request
  });

  it('should clear invalid/expired session cookie', async () => {
    // Request: Expired session cookie
    // Acceptance: Response clears cookie, creates new session
  });
});
```

### E2E Test Flows

#### Flow 1: Multi-Account Login
```
1. User visits client app (no session)
2. Redirected to auth → shows login form
3. Logs in as User A → back to client
4. User visits client app with different account
5. Click "Use another account" → back to auth
6. Logs in as User B → back to client (2 accounts)
7. Repeat for User C → back to client (3 accounts)
8. Attempt User D → redirect to account picker (max_reached mode)
9. Sign out User A → redirect to login
10. Log in as User D → success (3 accounts: B, C, D)

Acceptance Criteria:
- All 4 login flows complete successfully
- Account picker shows at step 8, not error
- After step 10, can switch between B, C, D
```

#### Flow 2: Cross-Device Sessions
```
1. User logs in on Desktop Chrome
2. User logs in on Mobile Safari (same user)
3. Check /session/devices → shows 2 devices
4. Revoke Desktop Chrome session
5. Desktop Chrome makes request → session invalid
6. Mobile Safari still works

Acceptance Criteria:
- getUserSessions returns 2 sessions with correct device info
- Revoking one doesn't affect other
- IP addresses correctly tracked per session
```

#### Flow 3: Session Expiration
```
1. User logs in → session created
2. Wait 7 days (or mock time)
3. User makes request → session expired
4. User must log in again

Acceptance Criteria:
- Expired sessions not returned by queries
- Cleanup job removes expired sessions
- User gets clear UX for expired session
```

### Coverage Requirements

| Component | Target Coverage |
|-----------|----------------|
| BrowserSessionService | >90% |
| AccountSessionService | >90% |
| parseUserAgent | 100% |
| session-cookie utils | 100% |
| hashToken | 100% |
| Session middleware | >80% |

**Overall Lane 1 Coverage Target: >85%**

---

## Rollout Checklist

- [ ] Create migration 0023_browser_sessions.sql
- [ ] Create migration 0024_account_sessions_trigger.sql
- [ ] Apply migrations locally
- [ ] Implement BrowserSessionService
- [ ] Implement AccountSessionService
- [ ] Add user-agent parser utility
- [ ] Add crypto utilities
- [ ] Add session cookie utilities
- [ ] Write unit tests (>80% coverage)
- [ ] Integrate session middleware
- [ ] Update OpenAuth integration to use new sessions
- [ ] Add audit events for session operations
- [ ] Test with multiple accounts
- [ ] Apply migrations to QA
- [ ] E2E test multi-account flows

---

## Estimated Effort
- Database migrations: 1-2 hours
- Service implementations: 4-6 hours
- Utility functions: 2 hours
- Integration: 4-6 hours
- Testing: 4-6 hours
- **Total: 15-22 hours**

## Dependencies on OpenAuth 1.0.1
- Need to integrate with OpenAuth's subject callback
- Need to hook into authorize endpoint for session creation
- Need to modify token generation to include session context
