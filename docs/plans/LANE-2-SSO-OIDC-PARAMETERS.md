# Lane 2: SSO & OIDC Parameter Handling

## Overview
Implement OpenID Connect parameter handling for SSO flows including `prompt`, `login_hint`, `account_hint`, `max_age`, and `acr_values`. Enable silent authentication and cross-app SSO.

## Priority: P0 (Critical)
**Dependencies**: Lane 1 (Browser Sessions)
**Blocks**: Lane 3 (Session Management APIs)

---

## Current State Analysis

### What Exists:
- Basic OAuth 2.0 authorize endpoint via OpenAuth
- Standard authorization code flow
- Basic state parameter handling

### What's Missing:
- `prompt` parameter handling (none, login, consent, select_account)
- `login_hint` parameter for pre-filling email
- `account_hint` parameter for selecting specific account
- `max_age` parameter for forced re-auth
- `acr_values` for MFA requirements
- Silent authentication flow
- Cross-app SSO without re-login

---

## OIDC Parameter Specifications

### prompt Parameter

| Value | Behavior |
|-------|----------|
| `none` | Silent auth - return error if no session, never show UI |
| `login` | Force login UI even if session exists |
| `consent` | Force consent UI (future use) |
| `select_account` | Show account picker if multiple accounts |

### Error Responses for prompt=none

| Condition | Error Code | Description |
|-----------|------------|-------------|
| No session | `login_required` | User needs to authenticate |
| Session expired | `login_required` | Session has expired |
| Consent needed | `consent_required` | User consent required (future) |
| Account selection needed | `account_selection_required` | Multiple accounts, selection required |
| Interaction needed | `interaction_required` | Generic interaction required |

---

## Implementation

### File: apps/auth/src/types/oidc.ts

```typescript
export type PromptValue = 'none' | 'login' | 'consent' | 'select_account';

export interface OIDCAuthorizeParams {
  // Standard OAuth 2.0
  client_id: string;
  redirect_uri: string;
  response_type: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: 'S256' | 'plain';

  // OIDC Extensions
  prompt?: PromptValue;
  login_hint?: string;
  account_hint?: string; // User ID hint for specific account
  max_age?: number; // Max auth age in seconds
  acr_values?: string; // Space-separated ACR values
  nonce?: string;

  // Custom Extensions
  action?: 'add_account'; // Force add account flow
  ui_locales?: string;
}

export interface OIDCError {
  error: string;
  error_description?: string;
  state?: string;
}

export const OIDC_ERRORS = {
  LOGIN_REQUIRED: 'login_required',
  CONSENT_REQUIRED: 'consent_required',
  ACCOUNT_SELECTION_REQUIRED: 'account_selection_required',
  INTERACTION_REQUIRED: 'interaction_required',
  INVALID_REQUEST: 'invalid_request',
  UNAUTHORIZED_CLIENT: 'unauthorized_client',
  ACCESS_DENIED: 'access_denied',
  SERVER_ERROR: 'server_error',
} as const;

export interface AuthorizationDecision {
  shouldShowUI: boolean;
  uiType?: 'login' | 'select_account' | 'consent' | 'mfa';
  error?: OIDCError;
  selectedAccount?: AccountSession;
  prefilledEmail?: string;
}
```

### File: apps/auth/src/services/oidc-authorize.service.ts

```typescript
import type { OIDCAuthorizeParams, AuthorizationDecision, OIDCError, OIDC_ERRORS } from '../types/oidc';
import type { BrowserSession, AccountSession } from '../types/sessions';
import { BrowserSessionService } from './browser-session.service';
import { AccountSessionService } from './account-session.service';

export class OIDCAuthorizeService {
  constructor(
    private browserSessionService: BrowserSessionService,
    private accountSessionService: AccountSessionService,
    private db: D1Database
  ) {}

  /**
   * Process authorize request and determine next action
   */
  async processAuthorizeRequest(
    params: OIDCAuthorizeParams,
    browserSession: BrowserSession | null,
    activeAccount: AccountSession | null,
    allAccounts: AccountSession[]
  ): Promise<AuthorizationDecision> {
    const { prompt, login_hint, account_hint, max_age, action } = params;

    // Handle add_account action
    if (action === 'add_account') {
      return {
        shouldShowUI: true,
        uiType: 'login',
        prefilledEmail: login_hint,
      };
    }

    // Handle prompt=none (silent authentication)
    if (prompt === 'none') {
      return this.handleSilentAuth(browserSession, activeAccount, allAccounts, account_hint, max_age);
    }

    // Handle prompt=login (force login)
    if (prompt === 'login') {
      return {
        shouldShowUI: true,
        uiType: 'login',
        prefilledEmail: login_hint,
      };
    }

    // Handle prompt=select_account
    if (prompt === 'select_account') {
      if (allAccounts.length === 0) {
        return {
          shouldShowUI: true,
          uiType: 'login',
          prefilledEmail: login_hint,
        };
      }
      return {
        shouldShowUI: true,
        uiType: 'select_account',
      };
    }

    // Default behavior: Use existing session if valid
    if (browserSession && activeAccount) {
      // Check max_age
      if (max_age !== undefined) {
        const authAge = this.getAuthAgeSeconds(activeAccount.authenticatedAt);
        if (authAge > max_age) {
          return {
            shouldShowUI: true,
            uiType: 'login',
            prefilledEmail: login_hint,
          };
        }
      }

      // Check if specific account is requested
      if (account_hint) {
        const targetAccount = allAccounts.find(a => a.userId === account_hint);
        if (targetAccount) {
          return {
            shouldShowUI: false,
            selectedAccount: targetAccount,
          };
        }
        // Account hint doesn't match any logged-in account
        return {
          shouldShowUI: true,
          uiType: 'login',
          prefilledEmail: login_hint,
        };
      }

      // Use active account
      return {
        shouldShowUI: false,
        selectedAccount: activeAccount,
      };
    }

    // No session - show login
    return {
      shouldShowUI: true,
      uiType: 'login',
      prefilledEmail: login_hint,
    };
  }

  /**
   * Handle silent authentication (prompt=none)
   */
  private handleSilentAuth(
    browserSession: BrowserSession | null,
    activeAccount: AccountSession | null,
    allAccounts: AccountSession[],
    accountHint?: string,
    maxAge?: number
  ): AuthorizationDecision {
    // No browser session
    if (!browserSession) {
      return {
        shouldShowUI: false,
        error: {
          error: OIDC_ERRORS.LOGIN_REQUIRED,
          error_description: 'No active session found',
        },
      };
    }

    // No accounts in session
    if (allAccounts.length === 0) {
      return {
        shouldShowUI: false,
        error: {
          error: OIDC_ERRORS.LOGIN_REQUIRED,
          error_description: 'No accounts in session',
        },
      };
    }

    // Account hint provided - find specific account
    if (accountHint) {
      const targetAccount = allAccounts.find(a => a.userId === accountHint);
      if (!targetAccount) {
        return {
          shouldShowUI: false,
          error: {
            error: OIDC_ERRORS.LOGIN_REQUIRED,
            error_description: 'Requested account not found in session',
          },
        };
      }

      // Check max_age for target account
      if (maxAge !== undefined) {
        const authAge = this.getAuthAgeSeconds(targetAccount.authenticatedAt);
        if (authAge > maxAge) {
          return {
            shouldShowUI: false,
            error: {
              error: OIDC_ERRORS.LOGIN_REQUIRED,
              error_description: 'Session too old, re-authentication required',
            },
          };
        }
      }

      return {
        shouldShowUI: false,
        selectedAccount: targetAccount,
      };
    }

    // Use active account
    if (!activeAccount) {
      // Multiple accounts but none active - needs selection
      if (allAccounts.length > 1) {
        return {
          shouldShowUI: false,
          error: {
            error: OIDC_ERRORS.ACCOUNT_SELECTION_REQUIRED,
            error_description: 'Multiple accounts available, selection required',
          },
        };
      }
      // Single account - use it
      activeAccount = allAccounts[0];
    }

    // Check max_age
    if (maxAge !== undefined) {
      const authAge = this.getAuthAgeSeconds(activeAccount.authenticatedAt);
      if (authAge > maxAge) {
        return {
          shouldShowUI: false,
          error: {
            error: OIDC_ERRORS.LOGIN_REQUIRED,
            error_description: 'Session too old, re-authentication required',
          },
        };
      }
    }

    return {
      shouldShowUI: false,
      selectedAccount: activeAccount,
    };
  }

  /**
   * Build error redirect URL
   */
  buildErrorRedirect(redirectUri: string, error: OIDCError, state?: string): string {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error.error);
    if (error.error_description) {
      url.searchParams.set('error_description', error.error_description);
    }
    if (state) {
      url.searchParams.set('state', state);
    }
    return url.toString();
  }

  /**
   * Calculate authentication age in seconds
   */
  private getAuthAgeSeconds(authenticatedAt: string): number {
    const authTime = new Date(authenticatedAt).getTime();
    const now = Date.now();
    return Math.floor((now - authTime) / 1000);
  }
}
```

### File: apps/auth/src/routes/authorize.ts

```typescript
import { Hono } from 'hono';
import { OIDCAuthorizeService } from '../services/oidc-authorize.service';
import { BrowserSessionService } from '../services/browser-session.service';
import { AccountSessionService } from '../services/account-session.service';
import { validateClient } from '../middleware/client-validation';
import type { OIDCAuthorizeParams } from '../types/oidc';
import type { Env } from '../types/env';

const authorizeRoute = new Hono<{ Bindings: Env }>();

authorizeRoute.get('/', async (c) => {
  // Parse OIDC parameters
  const params: OIDCAuthorizeParams = {
    client_id: c.req.query('client_id') || '',
    redirect_uri: c.req.query('redirect_uri') || '',
    response_type: c.req.query('response_type') || 'code',
    scope: c.req.query('scope'),
    state: c.req.query('state'),
    code_challenge: c.req.query('code_challenge'),
    code_challenge_method: c.req.query('code_challenge_method') as 'S256' | 'plain',
    prompt: c.req.query('prompt') as any,
    login_hint: c.req.query('login_hint'),
    account_hint: c.req.query('account_hint'),
    max_age: c.req.query('max_age') ? parseInt(c.req.query('max_age')!) : undefined,
    acr_values: c.req.query('acr_values'),
    nonce: c.req.query('nonce'),
    action: c.req.query('action') as any,
  };

  // Validate client and redirect_uri first (before any redirects)
  const clientValidation = await validateClient(c.env.AUTH_DB, params.client_id, params.redirect_uri);
  if (!clientValidation.valid) {
    // Don't redirect for invalid client - show error page
    return c.html(`
      <html>
        <body>
          <h1>Authorization Error</h1>
          <p>${clientValidation.error}</p>
        </body>
      </html>
    `, 400);
  }

  // Get session context
  const browserSession = c.get('browserSession');
  const activeAccount = c.get('activeAccount');

  let allAccounts: any[] = [];
  if (browserSession) {
    const browserSessionService = new BrowserSessionService(c.env.AUTH_DB);
    const sessionWithAccounts = await browserSessionService.getBrowserSessionWithAccounts(browserSession.id);
    allAccounts = sessionWithAccounts?.accounts || [];
  }

  // Process authorization request
  const oidcService = new OIDCAuthorizeService(
    new BrowserSessionService(c.env.AUTH_DB),
    new AccountSessionService(c.env.AUTH_DB),
    c.env.AUTH_DB
  );

  const decision = await oidcService.processAuthorizeRequest(
    params,
    browserSession,
    activeAccount,
    allAccounts
  );

  // Handle error response (for prompt=none)
  if (decision.error) {
    const errorUrl = oidcService.buildErrorRedirect(
      params.redirect_uri,
      decision.error,
      params.state
    );
    return c.redirect(errorUrl);
  }

  // Silent auth success - generate code and redirect
  if (!decision.shouldShowUI && decision.selectedAccount) {
    // Switch active account if needed
    if (decision.selectedAccount.id !== activeAccount?.id) {
      const accountService = new AccountSessionService(c.env.AUTH_DB);
      await accountService.setActiveAccount(browserSession!.id, decision.selectedAccount.id);
    }

    // Generate authorization code via OpenAuth
    // This integrates with OpenAuth's code generation
    const code = await generateAuthorizationCode(c.env, {
      clientId: params.client_id,
      userId: decision.selectedAccount.userId,
      redirectUri: params.redirect_uri,
      scope: params.scope,
      codeChallenge: params.code_challenge,
      codeChallengeMethod: params.code_challenge_method,
      nonce: params.nonce,
    });

    const redirectUrl = new URL(params.redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (params.state) {
      redirectUrl.searchParams.set('state', params.state);
    }

    return c.redirect(redirectUrl.toString());
  }

  // Show UI (login or account selector)
  if (decision.uiType === 'select_account') {
    // Redirect to account selector with accounts data
    const selectorUrl = new URL('/select-account', c.req.url);
    selectorUrl.searchParams.set('client_id', params.client_id);
    selectorUrl.searchParams.set('redirect_uri', params.redirect_uri);
    selectorUrl.searchParams.set('state', params.state || '');
    selectorUrl.searchParams.set('scope', params.scope || '');
    if (params.code_challenge) {
      selectorUrl.searchParams.set('code_challenge', params.code_challenge);
      selectorUrl.searchParams.set('code_challenge_method', params.code_challenge_method || 'S256');
    }
    return c.redirect(selectorUrl.toString());
  }

  // Show login UI - pass to OpenAuth
  // Store OIDC params in session/KV for post-login processing
  const loginParams = new URLSearchParams();
  loginParams.set('client_id', params.client_id);
  loginParams.set('redirect_uri', params.redirect_uri);
  if (params.state) loginParams.set('state', params.state);
  if (params.scope) loginParams.set('scope', params.scope);
  if (params.code_challenge) {
    loginParams.set('code_challenge', params.code_challenge);
    loginParams.set('code_challenge_method', params.code_challenge_method || 'S256');
  }
  if (decision.prefilledEmail) {
    loginParams.set('login_hint', decision.prefilledEmail);
  }
  if (params.action === 'add_account') {
    loginParams.set('action', 'add_account');
  }

  // Redirect to OpenAuth's authorize
  return c.redirect(`/authorize/email?${loginParams.toString()}`);
});

export default authorizeRoute;
```

---

## Account Selector UI

### File: apps/auth/src/ui/select-account.tsx

```tsx
// Server-rendered account selector component
export interface AccountSelectorProps {
  accounts: Array<{
    userId: string;
    email: string;
    name?: string;
    avatarUrl?: string;
    lastUsed: string;
    isActive: boolean;
  }>;
  clientId: string;
  clientName: string;
  redirectUri: string;
  state?: string;
  allowAddAccount: boolean;
}

export function renderAccountSelector(props: AccountSelectorProps): string {
  const { accounts, clientId, clientName, allowAddAccount } = props;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Choose an account</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      max-width: 400px;
      width: 100%;
      overflow: hidden;
    }
    .header {
      padding: 24px;
      text-align: center;
      border-bottom: 1px solid #eee;
    }
    .header h1 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .header p {
      color: #666;
      font-size: 14px;
    }
    .accounts {
      padding: 8px 0;
    }
    .account {
      display: flex;
      align-items: center;
      padding: 16px 24px;
      cursor: pointer;
      transition: background 0.2s;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
    }
    .account:hover {
      background: #f5f5f5;
    }
    .account.active {
      background: #e8f5e9;
    }
    .avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: #1976d2;
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      margin-right: 16px;
      flex-shrink: 0;
    }
    .account-info {
      flex: 1;
      min-width: 0;
    }
    .account-email {
      font-weight: 500;
      color: #333;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .account-status {
      font-size: 12px;
      color: #666;
      margin-top: 2px;
    }
    .add-account {
      display: flex;
      align-items: center;
      padding: 16px 24px;
      cursor: pointer;
      transition: background 0.2s;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
      border-top: 1px solid #eee;
    }
    .add-account:hover {
      background: #f5f5f5;
    }
    .add-icon {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: #f5f5f5;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-right: 16px;
      font-size: 24px;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Choose an account</h1>
      <p>to continue to ${escapeHtml(clientName)}</p>
    </div>
    <div class="accounts">
      ${accounts.map(account => `
        <form method="POST" action="/select-account">
          <input type="hidden" name="user_id" value="${account.userId}">
          <input type="hidden" name="client_id" value="${clientId}">
          <input type="hidden" name="redirect_uri" value="${props.redirectUri}">
          <input type="hidden" name="state" value="${props.state || ''}">
          <button type="submit" class="account ${account.isActive ? 'active' : ''}">
            <div class="avatar">${getInitials(account.email)}</div>
            <div class="account-info">
              <div class="account-email">${escapeHtml(account.email)}</div>
              <div class="account-status">${account.isActive ? 'Active' : 'Signed in'}</div>
            </div>
          </button>
        </form>
      `).join('')}
      ${allowAddAccount ? `
        <form method="GET" action="/authorize">
          <input type="hidden" name="client_id" value="${clientId}">
          <input type="hidden" name="redirect_uri" value="${props.redirectUri}">
          <input type="hidden" name="state" value="${props.state || ''}">
          <input type="hidden" name="action" value="add_account">
          <input type="hidden" name="prompt" value="login">
          <button type="submit" class="add-account">
            <div class="add-icon">+</div>
            <div class="account-info">
              <div class="account-email">Use another account</div>
            </div>
          </button>
        </form>
      ` : ''}
    </div>
  </div>
</body>
</html>
  `;
}

function getInitials(email: string): string {
  return email.charAt(0).toUpperCase();
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
```

---

## OpenAuth Integration

### File: apps/auth/src/openauth-config.ts (modifications)

```typescript
// Add to OpenAuth configuration to integrate with OIDC parameters

import { authorizer } from '@meywd/openauth';

export function createAuthorizer(env: Env) {
  return authorizer({
    // ... existing config ...

    // Custom authorize handler to support OIDC params
    authorize: {
      // Before showing login UI
      beforeUI: async (ctx) => {
        const { request, client } = ctx;
        const url = new URL(request.url);

        // Pass login_hint to UI
        const loginHint = url.searchParams.get('login_hint');
        if (loginHint) {
          ctx.set('loginHint', loginHint);
        }

        // Track if this is add_account flow
        const action = url.searchParams.get('action');
        if (action === 'add_account') {
          ctx.set('isAddAccount', true);
        }
      },

      // After successful authentication
      afterAuth: async (ctx, userId) => {
        const { request, env } = ctx;
        const browserSession = ctx.get('browserSession');
        const isAddAccount = ctx.get('isAddAccount');

        const browserSessionService = new BrowserSessionService(env.AUTH_DB);
        const accountSessionService = new AccountSessionService(env.AUTH_DB);

        let currentBrowserSession = browserSession;

        // Create browser session if doesn't exist
        if (!currentBrowserSession) {
          const { session, token } = await browserSessionService.createBrowserSession({
            userAgent: request.headers.get('User-Agent') || '',
            ipAddress: request.headers.get('CF-Connecting-IP') || '',
          });
          currentBrowserSession = session;

          // Set session cookie
          ctx.setCookie(SESSION_COOKIE_NAME, token, SESSION_COOKIE_DEFAULTS);
        }

        // Add account to browser session
        await accountSessionService.addAccountToSession({
          browserSessionId: currentBrowserSession.id,
          userId,
          authMethod: 'email',
          setActive: true,
        });

        return { browserSessionId: currentBrowserSession.id };
      },
    },
  });
}
```

---

## Testing Requirements

### Unit Tests

#### File: apps/auth/src/services/__tests__/oidc-authorize.service.test.ts

```typescript
describe('OIDCAuthorizeService', () => {
  describe('processAuthorizeRequest', () => {
    describe('prompt=none (Silent Authentication)', () => {
      it('should return selectedAccount when valid session exists', async () => {
        // Setup: Browser session with active account
        // Acceptance: { shouldShowUI: false, selectedAccount: AccountSession }
      });

      it('should return login_required error when no browser session', async () => {
        // Setup: No cookie/session
        // Acceptance: { error: { error: 'login_required', error_description: 'No active session found' } }
      });

      it('should return login_required error when no accounts in session', async () => {
        // Setup: Browser session exists but empty accounts array
        // Acceptance: { error: { error: 'login_required', error_description: 'No accounts in session' } }
      });

      it('should return login_required error when session expired', async () => {
        // Setup: Session with past expiresAt
        // Acceptance: { error: { error: 'login_required' } }
      });

      it('should return account_selection_required when multiple accounts no active', async () => {
        // Setup: 3 accounts, none marked active
        // Acceptance: { error: { error: 'account_selection_required' } }
      });

      it('should select single account when only one exists (no active)', async () => {
        // Setup: 1 account, not marked active
        // Acceptance: { selectedAccount: thatAccount }
      });

      it('should use account_hint to select specific account', async () => {
        // Setup: 3 accounts, account_hint = user2
        // Acceptance: { selectedAccount: user2's AccountSession }
      });

      it('should return login_required when account_hint user not in session', async () => {
        // Setup: account_hint = nonExistentUser
        // Acceptance: { error: { error: 'login_required', error_description: 'Requested account not found' } }
      });

      it('should return login_required when max_age exceeded', async () => {
        // Setup: Account authenticated 2 hours ago, max_age=3600 (1 hour)
        // Acceptance: { error: { error: 'login_required', error_description: 'Session too old' } }
      });

      it('should pass when max_age not exceeded', async () => {
        // Setup: Account authenticated 30 min ago, max_age=3600
        // Acceptance: { shouldShowUI: false, selectedAccount }
      });
    });

    describe('prompt=login', () => {
      it('should force login UI even with valid session', async () => {
        // Setup: Valid active session
        // Acceptance: { shouldShowUI: true, uiType: 'login' }
      });

      it('should include login_hint in prefilledEmail', async () => {
        // Setup: prompt=login, login_hint=user@example.com
        // Acceptance: { prefilledEmail: 'user@example.com' }
      });

      it('should show login UI for new browser (no session)', async () => {
        // Acceptance: { shouldShowUI: true, uiType: 'login' }
      });
    });

    describe('prompt=select_account', () => {
      it('should show account picker when multiple accounts exist', async () => {
        // Setup: 3 accounts logged in
        // Acceptance: { shouldShowUI: true, uiType: 'select_account' }
      });

      it('should fallback to login when no accounts exist', async () => {
        // Setup: Empty accounts array
        // Acceptance: { shouldShowUI: true, uiType: 'login' }
      });

      it('should include login_hint as prefilledEmail when no accounts', async () => {
        // Setup: prompt=select_account, login_hint=user@example.com, no accounts
        // Acceptance: { uiType: 'login', prefilledEmail: 'user@example.com' }
      });
    });

    describe('prompt=consent', () => {
      it('should show consent UI (future implementation)', async () => {
        // Acceptance: { shouldShowUI: true, uiType: 'consent' }
      });
    });

    describe('Default behavior (no prompt)', () => {
      it('should use active account silently when valid', async () => {
        // Setup: Valid active account
        // Acceptance: { shouldShowUI: false, selectedAccount: activeAccount }
      });

      it('should check max_age even without explicit prompt', async () => {
        // Setup: max_age=60, authenticated 2 min ago
        // Acceptance: { shouldShowUI: true, uiType: 'login' }
      });

      it('should use account_hint to select non-active account', async () => {
        // Setup: 3 accounts, user1 active, account_hint=user2
        // Acceptance: { selectedAccount: user2 }
      });

      it('should show login when account_hint doesnt match any account', async () => {
        // Setup: account_hint = unknownUser
        // Acceptance: { shouldShowUI: true, uiType: 'login' }
      });

      it('should show login when no session exists', async () => {
        // Acceptance: { shouldShowUI: true, uiType: 'login' }
      });
    });

    describe('action=add_account', () => {
      it('should always show login UI', async () => {
        // Setup: Valid session exists
        // Acceptance: { shouldShowUI: true, uiType: 'login' }
      });

      it('should include login_hint', async () => {
        // Setup: action=add_account, login_hint=new@example.com
        // Acceptance: { prefilledEmail: 'new@example.com' }
      });
    });
  });

  describe('buildErrorRedirect', () => {
    it('should construct valid error redirect URL', async () => {
      // Input: redirectUri, error, state
      // Acceptance: URL contains error, error_description, state params
    });

    it('should preserve state parameter', async () => {
      // Acceptance: state echoed back unchanged
    });

    it('should URL-encode error_description', async () => {
      // Acceptance: Spaces and special chars encoded
    });
  });

  describe('getAuthAgeSeconds', () => {
    it('should calculate correct age in seconds', async () => {
      // Setup: authenticatedAt = 1 hour ago
      // Acceptance: Returns ~3600
    });

    it('should handle ISO date strings', async () => {
      // Acceptance: Parses ISO 8601 format correctly
    });
  });
});
```

### Authorize Route Tests

```typescript
describe('Authorize Route', () => {
  describe('GET /authorize', () => {
    it('should validate client_id exists', async () => {
      // Setup: Non-existent client_id
      // Acceptance: HTML error page (not redirect), status 400
    });

    it('should validate redirect_uri matches client registration', async () => {
      // Setup: redirect_uri not in client.redirect_uris
      // Acceptance: HTML error page, not redirect to attacker URL
    });

    it('should redirect to account-picker for select_account', async () => {
      // Acceptance: Redirect to /select-account with OAuth params preserved
    });

    it('should redirect to OpenAuth for login flow', async () => {
      // Acceptance: Redirect to /authorize/email with params
    });

    it('should generate code and redirect for silent auth success', async () => {
      // Setup: prompt=none, valid session
      // Acceptance: Redirect to redirect_uri with code and state
    });

    it('should redirect with error for silent auth failure', async () => {
      // Setup: prompt=none, no session
      // Acceptance: Redirect to redirect_uri with error=login_required
    });

    it('should switch active account when using account_hint', async () => {
      // Setup: account_hint different from current active
      // Acceptance: accountSessionService.setActiveAccount called
    });

    it('should preserve all OAuth params through the flow', async () => {
      // Params: client_id, redirect_uri, state, scope, code_challenge, nonce
      // Acceptance: All params present in redirect/login URL
    });
  });

  describe('Account Selector Route', () => {
    describe('GET /select-account', () => {
      it('should render account list from session', async () => {
        // Acceptance: HTML contains all account emails
      });

      it('should redirect to login if no session', async () => {
        // Acceptance: Redirect to /login with OAuth params
      });

      it('should show "Use another account" when under max', async () => {
        // Setup: 2 accounts
        // Acceptance: Add account button visible
      });

      it('should hide "Use another account" when at max', async () => {
        // Setup: 3 accounts
        // Acceptance: Add account button not present
      });
    });

    describe('POST /select-account', () => {
      it('should set selected account as active', async () => {
        // Acceptance: setActiveAccountByUserId called
      });

      it('should redirect back to authorize with account_hint', async () => {
        // Acceptance: Redirect to /authorize?account_hint=userId
      });

      it('should preserve OAuth params', async () => {
        // Acceptance: All params from form preserved in redirect
      });
    });
  });
});
```

### Account Selector UI Tests

```typescript
describe('Account Selector UI', () => {
  describe('renderAccountSelector', () => {
    it('should display all accounts with emails', async () => {
      // Acceptance: Each account.email rendered
    });

    it('should show active badge for active account', async () => {
      // Acceptance: 'Active' badge on isActive=true account
    });

    it('should show last used time for inactive accounts', async () => {
      // Acceptance: 'Signed in' status for non-active
    });

    it('should include hidden form fields for OAuth params', async () => {
      // Acceptance: client_id, redirect_uri, state in each form
    });

    it('should show "Use another account" when allowAddAccount=true', async () => {
      // Acceptance: Add account form present
    });

    it('should escape HTML in client name', async () => {
      // Setup: clientName = '<script>alert(1)</script>'
      // Acceptance: Rendered as text, not executed
    });

    it('should escape HTML in email addresses', async () => {
      // Acceptance: No XSS from malicious email
    });
  });

  describe('getInitials', () => {
    it('should return uppercase first letter', async () => {
      // Input: 'user@example.com'
      // Output: 'U'
    });
  });

  describe('escapeHtml', () => {
    it('should escape <, >, &, and quotes', async () => {
      // Acceptance: All special chars escaped
    });
  });
});
```

### OpenAuth Integration Tests

```typescript
describe('OpenAuth Integration', () => {
  describe('beforeUI hook', () => {
    it('should pass login_hint to context', async () => {
      // Acceptance: ctx.get('loginHint') returns login_hint value
    });

    it('should set isAddAccount flag from action param', async () => {
      // Setup: action=add_account
      // Acceptance: ctx.get('isAddAccount') = true
    });
  });

  describe('afterAuth hook', () => {
    it('should create browser session if none exists', async () => {
      // Acceptance: browserSessionService.createBrowserSession called
    });

    it('should set session cookie after creating session', async () => {
      // Acceptance: ctx.setCookie called with session token
    });

    it('should add account to existing browser session', async () => {
      // Setup: Browser session exists
      // Acceptance: addAccountToSession called, not createBrowserSession
    });

    it('should set new account as active', async () => {
      // Acceptance: addAccountToSession called with setActive: true
    });

    it('should extract auth method from context', async () => {
      // Acceptance: authMethod passed to addAccountToSession
    });
  });
});
```

### E2E Tests

```typescript
test.describe('SSO Flows E2E', () => {
  test.describe('Silent Authentication (prompt=none)', () => {
    test('succeeds with valid session', async ({ page }) => {
      // Login to App A first
      await loginToApp(page, 'app-a');

      // Silent auth to App B
      await page.goto('/authorize?client_id=app-b&prompt=none&redirect_uri=http://localhost:3001/callback');

      // Should redirect with code (not error)
      await page.waitForURL(/code=/);
      expect(page.url()).toContain('code=');
      expect(page.url()).not.toContain('error=');
    });

    test('fails with login_required when no session', async ({ page }) => {
      await page.goto('/authorize?client_id=app-a&prompt=none&redirect_uri=http://localhost:3000/callback&state=test123');

      await page.waitForURL(/error=/);
      expect(page.url()).toContain('error=login_required');
      expect(page.url()).toContain('state=test123');
    });

    test('uses account_hint to select specific account', async ({ page }) => {
      await loginToApp(page, 'app-a', 'user1@test.com');
      await addAccount(page, 'user2@test.com');

      // Silent auth with account_hint for user1
      await page.goto(`/authorize?client_id=app-a&prompt=none&account_hint=${user1Id}&redirect_uri=...`);

      // Should succeed with user1's context
      await page.waitForURL(/code=/);
      // Token should be for user1
    });

    test('fails with login_required when max_age exceeded', async ({ page }) => {
      await loginToApp(page, 'app-a');

      // Wait or mock time to exceed max_age
      // In test, we can use a very short max_age with already-old session

      await page.goto('/authorize?client_id=app-a&prompt=none&max_age=1&redirect_uri=...');

      await page.waitForURL(/error=/);
      expect(page.url()).toContain('error=login_required');
    });

    test('returns account_selection_required with multiple accounts no active', async ({ page }) => {
      // Setup: Multiple accounts, none active (edge case)
      await page.goto('/authorize?client_id=app-a&prompt=none&redirect_uri=...');

      await page.waitForURL(/error=/);
      expect(page.url()).toContain('error=account_selection_required');
    });
  });

  test.describe('Account Selection (prompt=select_account)', () => {
    test('shows all logged-in accounts', async ({ page }) => {
      await loginToApp(page, 'app-a', 'user1@test.com');
      await addAccount(page, 'user2@test.com');
      await addAccount(page, 'user3@test.com');

      await page.goto('/authorize?client_id=app-a&prompt=select_account&redirect_uri=...');

      await expect(page.getByText('user1@test.com')).toBeVisible();
      await expect(page.getByText('user2@test.com')).toBeVisible();
      await expect(page.getByText('user3@test.com')).toBeVisible();
      await expect(page.getByText('Choose an account')).toBeVisible();
    });

    test('selecting account continues OAuth flow', async ({ page }) => {
      await loginToApp(page, 'app-a', 'user1@test.com');
      await addAccount(page, 'user2@test.com');

      await page.goto('/authorize?client_id=app-a&prompt=select_account&redirect_uri=...');

      // Click user1
      await page.click('text=user1@test.com');

      // Should complete OAuth and redirect with code
      await page.waitForURL(/code=/);
    });

    test('"Use another account" redirects to login', async ({ page }) => {
      await loginToApp(page, 'app-a', 'user1@test.com');

      await page.goto('/authorize?client_id=app-a&prompt=select_account&redirect_uri=...');

      await page.click('text=Use another account');

      // Should show login form
      await expect(page.getByPlaceholder(/email/i)).toBeVisible();
    });

    test('shows login form when no accounts', async ({ page }) => {
      await page.goto('/authorize?client_id=app-a&prompt=select_account&redirect_uri=...');

      // Should redirect to login, not show empty selector
      await expect(page.getByPlaceholder(/email/i)).toBeVisible();
    });
  });

  test.describe('Forced Login (prompt=login)', () => {
    test('shows login even with valid session', async ({ page }) => {
      await loginToApp(page, 'app-a', 'user1@test.com');

      await page.goto('/authorize?client_id=app-a&prompt=login&redirect_uri=...');

      // Should show login form, not auto-complete
      await expect(page.getByPlaceholder(/email/i)).toBeVisible();
    });

    test('pre-fills email from login_hint', async ({ page }) => {
      await page.goto('/authorize?client_id=app-a&prompt=login&login_hint=prefilled@test.com&redirect_uri=...');

      const emailInput = page.getByPlaceholder(/email/i);
      await expect(emailInput).toHaveValue('prefilled@test.com');
    });

    test('new login becomes active account', async ({ page }) => {
      await loginToApp(page, 'app-a', 'user1@test.com');

      await page.goto('/authorize?client_id=app-a&prompt=login&redirect_uri=...');
      await loginAs(page, 'user2@test.com');

      // user2 should now be active
      const check = await page.request.get('/session/check');
      const session = await check.json();
      expect(session.session.email).toBe('user2@test.com');
    });
  });

  test.describe('Cross-App SSO', () => {
    test('user logged into App A can silently auth to App B', async ({ page }) => {
      await loginToApp(page, 'app-a', 'user@test.com');

      await page.goto('/authorize?client_id=app-b&prompt=none&redirect_uri=http://app-b.local/callback');

      await page.waitForURL(/code=/);
      expect(page.url()).toContain('code=');
    });

    test('different apps get different tokens (audience)', async ({ page, request }) => {
      await loginToApp(page, 'app-a', 'user@test.com');

      // Get token for app-a
      const tokenA = await getTokenForCurrentSession(page, 'app-a');

      // SSO to app-b
      await page.goto('/authorize?client_id=app-b&prompt=none&redirect_uri=...');
      const tokenB = await getTokenForCurrentSession(page, 'app-b');

      // Tokens should have different audiences
      const decodedA = decodeJwt(tokenA);
      const decodedB = decodeJwt(tokenB);

      expect(decodedA.aud).toBe('app-a');
      expect(decodedB.aud).toBe('app-b');
      expect(decodedA.sub).toBe(decodedB.sub); // Same user
    });
  });

  test.describe('Max Age Enforcement', () => {
    test('triggers re-auth when max_age exceeded', async ({ page }) => {
      await loginToApp(page, 'app-a');

      // With max_age=0, any session is "too old"
      await page.goto('/authorize?client_id=app-a&max_age=0&redirect_uri=...');

      // Should show login form
      await expect(page.getByPlaceholder(/email/i)).toBeVisible();
    });

    test('silent auth fails when max_age exceeded', async ({ page }) => {
      await loginToApp(page, 'app-a');

      await page.goto('/authorize?client_id=app-a&prompt=none&max_age=0&redirect_uri=...');

      await page.waitForURL(/error=/);
      expect(page.url()).toContain('error=login_required');
    });
  });
});
```

### Coverage Requirements

| Component | Target Coverage |
|-----------|----------------|
| OIDCAuthorizeService | >90% |
| Authorize Route | >90% |
| Account Selector | >80% |
| OpenAuth Integration | >80% |
| Error Handling | 100% |

**Overall Lane 2 Coverage Target: >85%**

**Critical Path Coverage**: The following must have 100% coverage:
- prompt=none error responses
- Client validation (security)
- State parameter handling
- redirect_uri validation

---

## Rollout Checklist

- [ ] Implement OIDCAuthorizeParams type
- [ ] Implement OIDCAuthorizeService
- [ ] Create authorize route with OIDC handling
- [ ] Build account selector UI
- [ ] Integrate with OpenAuth beforeUI/afterAuth hooks
- [ ] Add client validation middleware
- [ ] Write unit tests for all prompt values
- [ ] Write E2E tests for SSO flows
- [ ] Test cross-app SSO scenarios
- [ ] Test error responses for prompt=none
- [ ] Test max_age enforcement
- [ ] Test login_hint pre-filling
- [ ] Document API changes

---

## Estimated Effort
- Types and interfaces: 1-2 hours
- OIDCAuthorizeService: 4-6 hours
- Authorize route: 3-4 hours
- Account selector UI: 3-4 hours
- OpenAuth integration: 4-6 hours
- Testing: 6-8 hours
- **Total: 21-30 hours**

## Security Considerations
- Never redirect to unregistered redirect_uri
- Validate client_id before any redirects
- State parameter must be echoed back
- prompt=none must never show UI
- Account selection must verify account belongs to current browser session
