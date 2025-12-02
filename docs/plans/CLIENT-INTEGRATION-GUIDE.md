# Client Integration Guide

## Overview

This guide explains how client applications (web apps, mobile apps, SPAs) can integrate with the AlUmmahNow Identity Platform to implement SSO, multi-account sessions, and other enterprise authentication features.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Authentication Flows](#authentication-flows)
3. [SSO Implementation](#sso-implementation)
4. [Multi-Account Sessions](#multi-account-sessions)
5. [Session Management](#session-management)
6. [Token Handling](#token-handling)
7. [Account Switcher UI](#account-switcher-ui)
8. [Error Handling](#error-handling)
9. [Security Best Practices](#security-best-practices)
10. [SDK Reference](#sdk-reference)

---

## Quick Start

### Installation

```bash
# npm
npm install @alummahnow/auth-client

# pnpm
pnpm add @alummahnow/auth-client

# yarn
yarn add @alummahnow/auth-client
```

### Basic Setup

```typescript
import { AuthClient } from '@alummahnow/auth-client';

const auth = new AuthClient({
  authServerUrl: 'https://auth.alummahnow.net',
  clientId: 'your-client-id',
  redirectUri: 'https://yourapp.com/callback',
});
```

### Minimal Integration

```typescript
// Check if user is logged in
const session = await auth.getSession();

if (!session.authenticated) {
  // Redirect to login
  await auth.login();
} else {
  // User is logged in
  console.log('Welcome', session.user.email);
}
```

---

## Authentication Flows

### 1. Standard Login Flow

Use when you want to show the login UI to users.

```typescript
// Redirect user to login
await auth.login();

// In your callback route (/callback)
const result = await auth.handleCallback();

if (result.success) {
  // Store tokens securely
  storeTokens(result.accessToken, result.refreshToken);

  // Redirect to app
  window.location.href = '/dashboard';
}
```

### 2. Silent Authentication (SSO)

Use to check if user has an existing session without showing UI.

```typescript
async function checkSSO(): Promise<boolean> {
  try {
    // Try silent auth first
    const result = await auth.silentLogin();

    if (result.success) {
      // User was already logged in via another app
      storeTokens(result.accessToken, result.refreshToken);
      return true;
    }
  } catch (error) {
    if (error.code === 'login_required') {
      // No existing session - user needs to login
      return false;
    }
    throw error;
  }
  return false;
}

// Usage
const isLoggedIn = await checkSSO();
if (!isLoggedIn) {
  showLoginButton();
}
```

### 3. Add Account Flow

Use when user wants to add another account without signing out.

```typescript
// Add new account (preserves existing accounts)
await auth.addAccount();

// In callback, the new account becomes active
const result = await auth.handleCallback();

// User now has multiple accounts
const accounts = await auth.getAccounts();
console.log(`User has ${accounts.length} accounts`);
```

### 4. Account Selection Flow

Use when you want user to choose which account to use.

```typescript
// Show account picker
await auth.selectAccount();

// In callback
const result = await auth.handleCallback();

// result.user is the selected account
console.log('Selected account:', result.user.email);
```

---

## SSO Implementation

### Cross-App SSO Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│    App A     │     │  Auth Server │     │    App B     │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       │ User logs in       │                    │
       │───────────────────►│                    │
       │                    │                    │
       │ Session created    │                    │
       │◄───────────────────│                    │
       │                    │                    │
       │                    │    User visits     │
       │                    │◄───────────────────│
       │                    │                    │
       │                    │ Silent auth        │
       │                    │ (prompt=none)      │
       │                    │◄───────────────────│
       │                    │                    │
       │                    │ Session found!     │
       │                    │ Return tokens      │
       │                    │───────────────────►│
       │                    │                    │
       │                    │   User logged in   │
       │                    │   (no UI shown)    │
```

### Implementation

```typescript
// App initialization
async function initApp() {
  // Step 1: Check for existing SSO session
  const hasSession = await checkSSO();

  if (hasSession) {
    // User is logged in via SSO
    await loadUserData();
    showApp();
  } else {
    // Show login page or button
    showLoginUI();
  }
}

async function checkSSO(): Promise<boolean> {
  try {
    const result = await auth.silentLogin();
    return result.success;
  } catch (error) {
    // login_required means no session exists
    if (error.code === 'login_required') {
      return false;
    }
    // Other errors should be handled
    console.error('SSO check failed:', error);
    return false;
  }
}
```

### Force Re-authentication

Use `max_age` to require recent authentication:

```typescript
// Require auth within last 5 minutes for sensitive operations
await auth.login({
  maxAge: 300, // 5 minutes in seconds
});
```

---

## Multi-Account Sessions

### Understanding Multi-Account

Users can have up to 3 accounts logged in simultaneously. One account is "active" at any time.

```
Browser Session
├── Account 1 (work@company.com) [ACTIVE]
├── Account 2 (personal@gmail.com)
└── Account 3 (admin@company.com)
```

### Get All Accounts

```typescript
const accounts = await auth.getAccounts();

accounts.forEach(account => {
  console.log(`
    User: ${account.email}
    Active: ${account.isActive}
    Last used: ${account.lastUsed}
  `);
});
```

### Switch Account

```typescript
// Switch to different account
await auth.switchAccount(targetUserId);

// After switching, you need new tokens
const newSession = await auth.getSession();
console.log('Now using:', newSession.user.email);

// Reload app data for new account
await loadUserData();
```

### Sign Out Single Account

```typescript
// Sign out specific account (keeps others)
const result = await auth.signOutAccount(userId);

if (result.remainingAccounts === 0) {
  // All accounts signed out
  redirectToHome();
} else if (result.wasActive) {
  // Active account was removed, now using different account
  await loadUserData();
}
```

### Sign Out All Accounts

```typescript
await auth.signOutAll();
redirectToHome();
```

---

## Session Management

### Check Session Status

```typescript
interface SessionCheck {
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

const status = await auth.checkSession();

if (status.authenticated) {
  console.log(`Logged in as ${status.session.email}`);
  console.log(`Session expires: ${status.session.expiresAt}`);
} else {
  console.log('Not logged in');
}
```

### List User's Devices/Sessions

```typescript
const devices = await auth.getDevices();

devices.sessions.forEach(session => {
  console.log(`
    Device: ${session.deviceName}
    IP: ${session.ipAddress}
    Last active: ${session.lastActivity}
    Current: ${session.isCurrentSession}
  `);
});
```

### Remote Logout (Sign Out Other Device)

```typescript
// Get list of sessions
const devices = await auth.getDevices();

// Find session to revoke
const otherDevice = devices.sessions.find(s => !s.isCurrentSession);

if (otherDevice) {
  await auth.revokeDevice(otherDevice.id);
  console.log('Signed out from other device');
}
```

---

## Token Handling

### Token Storage

```typescript
// Recommended: Use secure HTTP-only cookies (server-side)
// For SPAs, use in-memory storage with refresh

class TokenManager {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;

  setTokens(access: string, refresh: string) {
    this.accessToken = access;
    // Store refresh token securely (encrypted localStorage or server)
    this.refreshToken = refresh;
  }

  async getAccessToken(): Promise<string | null> {
    if (this.isTokenExpired(this.accessToken)) {
      await this.refreshTokens();
    }
    return this.accessToken;
  }

  private async refreshTokens() {
    if (!this.refreshToken) {
      throw new Error('No refresh token');
    }

    const result = await auth.refreshTokens(this.refreshToken);
    this.accessToken = result.accessToken;
    this.refreshToken = result.refreshToken;
  }

  private isTokenExpired(token: string | null): boolean {
    if (!token) return true;

    const payload = JSON.parse(atob(token.split('.')[1]));
    const exp = payload.exp * 1000;

    // Consider expired 60 seconds before actual expiration
    return Date.now() > (exp - 60000);
  }
}
```

### Making Authenticated Requests

```typescript
const tokenManager = new TokenManager();

async function apiRequest(url: string, options: RequestInit = {}) {
  const token = await tokenManager.getAccessToken();

  if (!token) {
    throw new Error('Not authenticated');
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`,
    },
  });

  if (response.status === 401) {
    // Token rejected - force re-login
    await auth.login();
  }

  return response;
}
```

### Token Claims

Access tokens contain useful claims:

```typescript
interface TokenClaims {
  sub: string;        // User ID
  email: string;      // User email
  aud: string;        // Your app's client ID
  roles: string[];    // User's roles
  permissions: string[]; // Effective permissions for your app
  session_id: string; // Session ID (for revocation)
  exp: number;        // Expiration timestamp
}

function getTokenClaims(token: string): TokenClaims {
  const payload = token.split('.')[1];
  return JSON.parse(atob(payload));
}

// Usage
const claims = getTokenClaims(accessToken);
console.log('User roles:', claims.roles);
console.log('Permissions:', claims.permissions);
```

### Token Exchange (Cross-App)

If your app needs to call another app's API:

```typescript
// Exchange your token for a token valid for another app
const newToken = await auth.exchangeToken({
  targetAudience: 'other-app-client-id',
  scope: 'read write',
});

// Use newToken to call other app's API
await fetch('https://other-app.com/api/data', {
  headers: {
    'Authorization': `Bearer ${newToken.accessToken}`,
  },
});
```

---

## Account Switcher UI

### React Component Example

```tsx
import { useState, useEffect } from 'react';
import { auth, type Account } from './auth';

interface AccountSwitcherProps {
  onAccountChange?: (account: Account) => void;
}

export function AccountSwitcher({ onAccountChange }: AccountSwitcherProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const activeAccount = accounts.find(a => a.isActive);
  const canAddAccount = accounts.length < 3;

  useEffect(() => {
    loadAccounts();
  }, []);

  async function loadAccounts() {
    setLoading(true);
    try {
      const result = await auth.getAccounts();
      setAccounts(result.accounts);
    } finally {
      setLoading(false);
    }
  }

  async function handleSwitch(userId: string) {
    setLoading(true);
    try {
      await auth.switchAccount(userId);
      await loadAccounts();

      const newActive = accounts.find(a => a.userId === userId);
      if (newActive) {
        onAccountChange?.(newActive);
      }

      // Reload page to get new tokens
      window.location.reload();
    } finally {
      setLoading(false);
      setIsOpen(false);
    }
  }

  async function handleSignOut(userId: string) {
    const result = await auth.signOutAccount(userId);

    if (result.remainingAccounts === 0) {
      window.location.href = '/';
    } else {
      await loadAccounts();
      if (result.wasActive) {
        window.location.reload();
      }
    }
  }

  async function handleAddAccount() {
    await auth.addAccount();
  }

  async function handleSignOutAll() {
    await auth.signOutAll();
    window.location.href = '/';
  }

  if (!activeAccount) {
    return null;
  }

  return (
    <div className="account-switcher">
      {/* Trigger Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="account-trigger"
        disabled={loading}
      >
        <span className="avatar">
          {activeAccount.email.charAt(0).toUpperCase()}
        </span>
        <span className="email">{activeAccount.email}</span>
        <span className="chevron">▼</span>
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="account-dropdown">
          {/* Account List */}
          {accounts.map(account => (
            <div key={account.userId} className="account-item">
              <button
                onClick={() => handleSwitch(account.userId)}
                disabled={account.isActive || loading}
                className="account-select"
              >
                <span className="avatar">
                  {account.email.charAt(0).toUpperCase()}
                </span>
                <div className="account-info">
                  <span className="email">{account.email}</span>
                  {account.isActive && (
                    <span className="badge active">Active</span>
                  )}
                </div>
              </button>
              <button
                onClick={() => handleSignOut(account.userId)}
                className="sign-out-btn"
                title="Sign out this account"
              >
                ×
              </button>
            </div>
          ))}

          {/* Divider */}
          <hr className="divider" />

          {/* Add Account */}
          {canAddAccount && (
            <button onClick={handleAddAccount} className="add-account">
              <span className="icon">+</span>
              Add another account
            </button>
          )}

          {/* Sign Out All */}
          <button onClick={handleSignOutAll} className="sign-out-all">
            Sign out of all accounts
          </button>
        </div>
      )}
    </div>
  );
}
```

### CSS Styles

```css
.account-switcher {
  position: relative;
  display: inline-block;
}

.account-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: transparent;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s;
}

.account-trigger:hover {
  background: #f5f5f5;
}

.avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: #1976d2;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 14px;
}

.account-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 280px;
  background: white;
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  z-index: 1000;
  overflow: hidden;
}

.account-item {
  display: flex;
  align-items: center;
  padding: 4px;
}

.account-select {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: none;
  border: none;
  cursor: pointer;
  border-radius: 8px;
  transition: background 0.2s;
}

.account-select:hover:not(:disabled) {
  background: #f5f5f5;
}

.account-select:disabled {
  cursor: default;
}

.account-info {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.badge.active {
  font-size: 10px;
  padding: 2px 6px;
  background: #4caf50;
  color: white;
  border-radius: 4px;
}

.sign-out-btn {
  padding: 8px;
  background: none;
  border: none;
  color: #999;
  cursor: pointer;
  font-size: 18px;
}

.sign-out-btn:hover {
  color: #f44336;
}

.divider {
  margin: 8px 16px;
  border: none;
  border-top: 1px solid #e0e0e0;
}

.add-account,
.sign-out-all {
  width: 100%;
  padding: 12px 16px;
  background: none;
  border: none;
  text-align: left;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 12px;
  transition: background 0.2s;
}

.add-account:hover,
.sign-out-all:hover {
  background: #f5f5f5;
}

.sign-out-all {
  color: #f44336;
}

.icon {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: #f5f5f5;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  color: #666;
}
```

---

## Error Handling

### Common Errors

```typescript
interface AuthError {
  code: string;
  message: string;
  description?: string;
}

const AUTH_ERRORS = {
  // OAuth/OIDC Errors
  'login_required': 'User needs to log in',
  'consent_required': 'User consent is required',
  'account_selection_required': 'User must select an account',
  'interaction_required': 'User interaction is required',
  'invalid_request': 'The request is malformed',
  'unauthorized_client': 'Client is not authorized',
  'access_denied': 'User denied access',

  // Session Errors
  'session_expired': 'Session has expired',
  'session_revoked': 'Session was revoked',
  'max_accounts_reached': 'Maximum accounts (3) reached',

  // Token Errors
  'token_expired': 'Token has expired',
  'token_revoked': 'Token was revoked',
  'invalid_token': 'Token is invalid',
  'refresh_failed': 'Failed to refresh token',
};
```

### Error Handler

```typescript
async function handleAuthError(error: AuthError) {
  switch (error.code) {
    case 'login_required':
    case 'session_expired':
    case 'session_revoked':
      // Redirect to login
      await auth.login();
      break;

    case 'account_selection_required':
      // Show account picker
      await auth.selectAccount();
      break;

    case 'max_accounts_reached':
      // Show message to user
      showToast('You can only have 3 accounts. Please sign out of one first.');
      break;

    case 'token_expired':
    case 'refresh_failed':
      // Try to refresh, if fails, redirect to login
      try {
        await tokenManager.refreshTokens();
      } catch {
        await auth.login();
      }
      break;

    default:
      console.error('Auth error:', error);
      showToast('Authentication error. Please try again.');
  }
}
```

### Retry Logic

```typescript
async function apiRequestWithRetry(
  url: string,
  options: RequestInit = {},
  maxRetries = 2
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await apiRequest(url, options);

      if (response.ok) {
        return response;
      }

      if (response.status === 401 && attempt < maxRetries) {
        // Token might be expired, try refresh
        await tokenManager.refreshTokens();
        continue;
      }

      return response;
    } catch (error) {
      lastError = error as Error;

      if (attempt < maxRetries) {
        // Wait before retry
        await sleep(1000 * (attempt + 1));
      }
    }
  }

  throw lastError;
}
```

---

## Security Best Practices

### 1. Token Storage

```typescript
// ❌ DON'T: Store tokens in localStorage (XSS vulnerable)
localStorage.setItem('accessToken', token);

// ✅ DO: Use HTTP-only cookies (server-side) or in-memory storage
class SecureTokenStorage {
  private token: string | null = null;

  set(token: string) {
    this.token = token;
    // Token is lost on page refresh, but that's more secure
  }

  get(): string | null {
    return this.token;
  }

  clear() {
    this.token = null;
  }
}
```

### 2. CSRF Protection

```typescript
// Use state parameter for OAuth flows
const state = generateRandomString(32);
sessionStorage.setItem('oauth_state', state);

await auth.login({ state });

// In callback, verify state
const returnedState = new URLSearchParams(window.location.search).get('state');
const savedState = sessionStorage.getItem('oauth_state');

if (returnedState !== savedState) {
  throw new Error('State mismatch - possible CSRF attack');
}
```

### 3. PKCE (Proof Key for Code Exchange)

```typescript
// SDK handles this automatically, but here's what happens:

// 1. Generate code verifier (random string)
const codeVerifier = generateRandomString(64);

// 2. Create code challenge (SHA-256 hash)
const codeChallenge = await sha256(codeVerifier);

// 3. Send challenge with auth request
await auth.login({
  codeChallenge,
  codeChallengeMethod: 'S256',
});

// 4. Send verifier with token request
const tokens = await auth.exchangeCode(code, codeVerifier);
```

### 4. Secure Redirects

```typescript
// ❌ DON'T: Accept any redirect URL
const redirectTo = new URLSearchParams(window.location.search).get('redirect');
window.location.href = redirectTo; // Dangerous!

// ✅ DO: Validate redirect URLs
const ALLOWED_ORIGINS = [
  'https://app.alummahnow.net',
  'https://admin.alummahnow.net',
];

function isValidRedirect(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_ORIGINS.includes(parsed.origin);
  } catch {
    return false;
  }
}

const redirectTo = new URLSearchParams(window.location.search).get('redirect');
if (redirectTo && isValidRedirect(redirectTo)) {
  window.location.href = redirectTo;
} else {
  window.location.href = '/dashboard';
}
```

### 5. Session Timeout Handling

```typescript
// Monitor session expiration
function setupSessionMonitor() {
  const checkInterval = 60000; // Check every minute

  setInterval(async () => {
    const session = await auth.checkSession();

    if (!session.authenticated) {
      // Session expired
      showSessionExpiredModal();
      return;
    }

    // Warn if session expires soon (5 minutes)
    const expiresAt = new Date(session.session.expiresAt).getTime();
    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;

    if (expiresAt - now < fiveMinutes) {
      showSessionExpiringWarning();
    }
  }, checkInterval);
}
```

---

## SDK Reference

### AuthClient

```typescript
class AuthClient {
  constructor(config: AuthConfig);

  // Authentication
  login(options?: LoginOptions): Promise<void>;
  silentLogin(): Promise<AuthResult>;
  addAccount(): Promise<void>;
  selectAccount(): Promise<void>;
  handleCallback(): Promise<AuthResult>;
  logout(): Promise<void>;

  // Session
  getSession(): Promise<SessionInfo>;
  checkSession(): Promise<SessionCheck>;

  // Accounts
  getAccounts(): Promise<AccountsResponse>;
  switchAccount(userId: string): Promise<void>;
  signOutAccount(userId: string): Promise<SignOutResult>;
  signOutAll(): Promise<void>;

  // Devices
  getDevices(): Promise<DevicesResponse>;
  revokeDevice(sessionId: string): Promise<void>;

  // Tokens
  refreshTokens(refreshToken: string): Promise<TokenResult>;
  exchangeToken(options: ExchangeOptions): Promise<TokenResult>;
}
```

### Types

```typescript
interface AuthConfig {
  authServerUrl: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  responseType?: string;
}

interface LoginOptions {
  prompt?: 'none' | 'login' | 'select_account';
  loginHint?: string;
  accountHint?: string;
  maxAge?: number;
  state?: string;
  scope?: string;
}

interface AuthResult {
  success: boolean;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    email: string;
    roles: string[];
  };
}

interface Account {
  userId: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  isActive: boolean;
  authenticatedAt: string;
  lastUsed: string;
}

interface AccountsResponse {
  accounts: Account[];
  activeAccount: Account | null;
}

interface SignOutResult {
  success: boolean;
  wasActive: boolean;
  newActiveUserId: string | null;
  remainingAccounts: number;
}

interface DeviceSession {
  id: string;
  deviceType: string;
  deviceName: string;
  ipAddress: string;
  lastActivity: string;
  createdAt: string;
  isCurrentSession: boolean;
}

interface DevicesResponse {
  sessions: DeviceSession[];
  total: number;
}

interface ExchangeOptions {
  targetAudience: string;
  scope?: string;
}
```

---

## Framework-Specific Examples

### Next.js (App Router)

```typescript
// app/auth/callback/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  // Verify state
  const savedState = cookies().get('oauth_state')?.value;
  if (state !== savedState) {
    return NextResponse.redirect('/error?message=invalid_state');
  }

  // Exchange code for tokens
  const result = await auth.exchangeCode(code);

  // Set session cookie
  const response = NextResponse.redirect('/dashboard');
  response.cookies.set('session', result.accessToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: result.expiresIn,
  });

  return response;
}
```

### React with React Router

```tsx
// AuthProvider.tsx
import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth, type Account } from '@/lib/auth';

interface AuthContextValue {
  isAuthenticated: boolean;
  user: Account | null;
  accounts: Account[];
  login: () => Promise<void>;
  logout: () => Promise<void>;
  switchAccount: (userId: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<Account | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      const result = await auth.silentLogin();
      setIsAuthenticated(true);
      await loadAccounts();
    } catch {
      setIsAuthenticated(false);
    }
  }

  async function loadAccounts() {
    const { accounts, activeAccount } = await auth.getAccounts();
    setAccounts(accounts);
    setUser(activeAccount);
  }

  async function login() {
    await auth.login();
  }

  async function logout() {
    await auth.signOutAll();
    setIsAuthenticated(false);
    setUser(null);
    setAccounts([]);
    navigate('/');
  }

  async function switchAccount(userId: string) {
    await auth.switchAccount(userId);
    await loadAccounts();
    window.location.reload();
  }

  return (
    <AuthContext.Provider value={{
      isAuthenticated,
      user,
      accounts,
      login,
      logout,
      switchAccount,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
```

### Vue 3 Composition API

```typescript
// composables/useAuth.ts
import { ref, computed, onMounted } from 'vue';
import { auth, type Account } from '@/lib/auth';

const isAuthenticated = ref(false);
const user = ref<Account | null>(null);
const accounts = ref<Account[]>([]);
const loading = ref(true);

export function useAuth() {
  onMounted(async () => {
    await checkAuth();
  });

  async function checkAuth() {
    loading.value = true;
    try {
      await auth.silentLogin();
      isAuthenticated.value = true;
      await loadAccounts();
    } catch {
      isAuthenticated.value = false;
    } finally {
      loading.value = false;
    }
  }

  async function loadAccounts() {
    const result = await auth.getAccounts();
    accounts.value = result.accounts;
    user.value = result.activeAccount;
  }

  async function login() {
    await auth.login();
  }

  async function logout() {
    await auth.signOutAll();
    isAuthenticated.value = false;
    user.value = null;
    accounts.value = [];
    window.location.href = '/';
  }

  async function switchAccount(userId: string) {
    await auth.switchAccount(userId);
    await loadAccounts();
    window.location.reload();
  }

  return {
    isAuthenticated: computed(() => isAuthenticated.value),
    user: computed(() => user.value),
    accounts: computed(() => accounts.value),
    loading: computed(() => loading.value),
    login,
    logout,
    switchAccount,
  };
}
```

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Silent login always fails | No SSO session | User needs to login normally first |
| CORS errors | Wrong redirect URI | Ensure redirect URI matches registration |
| State mismatch | Session storage cleared | Don't clear storage during auth flow |
| Token refresh fails | Refresh token expired | Redirect to login |
| Account limit reached | 3 accounts already | Sign out one account first |

### Debug Mode

```typescript
const auth = new AuthClient({
  ...config,
  debug: true, // Enables console logging
});

// Or enable for specific operations
await auth.login({ debug: true });
```

### Support

- Documentation: https://docs.alummahnow.net/auth
- Issues: https://github.com/alummahnow/auth/issues
- Email: support@alummahnow.net
