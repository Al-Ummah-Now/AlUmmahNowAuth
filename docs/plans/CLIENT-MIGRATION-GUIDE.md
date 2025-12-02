# Client Migration Guide: Multi-Account Sessions

## Overview

This guide helps migrate existing client applications from **client-managed multi-account tokens** (HTTP-only cookies per user) to the new **server-managed browser sessions** architecture.

### What's Changing

| Before | After |
|--------|-------|
| Client stores multiple token cookies | Auth server manages browser session with accounts |
| Client swaps active token | Client calls `/session/switch` API |
| Logout = delete cookie (token may still work) | Logout = server revokes session + ALL tokens |
| No account limit | Max 3 accounts enforced server-side |
| No cross-app SSO | Full SSO - login once, use everywhere |

### Benefits of Migration

- **Security**: Hard sign-out revokes ALL tokens, not just cookies
- **SSO**: Users logged into one app are automatically logged into others
- **Consistency**: Account state synchronized across all apps
- **Simplicity**: Auth server handles complexity, client just calls APIs

---

## Prerequisites

Before starting migration:

1. **Auth Server Updated**: Ensure auth server has Lane 1-3 deployed
2. **Feature Flag**: `multiAccountSessions` feature flag enabled
3. **Client SDK**: Install `@alummahnow/auth-client` v2.0+
4. **Test Environment**: QA environment with new auth server

---

## Migration Phases

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MIGRATION TIMELINE                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Phase 1: Detection & Dual Mode                                              │
│  ─────────────────────────────                                               │
│  • Add feature detection                                                     │
│  • Support both old and new APIs                                             │
│  • No user impact                                                            │
│                                                                              │
│  Phase 2: Session Migration                                                  │
│  ──────────────────────────                                                  │
│  • Migrate existing tokens to new sessions                                   │
│  • Users automatically moved on next login                                   │
│  • Gradual rollout (10% → 50% → 100%)                                       │
│                                                                              │
│  Phase 3: UI Update                                                          │
│  ─────────────────                                                           │
│  • Replace AccountSwitcher component                                         │
│  • Update all auth-related UI                                                │
│  • New error handling                                                        │
│                                                                              │
│  Phase 4: Cleanup                                                            │
│  ───────────────                                                             │
│  • Remove legacy token storage                                               │
│  • Remove old API calls                                                      │
│  • Delete migration code                                                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Detection & Dual Mode

### 1.1 Install New SDK

```bash
npm install @alummahnow/auth-client@^2.0.0
```

### 1.2 Create Migration Service

```typescript
// File: src/services/auth-migration.service.ts

import { AuthClient } from '@alummahnow/auth-client';

export interface MigrationState {
  hasLegacyTokens: boolean;
  hasNewSession: boolean;
  migrationComplete: boolean;
  accountCount: number;
}

export class AuthMigrationService {
  private authClient: AuthClient;
  private legacyCookiePrefix: string;

  constructor(config: {
    authServerUrl: string;
    clientId: string;
    redirectUri: string;
    legacyCookiePrefix: string; // e.g., 'auth_token_' or 'user_session_'
  }) {
    this.authClient = new AuthClient({
      authServerUrl: config.authServerUrl,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
    });
    this.legacyCookiePrefix = config.legacyCookiePrefix;
  }

  /**
   * Check if auth server supports new multi-account sessions
   */
  async supportsNewSessions(): Promise<boolean> {
    try {
      const response = await fetch(
        `${this.authClient.config.authServerUrl}/session/check`,
        { credentials: 'include' }
      );
      return response.ok || response.status === 401; // Endpoint exists
    } catch {
      return false;
    }
  }

  /**
   * Get current migration state
   */
  async getMigrationState(): Promise<MigrationState> {
    const legacyTokens = this.getLegacyTokens();
    const hasLegacyTokens = legacyTokens.length > 0;

    let hasNewSession = false;
    let accountCount = 0;

    try {
      const response = await fetch(
        `${this.authClient.config.authServerUrl}/session/accounts`,
        { credentials: 'include' }
      );

      if (response.ok) {
        const data = await response.json();
        hasNewSession = true;
        accountCount = data.accounts?.length || 0;
      }
    } catch {
      // No new session
    }

    return {
      hasLegacyTokens,
      hasNewSession,
      migrationComplete: hasNewSession && !hasLegacyTokens,
      accountCount,
    };
  }

  /**
   * Get legacy tokens from cookies
   */
  getLegacyTokens(): Array<{
    userId: string;
    accessToken: string;
    refreshToken: string;
  }> {
    const tokens: Array<{
      userId: string;
      accessToken: string;
      refreshToken: string;
    }> = [];

    // Parse cookies to find legacy tokens
    // Adjust this based on your actual cookie structure
    const cookies = document.cookie.split(';').reduce((acc, cookie) => {
      const [name, value] = cookie.trim().split('=');
      acc[name] = value;
      return acc;
    }, {} as Record<string, string>);

    // Find all legacy token cookies
    // Example pattern: auth_token_user123, refresh_token_user123
    Object.keys(cookies).forEach(name => {
      if (name.startsWith(this.legacyCookiePrefix)) {
        const userId = name.replace(this.legacyCookiePrefix, '').replace('_access', '').replace('_refresh', '');

        const existing = tokens.find(t => t.userId === userId);
        if (existing) {
          if (name.includes('refresh')) {
            existing.refreshToken = cookies[name];
          } else {
            existing.accessToken = cookies[name];
          }
        } else {
          tokens.push({
            userId,
            accessToken: name.includes('access') ? cookies[name] : '',
            refreshToken: name.includes('refresh') ? cookies[name] : '',
          });
        }
      }
    });

    return tokens.filter(t => t.accessToken || t.refreshToken);
  }

  /**
   * Clear legacy token cookies
   */
  clearLegacyTokens(): void {
    const cookies = document.cookie.split(';');

    cookies.forEach(cookie => {
      const name = cookie.split('=')[0].trim();
      if (name.startsWith(this.legacyCookiePrefix)) {
        // Delete by setting expired date
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${window.location.hostname}`;
        // Also try without domain for same-site cookies
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
      }
    });
  }

  /**
   * Get the auth client instance
   */
  getAuthClient(): AuthClient {
    return this.authClient;
  }
}
```

### 1.3 Create Hybrid Auth Provider

```typescript
// File: src/providers/HybridAuthProvider.tsx

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { AuthMigrationService, MigrationState } from '../services/auth-migration.service';

interface Account {
  userId: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  isActive: boolean;
}

interface HybridAuthContextValue {
  // State
  isAuthenticated: boolean;
  isLoading: boolean;
  accounts: Account[];
  activeAccount: Account | null;
  migrationState: MigrationState | null;
  useNewApi: boolean;

  // Actions
  login: () => Promise<void>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  switchAccount: (userId: string) => Promise<void>;
  addAccount: () => Promise<void>;
  refreshAccounts: () => Promise<void>;
}

const HybridAuthContext = createContext<HybridAuthContextValue | null>(null);

interface HybridAuthProviderProps {
  children: ReactNode;
  config: {
    authServerUrl: string;
    clientId: string;
    redirectUri: string;
    legacyCookiePrefix: string;
  };
  // Legacy handlers - your existing implementation
  legacyHandlers?: {
    getAccounts: () => Promise<Account[]>;
    switchAccount: (userId: string) => Promise<void>;
    logout: (userId: string) => Promise<void>;
    logoutAll: () => Promise<void>;
  };
}

export function HybridAuthProvider({
  children,
  config,
  legacyHandlers
}: HybridAuthProviderProps) {
  const [migrationService] = useState(() => new AuthMigrationService(config));
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccount, setActiveAccount] = useState<Account | null>(null);
  const [migrationState, setMigrationState] = useState<MigrationState | null>(null);
  const [useNewApi, setUseNewApi] = useState(false);

  // Initialize and detect which API to use
  useEffect(() => {
    initializeAuth();
  }, []);

  async function initializeAuth() {
    setIsLoading(true);

    try {
      // Check if new API is available
      const supportsNew = await migrationService.supportsNewSessions();
      setUseNewApi(supportsNew);

      // Get migration state
      const state = await migrationService.getMigrationState();
      setMigrationState(state);

      // Load accounts based on available API
      if (supportsNew && state.hasNewSession) {
        await loadAccountsFromNewApi();
      } else if (state.hasLegacyTokens && legacyHandlers) {
        await loadAccountsFromLegacyApi();
      }
    } catch (error) {
      console.error('Auth initialization failed:', error);
    } finally {
      setIsLoading(false);
    }
  }

  async function loadAccountsFromNewApi() {
    try {
      const response = await fetch(
        `${config.authServerUrl}/session/accounts`,
        { credentials: 'include' }
      );

      if (response.ok) {
        const data = await response.json();
        setAccounts(data.accounts || []);
        setActiveAccount(data.activeAccount || null);
        setIsAuthenticated(data.accounts?.length > 0);
      }
    } catch (error) {
      console.error('Failed to load accounts from new API:', error);
    }
  }

  async function loadAccountsFromLegacyApi() {
    if (!legacyHandlers) return;

    try {
      const accounts = await legacyHandlers.getAccounts();
      setAccounts(accounts);
      setActiveAccount(accounts.find(a => a.isActive) || null);
      setIsAuthenticated(accounts.length > 0);
    } catch (error) {
      console.error('Failed to load accounts from legacy API:', error);
    }
  }

  async function refreshAccounts() {
    if (useNewApi && migrationState?.hasNewSession) {
      await loadAccountsFromNewApi();
    } else if (legacyHandlers) {
      await loadAccountsFromLegacyApi();
    }
  }

  // Login
  async function login() {
    const auth = migrationService.getAuthClient();
    await auth.login();
  }

  // Add another account
  async function addAccount() {
    const auth = migrationService.getAuthClient();
    await auth.addAccount();
  }

  // Switch account
  async function switchAccount(userId: string) {
    if (useNewApi && migrationState?.hasNewSession) {
      // Use new API
      const response = await fetch(
        `${config.authServerUrl}/session/switch`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId }),
        }
      );

      if (!response.ok) {
        throw new Error('Failed to switch account');
      }

      await refreshAccounts();

      // Reload to get new tokens
      window.location.reload();
    } else if (legacyHandlers) {
      // Use legacy handler
      await legacyHandlers.switchAccount(userId);
      await refreshAccounts();
    }
  }

  // Logout single account
  async function logout() {
    if (!activeAccount) return;

    if (useNewApi && migrationState?.hasNewSession) {
      // Use new API - this performs HARD sign-out
      const response = await fetch(
        `${config.authServerUrl}/session/accounts/${activeAccount.userId}`,
        {
          method: 'DELETE',
          credentials: 'include',
        }
      );

      if (!response.ok) {
        throw new Error('Failed to logout');
      }

      const data = await response.json();

      if (data.remainingAccounts === 0) {
        setIsAuthenticated(false);
        setAccounts([]);
        setActiveAccount(null);
        window.location.href = '/';
      } else {
        await refreshAccounts();
        if (data.wasActive) {
          window.location.reload();
        }
      }
    } else if (legacyHandlers) {
      await legacyHandlers.logout(activeAccount.userId);
      await refreshAccounts();
    }
  }

  // Logout all accounts
  async function logoutAll() {
    if (useNewApi && migrationState?.hasNewSession) {
      // Use new API
      await fetch(
        `${config.authServerUrl}/session/all`,
        {
          method: 'DELETE',
          credentials: 'include',
        }
      );

      // Also clear any legacy tokens
      migrationService.clearLegacyTokens();
    } else if (legacyHandlers) {
      await legacyHandlers.logoutAll();
    }

    setIsAuthenticated(false);
    setAccounts([]);
    setActiveAccount(null);
    window.location.href = '/';
  }

  return (
    <HybridAuthContext.Provider value={{
      isAuthenticated,
      isLoading,
      accounts,
      activeAccount,
      migrationState,
      useNewApi,
      login,
      logout,
      logoutAll,
      switchAccount,
      addAccount,
      refreshAccounts,
    }}>
      {children}
    </HybridAuthContext.Provider>
  );
}

export function useHybridAuth() {
  const context = useContext(HybridAuthContext);
  if (!context) {
    throw new Error('useHybridAuth must be used within HybridAuthProvider');
  }
  return context;
}
```

---

## Phase 2: Session Migration

### 2.1 Automatic Migration on Login

When users log in, automatically migrate them to the new session model:

```typescript
// File: src/services/session-migrator.ts

import { AuthMigrationService } from './auth-migration.service';

export class SessionMigrator {
  constructor(private migrationService: AuthMigrationService) {}

  /**
   * Migrate user's legacy tokens to new browser session
   * Called after successful login or on app initialization
   */
  async migrateToNewSession(): Promise<{
    migrated: number;
    failed: number;
    errors: string[];
  }> {
    const state = await this.migrationService.getMigrationState();

    // Already migrated or no legacy tokens
    if (state.migrationComplete || !state.hasLegacyTokens) {
      return { migrated: 0, failed: 0, errors: [] };
    }

    const legacyTokens = this.migrationService.getLegacyTokens();
    const results = { migrated: 0, failed: 0, errors: [] as string[] };

    // If we have a new session, check if legacy accounts are already there
    if (state.hasNewSession) {
      // Get accounts from new session
      const response = await fetch(
        `${this.migrationService.getAuthClient().config.authServerUrl}/session/accounts`,
        { credentials: 'include' }
      );

      if (response.ok) {
        const { accounts } = await response.json();
        const existingUserIds = new Set(accounts.map((a: any) => a.userId));

        // Filter out tokens for accounts already in new session
        const tokensToMigrate = legacyTokens.filter(
          t => !existingUserIds.has(t.userId)
        );

        // Migrate remaining accounts (up to max 3 total)
        const slotsAvailable = 3 - accounts.length;

        for (let i = 0; i < Math.min(tokensToMigrate.length, slotsAvailable); i++) {
          const token = tokensToMigrate[i];
          try {
            await this.migrateToken(token);
            results.migrated++;
          } catch (error) {
            results.failed++;
            results.errors.push(`Failed to migrate ${token.userId}: ${error}`);
          }
        }
      }
    } else {
      // No new session yet - create one with first legacy token
      if (legacyTokens.length > 0) {
        try {
          // Use silent login with existing refresh token to establish session
          await this.establishSessionFromToken(legacyTokens[0]);
          results.migrated++;

          // Migrate additional accounts
          for (let i = 1; i < Math.min(legacyTokens.length, 3); i++) {
            try {
              await this.migrateToken(legacyTokens[i]);
              results.migrated++;
            } catch (error) {
              results.failed++;
              results.errors.push(`Failed to migrate ${legacyTokens[i].userId}: ${error}`);
            }
          }
        } catch (error) {
          results.failed++;
          results.errors.push(`Failed to establish session: ${error}`);
        }
      }
    }

    // Clear legacy tokens after successful migration
    if (results.migrated > 0 && results.failed === 0) {
      this.migrationService.clearLegacyTokens();
    }

    return results;
  }

  /**
   * Establish new browser session from existing refresh token
   */
  private async establishSessionFromToken(token: {
    userId: string;
    refreshToken: string;
  }): Promise<void> {
    const authClient = this.migrationService.getAuthClient();

    // Call auth server's token endpoint with refresh token
    // This should establish a new browser session
    const response = await fetch(
      `${authClient.config.authServerUrl}/token`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token.refreshToken,
          client_id: authClient.config.clientId,
          migrate_session: 'true', // Signal to create browser session
        }),
      }
    );

    if (!response.ok) {
      throw new Error('Failed to establish session from refresh token');
    }
  }

  /**
   * Add an account to existing browser session using refresh token
   */
  private async migrateToken(token: {
    userId: string;
    refreshToken: string;
  }): Promise<void> {
    const authClient = this.migrationService.getAuthClient();

    // Use refresh token to add account to existing session
    const response = await fetch(
      `${authClient.config.authServerUrl}/token`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token.refreshToken,
          client_id: authClient.config.clientId,
          add_to_session: 'true', // Signal to add to existing session
        }),
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error_description || 'Failed to migrate token');
    }
  }
}
```

### 2.2 Migration Trigger Component

```typescript
// File: src/components/MigrationBanner.tsx

import React, { useEffect, useState } from 'react';
import { useHybridAuth } from '../providers/HybridAuthProvider';
import { SessionMigrator } from '../services/session-migrator';
import { AuthMigrationService } from '../services/auth-migration.service';

interface MigrationBannerProps {
  migrationService: AuthMigrationService;
  onMigrationComplete?: () => void;
}

export function MigrationBanner({
  migrationService,
  onMigrationComplete
}: MigrationBannerProps) {
  const { migrationState, refreshAccounts } = useHybridAuth();
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationResult, setMigrationResult] = useState<{
    migrated: number;
    failed: number;
  } | null>(null);

  // Don't show if already migrated or no legacy tokens
  if (!migrationState?.hasLegacyTokens || migrationState.migrationComplete) {
    return null;
  }

  async function handleMigrate() {
    setIsMigrating(true);

    try {
      const migrator = new SessionMigrator(migrationService);
      const result = await migrator.migrateToNewSession();

      setMigrationResult({
        migrated: result.migrated,
        failed: result.failed,
      });

      if (result.migrated > 0) {
        await refreshAccounts();
        onMigrationComplete?.();
      }
    } catch (error) {
      console.error('Migration failed:', error);
      setMigrationResult({ migrated: 0, failed: 1 });
    } finally {
      setIsMigrating(false);
    }
  }

  return (
    <div className="migration-banner">
      <div className="migration-content">
        <h4>Account Update Available</h4>
        <p>
          We've improved how accounts work. Migrate now to get:
          <ul>
            <li>Single sign-on across all apps</li>
            <li>Better security with instant logout</li>
            <li>Easier account switching</li>
          </ul>
        </p>

        {migrationResult ? (
          <div className={`migration-result ${migrationResult.failed > 0 ? 'error' : 'success'}`}>
            {migrationResult.failed > 0 ? (
              <p>Some accounts couldn't be migrated. Please log in again.</p>
            ) : (
              <p>Successfully migrated {migrationResult.migrated} account(s)!</p>
            )}
          </div>
        ) : (
          <button
            onClick={handleMigrate}
            disabled={isMigrating}
            className="migrate-button"
          >
            {isMigrating ? 'Migrating...' : 'Migrate Now'}
          </button>
        )}
      </div>

      <style>{`
        .migration-banner {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 16px 24px;
          border-radius: 12px;
          margin: 16px 0;
        }
        .migration-content h4 {
          margin: 0 0 8px 0;
        }
        .migration-content ul {
          margin: 8px 0;
          padding-left: 20px;
        }
        .migrate-button {
          background: white;
          color: #667eea;
          border: none;
          padding: 10px 24px;
          border-radius: 6px;
          font-weight: 600;
          cursor: pointer;
          margin-top: 12px;
        }
        .migrate-button:disabled {
          opacity: 0.7;
          cursor: not-allowed;
        }
        .migration-result {
          padding: 12px;
          border-radius: 6px;
          margin-top: 12px;
        }
        .migration-result.success {
          background: rgba(255,255,255,0.2);
        }
        .migration-result.error {
          background: rgba(255,0,0,0.2);
        }
      `}</style>
    </div>
  );
}
```

---

## Phase 3: UI Update

### 3.1 New AccountSwitcher Component

```typescript
// File: src/components/AccountSwitcher.tsx

import React, { useState, useRef, useEffect } from 'react';
import { useHybridAuth } from '../providers/HybridAuthProvider';

export function AccountSwitcher() {
  const {
    accounts,
    activeAccount,
    isLoading,
    switchAccount,
    logout,
    logoutAll,
    addAccount,
  } = useHybridAuth();

  const [isOpen, setIsOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Close on escape key
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

  if (isLoading || !activeAccount) {
    return <div className="account-switcher-skeleton" />;
  }

  const canAddAccount = accounts.length < 3;

  async function handleSwitch(userId: string) {
    if (userId === activeAccount?.userId) return;

    setActionLoading(`switch-${userId}`);
    try {
      await switchAccount(userId);
    } finally {
      setActionLoading(null);
      setIsOpen(false);
    }
  }

  async function handleSignOut(userId: string, event: React.MouseEvent) {
    event.stopPropagation();

    setActionLoading(`signout-${userId}`);
    try {
      // If signing out active account, use logout()
      // Otherwise, need to switch and then logout
      if (userId === activeAccount?.userId) {
        await logout();
      } else {
        // Sign out non-active account
        const response = await fetch(
          `${process.env.REACT_APP_AUTH_URL}/session/accounts/${userId}`,
          {
            method: 'DELETE',
            credentials: 'include',
          }
        );

        if (response.ok) {
          // Refresh accounts list
          window.location.reload();
        }
      }
    } finally {
      setActionLoading(null);
    }
  }

  async function handleAddAccount() {
    setActionLoading('add');
    try {
      await addAccount();
    } finally {
      setActionLoading(null);
    }
  }

  async function handleSignOutAll() {
    setActionLoading('all');
    try {
      await logoutAll();
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <div className="account-switcher" ref={dropdownRef}>
      {/* Trigger Button */}
      <button
        className="account-switcher-trigger"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        <div className="avatar">
          {activeAccount.avatarUrl ? (
            <img src={activeAccount.avatarUrl} alt="" />
          ) : (
            <span>{activeAccount.email.charAt(0).toUpperCase()}</span>
          )}
        </div>
        <div className="account-info">
          <span className="name">{activeAccount.name || activeAccount.email}</span>
          <span className="email">{activeAccount.email}</span>
        </div>
        <svg className={`chevron ${isOpen ? 'open' : ''}`} viewBox="0 0 24 24" width="20" height="20">
          <path d="M7 10l5 5 5-5z" fill="currentColor" />
        </svg>
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="account-switcher-dropdown" role="menu">
          {/* Account List */}
          <div className="accounts-list">
            {accounts.map(account => (
              <div
                key={account.userId}
                className={`account-item ${account.isActive ? 'active' : ''}`}
                role="menuitem"
              >
                <button
                  className="account-select"
                  onClick={() => handleSwitch(account.userId)}
                  disabled={account.isActive || actionLoading !== null}
                >
                  <div className="avatar">
                    {account.avatarUrl ? (
                      <img src={account.avatarUrl} alt="" />
                    ) : (
                      <span>{account.email.charAt(0).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="account-details">
                    <span className="name">{account.name || account.email}</span>
                    <span className="email">{account.email}</span>
                    {account.isActive && (
                      <span className="active-badge">Active</span>
                    )}
                  </div>
                  {actionLoading === `switch-${account.userId}` && (
                    <span className="loading-spinner" />
                  )}
                </button>
                <button
                  className="sign-out-btn"
                  onClick={(e) => handleSignOut(account.userId, e)}
                  disabled={actionLoading !== null}
                  title="Sign out this account"
                  aria-label={`Sign out ${account.email}`}
                >
                  {actionLoading === `signout-${account.userId}` ? (
                    <span className="loading-spinner small" />
                  ) : (
                    <svg viewBox="0 0 24 24" width="16" height="16">
                      <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor" />
                    </svg>
                  )}
                </button>
              </div>
            ))}
          </div>

          {/* Divider */}
          <hr className="divider" />

          {/* Add Account */}
          {canAddAccount && (
            <button
              className="menu-action add-account"
              onClick={handleAddAccount}
              disabled={actionLoading !== null}
              role="menuitem"
            >
              {actionLoading === 'add' ? (
                <span className="loading-spinner" />
              ) : (
                <svg viewBox="0 0 24 24" width="20" height="20">
                  <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" fill="currentColor" />
                </svg>
              )}
              <span>Add another account</span>
            </button>
          )}

          {!canAddAccount && (
            <div className="max-accounts-notice">
              Maximum 3 accounts reached
            </div>
          )}

          {/* Sign Out All */}
          <button
            className="menu-action sign-out-all"
            onClick={handleSignOutAll}
            disabled={actionLoading !== null}
            role="menuitem"
          >
            {actionLoading === 'all' ? (
              <span className="loading-spinner" />
            ) : (
              <svg viewBox="0 0 24 24" width="20" height="20">
                <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z" fill="currentColor" />
              </svg>
            )}
            <span>Sign out of all accounts</span>
          </button>
        </div>
      )}

      <style>{`
        .account-switcher {
          position: relative;
          display: inline-block;
        }

        .account-switcher-trigger {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 8px 12px;
          background: transparent;
          border: 1px solid #e0e0e0;
          border-radius: 12px;
          cursor: pointer;
          transition: all 0.2s ease;
          min-width: 200px;
        }

        .account-switcher-trigger:hover {
          background: #f5f5f5;
          border-color: #ccc;
        }

        .avatar {
          width: 40px;
          height: 40px;
          border-radius: 50%;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 600;
          font-size: 16px;
          flex-shrink: 0;
          overflow: hidden;
        }

        .avatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .account-info {
          flex: 1;
          text-align: left;
          overflow: hidden;
        }

        .account-info .name {
          display: block;
          font-weight: 500;
          color: #333;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .account-info .email {
          display: block;
          font-size: 12px;
          color: #666;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .chevron {
          transition: transform 0.2s ease;
          color: #666;
        }

        .chevron.open {
          transform: rotate(180deg);
        }

        .account-switcher-dropdown {
          position: absolute;
          top: calc(100% + 8px);
          right: 0;
          min-width: 320px;
          background: white;
          border-radius: 16px;
          box-shadow: 0 10px 40px rgba(0, 0, 0, 0.15);
          z-index: 1000;
          overflow: hidden;
          animation: dropdown-appear 0.2s ease;
        }

        @keyframes dropdown-appear {
          from {
            opacity: 0;
            transform: translateY(-8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .accounts-list {
          padding: 8px;
        }

        .account-item {
          display: flex;
          align-items: center;
          padding: 4px;
          border-radius: 12px;
          transition: background 0.2s ease;
        }

        .account-item:hover {
          background: #f5f5f5;
        }

        .account-item.active {
          background: #f0f4ff;
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
          text-align: left;
          border-radius: 8px;
        }

        .account-select:disabled {
          cursor: default;
        }

        .account-details {
          flex: 1;
          overflow: hidden;
        }

        .account-details .name {
          display: block;
          font-weight: 500;
          color: #333;
        }

        .account-details .email {
          display: block;
          font-size: 12px;
          color: #666;
        }

        .active-badge {
          display: inline-block;
          font-size: 10px;
          padding: 2px 8px;
          background: #4caf50;
          color: white;
          border-radius: 4px;
          margin-top: 4px;
        }

        .sign-out-btn {
          padding: 8px;
          background: none;
          border: none;
          color: #999;
          cursor: pointer;
          border-radius: 8px;
          transition: all 0.2s ease;
        }

        .sign-out-btn:hover:not(:disabled) {
          background: #ffebee;
          color: #f44336;
        }

        .divider {
          margin: 8px 16px;
          border: none;
          border-top: 1px solid #e0e0e0;
        }

        .menu-action {
          display: flex;
          align-items: center;
          gap: 12px;
          width: 100%;
          padding: 14px 20px;
          background: none;
          border: none;
          cursor: pointer;
          text-align: left;
          transition: background 0.2s ease;
          color: #333;
        }

        .menu-action:hover:not(:disabled) {
          background: #f5f5f5;
        }

        .menu-action:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .sign-out-all {
          color: #f44336;
        }

        .sign-out-all:hover:not(:disabled) {
          background: #ffebee;
        }

        .max-accounts-notice {
          padding: 12px 20px;
          color: #999;
          font-size: 13px;
          text-align: center;
        }

        .loading-spinner {
          width: 20px;
          height: 20px;
          border: 2px solid #e0e0e0;
          border-top-color: #667eea;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }

        .loading-spinner.small {
          width: 14px;
          height: 14px;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        .account-switcher-skeleton {
          width: 200px;
          height: 56px;
          background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
          background-size: 200% 100%;
          animation: shimmer 1.5s infinite;
          border-radius: 12px;
        }

        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}
```

---

## Phase 4: Cleanup

### 4.1 Remove Legacy Code

After all users have migrated (monitor via analytics):

```typescript
// File: src/utils/cleanup-legacy.ts

/**
 * Checklist for removing legacy auth code:
 *
 * 1. Remove legacy cookie handling
 *    - [ ] Delete functions that read/write per-user token cookies
 *    - [ ] Remove legacyCookiePrefix config
 *    - [ ] Remove getLegacyTokens() calls
 *
 * 2. Remove dual-mode code
 *    - [ ] Remove useNewApi checks
 *    - [ ] Remove legacyHandlers from HybridAuthProvider
 *    - [ ] Rename HybridAuthProvider to AuthProvider
 *
 * 3. Remove migration code
 *    - [ ] Delete AuthMigrationService
 *    - [ ] Delete SessionMigrator
 *    - [ ] Delete MigrationBanner component
 *
 * 4. Update dependencies
 *    - [ ] Remove @alummahnow/auth-client v1.x
 *    - [ ] Ensure @alummahnow/auth-client v2.x is sole version
 *
 * 5. Clean up tests
 *    - [ ] Remove tests for legacy auth flow
 *    - [ ] Remove dual-mode test scenarios
 */

// Final cleanup function - run once migration is complete
export function cleanupLegacyAuth() {
  // Clear any remaining legacy cookies
  const legacyPatterns = [
    /^auth_token_/,
    /^refresh_token_/,
    /^user_session_/,
    // Add your legacy cookie patterns
  ];

  document.cookie.split(';').forEach(cookie => {
    const name = cookie.split('=')[0].trim();
    if (legacyPatterns.some(p => p.test(name))) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
  });

  // Clear legacy localStorage items
  const legacyStorageKeys = [
    'auth_tokens',
    'user_accounts',
    'active_user_id',
    // Add your legacy storage keys
  ];

  legacyStorageKeys.forEach(key => {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  });
}
```

### 4.2 Final AuthProvider (Post-Migration)

```typescript
// File: src/providers/AuthProvider.tsx (final version)

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { AuthClient, Account } from '@alummahnow/auth-client';

interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  accounts: Account[];
  activeAccount: Account | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  switchAccount: (userId: string) => Promise<void>;
  addAccount: () => Promise<void>;
  refreshAccounts: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: ReactNode;
  config: {
    authServerUrl: string;
    clientId: string;
    redirectUri: string;
  };
}

export function AuthProvider({ children, config }: AuthProviderProps) {
  const [authClient] = useState(() => new AuthClient(config));
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccount, setActiveAccount] = useState<Account | null>(null);

  useEffect(() => {
    initializeAuth();
  }, []);

  async function initializeAuth() {
    setIsLoading(true);
    try {
      // Try silent login (SSO)
      await authClient.silentLogin();
      await loadAccounts();
    } catch (error: any) {
      if (error.code !== 'login_required') {
        console.error('Auth initialization failed:', error);
      }
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  }

  async function loadAccounts() {
    const result = await authClient.getAccounts();
    setAccounts(result.accounts);
    setActiveAccount(result.activeAccount);
    setIsAuthenticated(result.accounts.length > 0);
  }

  async function refreshAccounts() {
    await loadAccounts();
  }

  async function login() {
    await authClient.login();
  }

  async function addAccount() {
    await authClient.addAccount();
  }

  async function switchAccount(userId: string) {
    await authClient.switchAccount(userId);
    await loadAccounts();
    window.location.reload();
  }

  async function logout() {
    if (activeAccount) {
      const result = await authClient.signOutAccount(activeAccount.userId);

      if (result.remainingAccounts === 0) {
        setIsAuthenticated(false);
        setAccounts([]);
        setActiveAccount(null);
        window.location.href = '/';
      } else {
        await loadAccounts();
        if (result.wasActive) {
          window.location.reload();
        }
      }
    }
  }

  async function logoutAll() {
    await authClient.signOutAll();
    setIsAuthenticated(false);
    setAccounts([]);
    setActiveAccount(null);
    window.location.href = '/';
  }

  return (
    <AuthContext.Provider value={{
      isAuthenticated,
      isLoading,
      accounts,
      activeAccount,
      login,
      logout,
      logoutAll,
      switchAccount,
      addAccount,
      refreshAccounts,
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

---

## Testing Checklist

### Unit Tests

- [ ] AuthMigrationService detects legacy tokens
- [ ] AuthMigrationService detects new session
- [ ] SessionMigrator migrates tokens correctly
- [ ] SessionMigrator handles max 3 accounts limit
- [ ] AccountSwitcher shows correct UI for each state
- [ ] AccountSwitcher handles loading states
- [ ] AccountSwitcher handles errors

### Integration Tests

- [ ] Hybrid mode works (old + new API)
- [ ] Migration banner appears when needed
- [ ] Migration completes successfully
- [ ] Account switch works in both modes
- [ ] Logout works in both modes
- [ ] Add account works in both modes

### E2E Tests

```typescript
// File: e2e/migration.spec.ts

test.describe('Client Migration', () => {
  test('should detect legacy tokens and show migration banner', async ({ page }) => {
    // Setup: Set legacy token cookies
    await page.context().addCookies([
      { name: 'auth_token_user1', value: 'legacy-token-1', domain: 'localhost', path: '/' },
    ]);

    await page.goto('/');

    // Migration banner should appear
    await expect(page.locator('.migration-banner')).toBeVisible();
  });

  test('should migrate legacy tokens to new session', async ({ page }) => {
    // Setup legacy tokens
    await page.context().addCookies([
      { name: 'auth_token_user1', value: 'legacy-token-1', domain: 'localhost', path: '/' },
      { name: 'refresh_token_user1', value: 'legacy-refresh-1', domain: 'localhost', path: '/' },
    ]);

    await page.goto('/');

    // Click migrate button
    await page.click('.migrate-button');

    // Wait for migration
    await page.waitForSelector('.migration-result.success');

    // Legacy cookies should be cleared
    const cookies = await page.context().cookies();
    expect(cookies.find(c => c.name.startsWith('auth_token_'))).toBeUndefined();
  });

  test('should work with new API after migration', async ({ page }) => {
    // Login first
    await page.goto('/login');
    await page.fill('[name="email"]', 'test@example.com');
    await page.fill('[name="password"]', 'password');
    await page.click('button[type="submit"]');

    // Navigate to app
    await page.waitForURL('/dashboard');

    // Account switcher should work
    await page.click('.account-switcher-trigger');
    await expect(page.locator('.account-switcher-dropdown')).toBeVisible();

    // Should show active account
    await expect(page.locator('.active-badge')).toBeVisible();
  });
});
```

---

## Rollback Plan

If issues arise during migration:

### 1. Disable New Session API

```typescript
// In auth server - disable via feature flag
FF_MULTI_ACCOUNT=false
```

### 2. Revert Client to Legacy-Only Mode

```typescript
// In client - force legacy mode
const forceLegacy = true;

if (forceLegacy) {
  setUseNewApi(false);
}
```

### 3. Restore Legacy Tokens

If users' tokens were cleared but migration failed, they'll need to log in again. Consider keeping legacy tokens for a grace period before clearing.

---

## Monitoring

Track these metrics during migration:

| Metric | Description | Target |
|--------|-------------|--------|
| Migration attempts | Count of migration starts | - |
| Migration success rate | % successful migrations | >95% |
| Legacy API usage | Calls to old auth endpoints | Decreasing |
| New API usage | Calls to new session endpoints | Increasing |
| Error rate | Auth-related errors | <1% |
| User complaints | Support tickets about auth | Minimal |

---

## Timeline Recommendation

| Phase | Duration | Rollout |
|-------|----------|---------|
| Phase 1: Dual Mode | 1-2 weeks | 100% (no user impact) |
| Phase 2: Migration | 2-4 weeks | 10% → 50% → 100% |
| Phase 3: UI Update | 1-2 weeks | Tied to Phase 2 |
| Phase 4: Cleanup | After Phase 3 | After migration stabilizes |

**Total**: 4-8 weeks for full migration
