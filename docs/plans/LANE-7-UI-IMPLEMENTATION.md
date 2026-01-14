# Lane 7: Admin & Profile UI Implementation

## Overview

Comprehensive UI implementation guide for both the Admin Dashboard and Profile Application to support all new identity platform features.

## Priority: P1 (High)
**Dependencies**: Lane 1, Lane 3 (for APIs)
**Can Run Parallel With**: Lane 4, Lane 5, Lane 6 (backend work)

---

## UI Architecture: Auth App vs Profile App

### Clear Separation of Concerns

The identity platform has **three apps** with distinct UI responsibilities:

| App | Purpose | URL | Account Management UI |
|-----|---------|-----|----------------------|
| **Auth** | OAuth/OIDC flows, login | auth.example.com | Account Picker (during login) |
| **Profile** | User settings, security | profile.example.com | AccountSwitcher (dropdown) |
| **Admin** | System administration | admin.example.com | Session management |

### Account Picker vs AccountSwitcher

These are **two different components** for different contexts:

#### Account Picker (Auth App)

**Purpose**: Full-page UI shown during OAuth authorize flow when user has multiple accounts

**When shown**:
- `prompt=select_account` parameter in authorize request
- User has multiple accounts AND no `account_hint` provided
- Attempting to add 4th account (show existing + "sign in as different user")

**Features**:
- Full page, centered card design
- List all logged-in accounts
- "Use another account" option to log in as new user
- Redirect back to authorize flow after selection
- Error display for max accounts reached

```
┌─────────────────────────────────────────┐
│                                         │
│          Choose an account              │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │ [Avatar] user1@example.com      │   │
│  │          Last used: 2 min ago   │   │
│  └─────────────────────────────────┘   │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │ [Avatar] user2@example.com      │   │
│  │          Last used: 1 day ago   │   │
│  └─────────────────────────────────┘   │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │ [+] Use another account         │   │
│  └─────────────────────────────────┘   │
│                                         │
└─────────────────────────────────────────┘
```

#### AccountSwitcher (Profile App)

**Purpose**: Dropdown component for quick account switching in header/navbar

**When shown**:
- Always visible in Profile app header when user has multiple accounts
- Shows current active account with dropdown to switch

**Features**:
- Compact dropdown component
- Shows active account prominently
- Quick switch without page navigation
- "Add account" option
- "Sign out all" option
- Sign out individual accounts

```
┌──────────────────────────────────┐
│ [Avatar] user1@example.com    ▼  │
└──────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│  SIGNED IN ACCOUNTS              │
│  ────────────────────────────    │
│  ● user1@example.com  (Active)   │
│  ○ user2@example.com  [×]        │
│  ○ user3@example.com  [×]        │
│  ────────────────────────────    │
│  [+] Add another account         │
│  [↪] Sign out of all accounts    │
└──────────────────────────────────┘
```

### Flow Comparison

**Account Picker Flow (Auth App)**:
```
Client App → /authorize?prompt=select_account
    ↓
Auth App shows Account Picker page
    ↓
User selects account
    ↓
Auth App processes authorize with selected account
    ↓
Redirect back to Client App with tokens
```

**AccountSwitcher Flow (Profile App)**:
```
User is in Profile App
    ↓
User clicks dropdown in header
    ↓
User selects different account
    ↓
POST /session/switch { userId }
    ↓
Page reloads with new active account context
```

---

## Auth Application UI (apps/auth)

### Account Picker Page

**File**: `apps/auth/src/routes/account-picker.tsx`

This is a full-page component shown during the OAuth authorize flow.

```tsx
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from '@react-router/cloudflare';
import { useLoaderData, useFetcher, useSearchParams } from 'react-router';
import { BrowserSessionService } from '../services/browser-session.service';
import { parseSessionCookie } from '../utils/session-cookie';

export async function loader({ request, context }: LoaderFunctionArgs) {
  const { env } = context.cloudflare;
  const url = new URL(request.url);

  // Get OAuth parameters to preserve through account selection
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  const state = url.searchParams.get('state');
  const scope = url.searchParams.get('scope');
  const responseType = url.searchParams.get('response_type');

  // Mode: 'max_reached' when user has 3 accounts and wants to add another
  const mode = url.searchParams.get('mode');

  // Get browser session and accounts
  const cookieHeader = request.headers.get('Cookie');
  const sessionToken = parseSessionCookie(cookieHeader);

  if (!sessionToken) {
    // No session, redirect to login
    return redirect(`/login?${url.searchParams}`);
  }

  const browserSessionService = new BrowserSessionService(env.AUTH_DB);
  const sessionWithAccounts = await browserSessionService.getBrowserSessionWithAccounts(sessionToken);

  if (!sessionWithAccounts || sessionWithAccounts.accounts.length === 0) {
    return redirect(`/login?${url.searchParams}`);
  }

  return json({
    accounts: sessionWithAccounts.accounts,
    maxAccounts: 3,
    canAddAccount: sessionWithAccounts.accounts.length < 3,
    isMaxReached: mode === 'max_reached',
    oauthParams: { clientId, redirectUri, state, scope, responseType },
  });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const { env } = context.cloudflare;
  const formData = await request.formData();
  const userId = formData.get('userId') as string;
  const oauthParams = JSON.parse(formData.get('oauthParams') as string);

  // Set the selected account as active and continue authorize flow
  const cookieHeader = request.headers.get('Cookie');
  const sessionToken = parseSessionCookie(cookieHeader);

  if (sessionToken && userId) {
    const accountSessionService = new AccountSessionService(env.AUTH_DB);
    const browserSessionService = new BrowserSessionService(env.AUTH_DB);

    const browserSession = await browserSessionService.getBrowserSessionByToken(sessionToken);
    if (browserSession) {
      await accountSessionService.setActiveAccountByUserId(browserSession.id, userId);
    }
  }

  // Rebuild authorize URL with account_hint to skip picker on retry
  const authorizeUrl = new URL('/authorize', request.url);
  authorizeUrl.searchParams.set('client_id', oauthParams.clientId);
  authorizeUrl.searchParams.set('redirect_uri', oauthParams.redirectUri);
  authorizeUrl.searchParams.set('response_type', oauthParams.responseType || 'code');
  authorizeUrl.searchParams.set('account_hint', userId);
  if (oauthParams.state) authorizeUrl.searchParams.set('state', oauthParams.state);
  if (oauthParams.scope) authorizeUrl.searchParams.set('scope', oauthParams.scope);

  return redirect(authorizeUrl.toString());
}

export default function AccountPickerPage() {
  const { accounts, canAddAccount, isMaxReached, oauthParams } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const [signingOut, setSigningOut] = useState<string | null>(null);

  const isSubmitting = fetcher.state !== 'idle';

  function handleSelectAccount(userId: string) {
    fetcher.submit(
      { userId, oauthParams: JSON.stringify(oauthParams) },
      { method: 'post' }
    );
  }

  function handleUseAnotherAccount() {
    // Redirect to login with prompt=login to force new authentication
    const loginUrl = new URL('/authorize', window.location.origin);
    loginUrl.searchParams.set('client_id', oauthParams.clientId);
    loginUrl.searchParams.set('redirect_uri', oauthParams.redirectUri);
    loginUrl.searchParams.set('response_type', oauthParams.responseType || 'code');
    loginUrl.searchParams.set('prompt', 'login');
    if (oauthParams.state) loginUrl.searchParams.set('state', oauthParams.state);
    if (oauthParams.scope) loginUrl.searchParams.set('scope', oauthParams.scope);

    window.location.href = loginUrl.toString();
  }

  async function handleSignOutAndAddNew(userId: string) {
    setSigningOut(userId);
    try {
      // Sign out the selected account
      await fetch(`/session/accounts/${userId}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      // Now redirect to login - user can add new account
      handleUseAnotherAccount();
    } catch (error) {
      console.error('Failed to sign out', error);
      setSigningOut(null);
    }
  }

  return (
    <div className="account-picker-page">
      <div className="picker-container">
        <div className="picker-header">
          <h1>Choose an account</h1>
          <p>to continue to <strong>{oauthParams.clientId}</strong></p>
        </div>

        {/* Info banner when max accounts reached */}
        {isMaxReached && (
          <div className="info-banner">
            <span className="info-icon">ℹ️</span>
            <span>
              You have 3 accounts signed in. Select one below, or sign out of
              an account to use a different one.
            </span>
          </div>
        )}

        {/* Account selection list */}
        <div className="accounts-list">
          {accounts.map((account) => (
            <div key={account.userId} className="account-row">
              <button
                onClick={() => handleSelectAccount(account.userId)}
                disabled={isSubmitting || signingOut !== null}
                className="account-option"
              >
                <div
                  className="avatar"
                  style={{ backgroundColor: getAvatarColor(account.user.email) }}
                >
                  {account.user.email.charAt(0).toUpperCase()}
                </div>
                <div className="account-info">
                  <span className="email">{account.user.email}</span>
                  <span className="last-used">
                    {account.isActive ? 'Currently active' : `Last used ${formatRelativeTime(account.lastUsed)}`}
                  </span>
                </div>
                {account.isActive && (
                  <span className="active-badge">Active</span>
                )}
              </button>

              {/* Sign out button shown when max reached */}
              {isMaxReached && (
                <button
                  onClick={() => handleSignOutAndAddNew(account.userId)}
                  disabled={signingOut !== null}
                  className="sign-out-btn"
                  title="Sign out and use different account"
                >
                  {signingOut === account.userId ? (
                    <span className="spinner-small" />
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
                    </svg>
                  )}
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Add another account - only when under limit */}
        {canAddAccount && (
          <button
            onClick={handleUseAnotherAccount}
            disabled={isSubmitting}
            className="add-account-option"
          >
            <div className="icon-wrapper">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                <path d="M10 5a1 1 0 011 1v3h3a1 1 0 110 2h-3v3a1 1 0 11-2 0v-3H6a1 1 0 110-2h3V6a1 1 0 011-1z" />
              </svg>
            </div>
            <span>Use another account</span>
          </button>
        )}

        {/* Helper text when at max */}
        {isMaxReached && (
          <div className="helper-text">
            <p>Click the × next to an account to sign out and add a different one.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function getAvatarColor(email: string): string {
  const colors = ['#1976d2', '#388e3c', '#d32f2f', '#7b1fa2', '#f57c00', '#0097a7'];
  return colors[email.charCodeAt(0) % colors.length];
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)} hours ago`;
  return `${Math.floor(diffMins / 1440)} days ago`;
}
```

**Styles**: `apps/auth/src/routes/account-picker.css`

```css
.account-picker-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary, #f5f5f5);
  padding: 20px;
}

.picker-container {
  width: 100%;
  max-width: 400px;
  background: white;
  border-radius: 16px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.1);
  padding: 32px;
}

.picker-header {
  text-align: center;
  margin-bottom: 24px;
}

.picker-header h1 {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary, #212121);
  margin: 0 0 8px 0;
}

.picker-header p {
  font-size: 14px;
  color: var(--text-secondary, #757575);
  margin: 0;
}

.info-banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px 16px;
  background: #e3f2fd;
  border: 1px solid #90caf9;
  border-radius: 8px;
  margin-bottom: 16px;
  font-size: 14px;
  color: #1565c0;
  line-height: 1.4;
}

.info-icon {
  flex-shrink: 0;
}

.accounts-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}

.account-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.account-row .sign-out-btn {
  padding: 10px;
  background: none;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--text-secondary, #757575);
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.account-row .sign-out-btn:hover:not(:disabled) {
  background: #ffebee;
  border-color: #ef9a9a;
  color: #c62828;
}

.account-row .sign-out-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinner-small {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid #e0e0e0;
  border-top-color: #1976d2;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.account-option {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 16px;
  background: none;
  border: 1px solid var(--border-color, #e0e0e0);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: left;
}

.account-option:hover:not(:disabled) {
  background: var(--hover-bg, #f5f5f5);
  border-color: var(--primary-color, #1976d2);
}

.account-option:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: 600;
  font-size: 16px;
  flex-shrink: 0;
}

.account-info {
  flex: 1;
  min-width: 0;
}

.account-info .email {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary, #212121);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.account-info .last-used {
  display: block;
  font-size: 12px;
  color: var(--text-secondary, #757575);
}

.active-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--success-color, #4caf50);
  background: var(--success-bg, #e8f5e9);
  padding: 4px 8px;
  border-radius: 4px;
}

.add-account-option {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 16px;
  background: none;
  border: 1px dashed var(--border-color, #e0e0e0);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 14px;
  color: var(--primary-color, #1976d2);
}

.add-account-option:hover:not(:disabled) {
  background: var(--primary-light, #e3f2fd);
  border-color: var(--primary-color, #1976d2);
}

.icon-wrapper {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--primary-light, #e3f2fd);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--primary-color, #1976d2);
}

.helper-text {
  text-align: center;
  padding: 12px 16px;
  font-size: 13px;
  color: var(--text-secondary, #757575);
  border-top: 1px solid var(--border-color, #e0e0e0);
  margin-top: 8px;
}

.helper-text p {
  margin: 0;
}
```

---

## Admin Dashboard UI (apps/admin)

### New Pages Required

| Page | Route | Description |
|------|-------|-------------|
| Sessions Dashboard | `/sessions` | Overview of all active sessions |
| User Sessions | `/users/:id/sessions` | Manage specific user's sessions |
| OAuth Clients | `/clients` | ✅ Exists - needs enhancements |
| Tenant Management | `/tenants` | Multi-tenant admin (Phase 3) |
| Security Alerts | `/security` | Suspicious activity monitoring |

---

### 1. Sessions Dashboard Page

**File**: `apps/admin/app/routes/sessions._index.tsx`

```tsx
import { json, type LoaderFunctionArgs } from '@react-router/cloudflare';
import { useLoaderData, useSearchParams, Link } from 'react-router';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import {
  Users,
  Monitor,
  Smartphone,
  Tablet,
  Activity,
  AlertTriangle,
  Clock,
  Globe,
} from 'lucide-react';

export async function loader({ request, context }: LoaderFunctionArgs) {
  const { env } = context.cloudflare;
  const url = new URL(request.url);

  const [sessionsRes, statsRes, suspiciousRes] = await Promise.all([
    fetch(`${env.AUTH_API_URL}/admin/sessions?${url.searchParams}`, {
      headers: { Authorization: `Bearer ${env.AUTH_TOKEN}` },
    }),
    fetch(`${env.AUTH_API_URL}/admin/sessions/stats`, {
      headers: { Authorization: `Bearer ${env.AUTH_TOKEN}` },
    }),
    fetch(`${env.AUTH_API_URL}/admin/sessions/suspicious`, {
      headers: { Authorization: `Bearer ${env.AUTH_TOKEN}` },
    }),
  ]);

  return json({
    sessions: await sessionsRes.json(),
    stats: await statsRes.json(),
    suspicious: await suspiciousRes.json(),
  });
}

export default function SessionsDashboard() {
  const { sessions, stats, suspicious } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const hasSuspiciousActivity =
    suspicious.multipleIPsInShortTime?.length > 0 ||
    suspicious.failedThenSuccessfulLogins?.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Session Management</h1>
          <p className="text-muted-foreground">
            Monitor and manage active user sessions
          </p>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Sessions</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalSessions}</div>
            <p className="text-xs text-muted-foreground">Across all users</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Active Now</CardTitle>
            <Activity className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {stats.activeSessions}
            </div>
            <p className="text-xs text-muted-foreground">In last hour</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Today's Logins</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.loginsLast24h}</div>
            <p className="text-xs text-muted-foreground">Last 24 hours</p>
          </CardContent>
        </Card>

        <Card className={hasSuspiciousActivity ? 'border-orange-500 bg-orange-50' : ''}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Suspicious</CardTitle>
            <AlertTriangle
              className={`h-4 w-4 ${hasSuspiciousActivity ? 'text-orange-500' : 'text-muted-foreground'}`}
            />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {(suspicious.multipleIPsInShortTime?.length || 0) +
                (suspicious.failedThenSuccessfulLogins?.length || 0)}
            </div>
            <p className="text-xs text-muted-foreground">Needs review</p>
          </CardContent>
        </Card>
      </div>

      {/* Device Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Sessions by Device Type</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-100">
                <Monitor className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <div className="font-semibold">{stats.deviceBreakdown?.desktop || 0}</div>
                <div className="text-sm text-muted-foreground">Desktop</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-100">
                <Smartphone className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <div className="font-semibold">{stats.deviceBreakdown?.mobile || 0}</div>
                <div className="text-sm text-muted-foreground">Mobile</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-100">
                <Tablet className="h-5 w-5 text-purple-600" />
              </div>
              <div>
                <div className="font-semibold">{stats.deviceBreakdown?.tablet || 0}</div>
                <div className="text-sm text-muted-foreground">Tablet</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-gray-100">
                <Globe className="h-5 w-5 text-gray-600" />
              </div>
              <div>
                <div className="font-semibold">{stats.deviceBreakdown?.unknown || 0}</div>
                <div className="text-sm text-muted-foreground">Unknown</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Suspicious Activity Alert */}
      {hasSuspiciousActivity && (
        <Card className="border-orange-500 bg-orange-50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-orange-700">
              <AlertTriangle className="h-5 w-5" />
              Suspicious Activity Detected
            </CardTitle>
            <CardDescription>
              The following accounts may require investigation
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {suspicious.multipleIPsInShortTime?.length > 0 && (
              <div>
                <h4 className="font-medium mb-2">Multiple IPs in Short Time</h4>
                <div className="space-y-2">
                  {suspicious.multipleIPsInShortTime.map((item: any) => (
                    <div
                      key={item.userId}
                      className="flex items-center justify-between p-2 bg-white rounded border"
                    >
                      <div>
                        <Link
                          to={`/users/${item.userId}/sessions`}
                          className="font-medium text-blue-600 hover:underline"
                        >
                          {item.email}
                        </Link>
                        <p className="text-sm text-muted-foreground">
                          {item.ipCount} different IPs in 24 hours
                        </p>
                      </div>
                      <Button variant="outline" size="sm" asChild>
                        <Link to={`/users/${item.userId}/sessions`}>
                          Investigate
                        </Link>
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {suspicious.failedThenSuccessfulLogins?.length > 0 && (
              <div>
                <h4 className="font-medium mb-2">Failed Attempts Before Success</h4>
                <div className="space-y-2">
                  {suspicious.failedThenSuccessfulLogins.map((item: any) => (
                    <div
                      key={item.userId}
                      className="flex items-center justify-between p-2 bg-white rounded border"
                    >
                      <div>
                        <Link
                          to={`/users/${item.userId}/sessions`}
                          className="font-medium text-blue-600 hover:underline"
                        >
                          {item.email}
                        </Link>
                        <p className="text-sm text-muted-foreground">
                          {item.failedAttempts} failed attempts before successful login
                        </p>
                      </div>
                      <Button variant="outline" size="sm" asChild>
                        <Link to={`/users/${item.userId}/sessions`}>
                          Investigate
                        </Link>
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Sessions Table */}
      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle>Active Sessions</CardTitle>
            <div className="flex gap-2">
              <Select
                value={searchParams.get('device_type') || 'all'}
                onValueChange={(value) => {
                  const params = new URLSearchParams(searchParams);
                  if (value && value !== 'all') {
                    params.set('device_type', value);
                  } else {
                    params.delete('device_type');
                  }
                  setSearchParams(params);
                }}
              >
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Device type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Devices</SelectItem>
                  <SelectItem value="desktop">Desktop</SelectItem>
                  <SelectItem value="mobile">Mobile</SelectItem>
                  <SelectItem value="tablet">Tablet</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Device</TableHead>
                <TableHead>IP Address</TableHead>
                <TableHead>Last Active</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.sessions?.map((session: any) => (
                <TableRow key={session.id}>
                  <TableCell>
                    <Link
                      to={`/users/${session.userId}`}
                      className="font-medium text-blue-600 hover:underline"
                    >
                      {session.email}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {session.device.type === 'mobile' && <Smartphone className="h-4 w-4" />}
                      {session.device.type === 'desktop' && <Monitor className="h-4 w-4" />}
                      {session.device.type === 'tablet' && <Tablet className="h-4 w-4" />}
                      <span className="text-sm">{session.device.name}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <code className="text-sm">{session.device.ipAddress}</code>
                  </TableCell>
                  <TableCell>
                    {new Date(session.lastUsed).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {session.isActive ? (
                      <Badge className="bg-green-500">Active</Badge>
                    ) : (
                      <Badge variant="secondary">Idle</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" asChild>
                      <Link to={`/users/${session.userId}/sessions`}>
                        Manage
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
```

---

### 2. User Sessions Page

**File**: `apps/admin/app/routes/users.$id.sessions.tsx`

```tsx
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from '@react-router/cloudflare';
import { useLoaderData, useFetcher, Link, useNavigate } from 'react-router';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';
import { Button } from '~/components/ui/button';
import { Badge } from '~/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '~/components/ui/alert-dialog';
import {
  Laptop,
  Smartphone,
  Tablet,
  Globe,
  Clock,
  MapPin,
  LogOut,
  AlertTriangle,
  ArrowLeft,
  Shield,
} from 'lucide-react';
import { useToast } from '~/hooks/use-toast';

interface Session {
  id: string;
  browserSessionId: string;
  authenticatedAt: string;
  authMethod: string;
  lastUsed: string;
  isActive: boolean;
  expiresAt: string;
  device: {
    type: string;
    name: string;
    ipAddress: string;
    userAgent: string;
  };
  lastActivity: string;
}

export async function loader({ params, context }: LoaderFunctionArgs) {
  const { id } = params;
  const { env } = context.cloudflare;

  const response = await fetch(`${env.AUTH_API_URL}/admin/users/${id}/sessions`, {
    headers: { Authorization: `Bearer ${env.AUTH_TOKEN}` },
  });

  if (!response.ok) {
    throw new Response('User not found', { status: 404 });
  }

  return json(await response.json());
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  const { id } = params;
  const { env } = context.cloudflare;
  const formData = await request.formData();
  const intent = formData.get('intent');
  const sessionId = formData.get('sessionId');

  let endpoint: string;
  let method: string;
  let body: string | undefined;

  switch (intent) {
    case 'terminate-session':
      endpoint = `/admin/users/${id}/sessions/${sessionId}`;
      method = 'DELETE';
      break;
    case 'terminate-all':
      endpoint = `/admin/users/${id}/sessions`;
      method = 'DELETE';
      break;
    case 'force-logout':
      endpoint = `/admin/users/${id}/force-logout`;
      method = 'POST';
      body = JSON.stringify({ reason: 'Admin initiated force logout' });
      break;
    default:
      return json({ error: 'Invalid action' }, { status: 400 });
  }

  const response = await fetch(`${env.AUTH_API_URL}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  const result = await response.json();

  if (!response.ok) {
    return json({ success: false, error: result.error }, { status: response.status });
  }

  return json({ success: true, ...result });
}

function DeviceIcon({ type }: { type: string }) {
  const iconClass = 'h-5 w-5';
  switch (type) {
    case 'mobile':
      return <Smartphone className={iconClass} />;
    case 'tablet':
      return <Tablet className={iconClass} />;
    case 'desktop':
      return <Laptop className={iconClass} />;
    default:
      return <Globe className={iconClass} />;
  }
}

function formatRelativeTime(dateString: string) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString();
}

export default function UserSessions() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const { toast } = useToast();

  const isLoading = fetcher.state !== 'idle';

  // Handle action results
  if (fetcher.data?.success) {
    toast({
      title: 'Success',
      description: fetcher.data.message || 'Action completed successfully',
    });
  } else if (fetcher.data?.error) {
    toast({
      title: 'Error',
      description: fetcher.data.error,
      variant: 'destructive',
    });
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          <div>
            <h1 className="text-2xl font-bold">User Sessions</h1>
            <p className="text-muted-foreground">{data.email}</p>
          </div>
        </div>

        <div className="flex gap-2">
          {/* Terminate All Sessions */}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" disabled={data.sessions.length === 0}>
                <LogOut className="h-4 w-4 mr-2" />
                Terminate All
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Terminate All Sessions?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will sign out <strong>{data.email}</strong> from all {data.totalSessions} devices.
                  They will need to sign in again.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="terminate-all" />
                  <AlertDialogAction type="submit" disabled={isLoading}>
                    {isLoading ? 'Terminating...' : 'Terminate All'}
                  </AlertDialogAction>
                </fetcher.Form>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* Force Logout */}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive">
                <Shield className="h-4 w-4 mr-2" />
                Force Logout
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle className="flex items-center gap-2 text-destructive">
                  <AlertTriangle className="h-5 w-5" />
                  Force Logout User?
                </AlertDialogTitle>
                <AlertDialogDescription className="space-y-2">
                  <p>
                    This is a <strong>critical security action</strong> that will:
                  </p>
                  <ul className="list-disc list-inside space-y-1 text-sm">
                    <li>Immediately terminate ALL browser sessions</li>
                    <li>Revoke ALL access and refresh tokens</li>
                    <li>Force user to re-authenticate on every device</li>
                    <li>Log this action in the security audit trail</li>
                  </ul>
                  <p className="mt-2 text-sm font-medium">
                    Use this when you suspect account compromise.
                  </p>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="force-logout" />
                  <AlertDialogAction
                    type="submit"
                    className="bg-destructive hover:bg-destructive/90"
                    disabled={isLoading}
                  >
                    {isLoading ? 'Processing...' : 'Force Logout'}
                  </AlertDialogAction>
                </fetcher.Form>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Session Summary */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Sessions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{data.totalSessions}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Desktop</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">
              {data.sessions.filter((s: Session) => s.device.type === 'desktop').length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Mobile</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">
              {data.sessions.filter((s: Session) => s.device.type === 'mobile').length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Active Now</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-green-600">
              {data.sessions.filter((s: Session) => s.isActive).length}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Sessions List */}
      {data.sessions.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Globe className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium">No Active Sessions</h3>
            <p className="text-muted-foreground">
              This user has no active sessions.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {data.sessions.map((session: Session) => (
            <Card
              key={session.id}
              className={session.isActive ? 'border-l-4 border-l-green-500' : ''}
            >
              <CardHeader>
                <div className="flex justify-between items-start">
                  <div className="flex items-center gap-4">
                    <div className={`p-3 rounded-lg ${
                      session.device.type === 'mobile' ? 'bg-green-100' :
                      session.device.type === 'desktop' ? 'bg-blue-100' :
                      'bg-gray-100'
                    }`}>
                      <DeviceIcon type={session.device.type} />
                    </div>
                    <div>
                      <CardTitle className="text-base flex items-center gap-2">
                        {session.device.name}
                        {session.isActive && (
                          <Badge className="bg-green-500 text-xs">Active Now</Badge>
                        )}
                      </CardTitle>
                      <CardDescription className="mt-1">
                        {session.device.userAgent?.substring(0, 80)}...
                      </CardDescription>
                    </div>
                  </div>

                  {/* Terminate Session Button */}
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="sm" className="text-destructive">
                        <LogOut className="h-4 w-4 mr-2" />
                        Terminate
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Terminate Session?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will sign out the user from <strong>{session.device.name}</strong>.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <fetcher.Form method="post">
                          <input type="hidden" name="intent" value="terminate-session" />
                          <input type="hidden" name="sessionId" value={session.id} />
                          <AlertDialogAction type="submit" disabled={isLoading}>
                            Terminate
                          </AlertDialogAction>
                        </fetcher.Form>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <div className="flex items-center gap-2 text-muted-foreground mb-1">
                      <MapPin className="h-4 w-4" />
                      IP Address
                    </div>
                    <code className="text-sm">{session.device.ipAddress}</code>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 text-muted-foreground mb-1">
                      <Clock className="h-4 w-4" />
                      Last Active
                    </div>
                    <span>{formatRelativeTime(session.lastUsed)}</span>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-1">Authenticated</div>
                    <span>{new Date(session.authenticatedAt).toLocaleDateString()}</span>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-1">Expires</div>
                    <span>{new Date(session.expiresAt).toLocaleDateString()}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

### 3. OAuth Clients Enhancement

**File**: `apps/admin/app/routes/clients._index.tsx` (enhance existing)

Add client permissions management:

```tsx
// Add to existing clients page - Permission Management Tab
function ClientPermissions({ clientId }: { clientId: string }) {
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [allPermissions, setAllPermissions] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPermissions();
  }, [clientId]);

  async function loadPermissions() {
    const [clientPerms, allPerms] = await Promise.all([
      fetch(`/api/admin/clients/${clientId}/permissions`).then(r => r.json()),
      fetch(`/api/admin/permissions`).then(r => r.json()),
    ]);
    setPermissions(clientPerms.permissions);
    setAllPermissions(allPerms.permissions);
    setLoading(false);
  }

  async function togglePermission(permissionId: string, granted: boolean) {
    if (granted) {
      await fetch(`/api/admin/clients/${clientId}/permissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissionIds: [permissionId] }),
      });
    } else {
      await fetch(`/api/admin/clients/${clientId}/permissions/${permissionId}`, {
        method: 'DELETE',
      });
    }
    await loadPermissions();
  }

  const grantedIds = new Set(permissions.map(p => p.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Client Permissions</CardTitle>
        <CardDescription>
          Permissions this client can request for users. Users will only get
          permissions they have AND the client has.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {/* Group permissions by resource */}
          {Object.entries(groupBy(allPermissions, 'resource')).map(([resource, perms]) => (
            <div key={resource}>
              <h4 className="font-medium mb-2 capitalize">{resource}</h4>
              <div className="grid grid-cols-2 gap-2">
                {perms.map((perm: Permission) => (
                  <div key={perm.id} className="flex items-center gap-2">
                    <Checkbox
                      id={perm.id}
                      checked={grantedIds.has(perm.id)}
                      onCheckedChange={(checked) => togglePermission(perm.id, !!checked)}
                    />
                    <label htmlFor={perm.id} className="text-sm">
                      {perm.name}
                      <span className="text-muted-foreground ml-1">({perm.action})</span>
                    </label>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
```

---

### 4. Navigation Updates

**File**: `apps/admin/app/components/sidebar.tsx`

```tsx
// Add to navigation items
const navigationItems = [
  { name: 'Dashboard', href: '/', icon: Home },
  { name: 'Users', href: '/users', icon: Users },
  { name: 'Roles', href: '/roles', icon: Shield },
  { name: 'Sessions', href: '/sessions', icon: Activity },  // NEW
  { name: 'OAuth Clients', href: '/clients', icon: Key },
  { name: 'Audit Logs', href: '/audit', icon: FileText },
  // Phase 3
  // { name: 'Tenants', href: '/tenants', icon: Building },
];
```

---

## Profile Application UI (apps/profile)

### New Components Required

| Component | Description |
|-----------|-------------|
| AccountSwitcher | Switch between logged-in accounts |
| SessionsList | View and manage active sessions |
| DeviceCard | Display device/session info |
| SecuritySettings | Security preferences |

---

### 1. Account Switcher Component

**File**: `apps/profile/src/components/AccountSwitcher.tsx`

```tsx
import { useState, useEffect, useRef } from 'react';

interface Account {
  userId: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  isActive: boolean;
  lastUsed: string;
}

interface AccountSwitcherProps {
  authUrl: string;
  clientId: string;
  onAccountChange?: () => void;
}

export function AccountSwitcher({ authUrl, clientId, onAccountChange }: AccountSwitcherProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeAccount = accounts.find(a => a.isActive);
  const canAddAccount = accounts.length < 3;

  useEffect(() => {
    loadAccounts();

    // Close dropdown on outside click
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  async function loadAccounts() {
    try {
      const response = await fetch(`${authUrl}/session/accounts`, {
        credentials: 'include',
      });
      const data = await response.json();
      setAccounts(data.accounts);
    } catch (error) {
      console.error('Failed to load accounts', error);
    } finally {
      setLoading(false);
    }
  }

  async function handleSwitch(userId: string) {
    setLoading(true);
    try {
      await fetch(`${authUrl}/session/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId }),
      });

      // Reload to get new tokens
      window.location.reload();
    } catch (error) {
      console.error('Failed to switch account', error);
      setLoading(false);
    }
  }

  async function handleSignOut(userId: string, event: React.MouseEvent) {
    event.stopPropagation();

    try {
      const response = await fetch(`${authUrl}/session/accounts/${userId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const result = await response.json();

      if (result.remainingAccounts === 0) {
        window.location.href = '/';
      } else {
        await loadAccounts();
        if (result.wasActive) {
          onAccountChange?.();
          window.location.reload();
        }
      }
    } catch (error) {
      console.error('Failed to sign out', error);
    }
  }

  async function handleAddAccount() {
    const redirectUri = encodeURIComponent(window.location.href);
    window.location.href = `${authUrl}/authorize?client_id=${clientId}&action=add_account&redirect_uri=${redirectUri}`;
  }

  async function handleSignOutAll() {
    try {
      await fetch(`${authUrl}/session/all`, {
        method: 'DELETE',
        credentials: 'include',
      });
      window.location.href = '/';
    } catch (error) {
      console.error('Failed to sign out all', error);
    }
  }

  if (loading || !activeAccount) {
    return (
      <div className="account-switcher">
        <div className="account-trigger loading">
          <div className="avatar skeleton"></div>
          <span className="email skeleton"></span>
        </div>
      </div>
    );
  }

  return (
    <div className="account-switcher" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="account-trigger"
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        <div className="avatar" style={{ backgroundColor: getAvatarColor(activeAccount.email) }}>
          {getInitials(activeAccount.email)}
        </div>
        <div className="account-info">
          <span className="email">{activeAccount.email}</span>
          {accounts.length > 1 && (
            <span className="account-count">{accounts.length} accounts</span>
          )}
        </div>
        <svg
          className={`chevron ${isOpen ? 'open' : ''}`}
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
        >
          <path
            d="M2.5 4.5L6 8L9.5 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {isOpen && (
        <div className="account-dropdown" role="menu">
          <div className="dropdown-header">
            <span className="header-text">Signed in accounts</span>
          </div>

          <div className="accounts-list">
            {accounts.map(account => (
              <div
                key={account.userId}
                className={`account-item ${account.isActive ? 'active' : ''}`}
                role="menuitem"
              >
                <button
                  onClick={() => !account.isActive && handleSwitch(account.userId)}
                  className="account-select"
                  disabled={account.isActive}
                >
                  <div
                    className="avatar"
                    style={{ backgroundColor: getAvatarColor(account.email) }}
                  >
                    {getInitials(account.email)}
                  </div>
                  <div className="account-details">
                    <span className="email">{account.email}</span>
                    <span className="status">
                      {account.isActive ? 'Active' : `Last used ${formatRelativeTime(account.lastUsed)}`}
                    </span>
                  </div>
                  {account.isActive && (
                    <span className="active-indicator">
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                      </svg>
                    </span>
                  )}
                </button>
                <button
                  onClick={(e) => handleSignOut(account.userId, e)}
                  className="sign-out-btn"
                  title="Sign out this account"
                  aria-label={`Sign out ${account.email}`}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
                  </svg>
                </button>
              </div>
            ))}
          </div>

          <div className="dropdown-divider" />

          {canAddAccount && (
            <button onClick={handleAddAccount} className="dropdown-action">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z" />
              </svg>
              Add another account
            </button>
          )}

          <button onClick={handleSignOutAll} className="dropdown-action danger">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2 2.75A.75.75 0 012.75 2h10.5a.75.75 0 010 1.5H2.75A.75.75 0 012 2.75zm0 10.5a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75zM2.75 7a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z" />
            </svg>
            Sign out of all accounts
          </button>
        </div>
      )}
    </div>
  );
}

// Helper functions
function getInitials(email: string): string {
  return email.charAt(0).toUpperCase();
}

function getAvatarColor(email: string): string {
  const colors = ['#1976d2', '#388e3c', '#d32f2f', '#7b1fa2', '#f57c00', '#0097a7'];
  const index = email.charCodeAt(0) % colors.length;
  return colors[index];
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
  return `${Math.floor(diffMins / 1440)}d ago`;
}
```

**Styles**: `apps/profile/src/components/AccountSwitcher.css`

```css
.account-switcher {
  position: relative;
  display: inline-block;
}

.account-trigger {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: transparent;
  border: 1px solid var(--border-color, #e0e0e0);
  border-radius: 9999px;
  cursor: pointer;
  transition: all 0.2s ease;
  min-width: 200px;
}

.account-trigger:hover {
  background: var(--hover-bg, #f5f5f5);
  border-color: var(--border-hover, #bdbdbd);
}

.avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: 600;
  font-size: 14px;
  flex-shrink: 0;
}

.account-info {
  flex: 1;
  min-width: 0;
  text-align: left;
}

.account-info .email {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary, #212121);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.account-info .account-count {
  display: block;
  font-size: 12px;
  color: var(--text-secondary, #757575);
}

.chevron {
  color: var(--text-secondary, #757575);
  transition: transform 0.2s ease;
}

.chevron.open {
  transform: rotate(180deg);
}

.account-dropdown {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 320px;
  background: white;
  border-radius: 12px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.12);
  z-index: 1000;
  overflow: hidden;
  animation: dropdownFadeIn 0.15s ease;
}

@keyframes dropdownFadeIn {
  from {
    opacity: 0;
    transform: translateY(-8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.dropdown-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color, #e0e0e0);
}

.header-text {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary, #757575);
}

.accounts-list {
  padding: 8px 0;
}

.account-item {
  display: flex;
  align-items: center;
  padding: 4px 8px;
}

.account-item.active {
  background: var(--active-bg, #e3f2fd);
}

.account-select {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px;
  background: none;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s ease;
  text-align: left;
}

.account-select:not(:disabled):hover {
  background: var(--hover-bg, #f5f5f5);
}

.account-select:disabled {
  cursor: default;
}

.account-details {
  flex: 1;
  min-width: 0;
}

.account-details .email {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary, #212121);
}

.account-details .status {
  display: block;
  font-size: 12px;
  color: var(--text-secondary, #757575);
}

.active-indicator {
  color: var(--success-color, #4caf50);
}

.sign-out-btn {
  padding: 8px;
  background: none;
  border: none;
  color: var(--text-secondary, #757575);
  cursor: pointer;
  border-radius: 6px;
  transition: all 0.2s ease;
  opacity: 0;
}

.account-item:hover .sign-out-btn {
  opacity: 1;
}

.sign-out-btn:hover {
  background: var(--danger-bg, #ffebee);
  color: var(--danger-color, #f44336);
}

.dropdown-divider {
  height: 1px;
  background: var(--border-color, #e0e0e0);
  margin: 8px 16px;
}

.dropdown-action {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: none;
  border: none;
  font-size: 14px;
  color: var(--text-primary, #212121);
  cursor: pointer;
  transition: background 0.2s ease;
}

.dropdown-action:hover {
  background: var(--hover-bg, #f5f5f5);
}

.dropdown-action.danger {
  color: var(--danger-color, #f44336);
}

.dropdown-action.danger:hover {
  background: var(--danger-bg, #ffebee);
}

/* Skeleton loading */
.skeleton {
  background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: 4px;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.avatar.skeleton {
  width: 32px;
  height: 32px;
}

.email.skeleton {
  width: 120px;
  height: 16px;
  display: inline-block;
}
```

---

### 2. Sessions Management Page

**File**: `apps/profile/src/routes/settings.sessions.tsx`

```tsx
import { useState, useEffect } from 'react';
import { DeviceCard } from '../components/DeviceCard';

interface DeviceSession {
  id: string;
  deviceType: string;
  deviceName: string;
  ipAddress: string;
  lastActivity: string;
  createdAt: string;
  isCurrentSession: boolean;
}

export function SessionsSettingsPage() {
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    loadSessions();
  }, []);

  async function loadSessions() {
    try {
      const response = await fetch('/api/session/devices', {
        credentials: 'include',
      });
      const data = await response.json();
      setSessions(data.sessions);
    } catch (error) {
      console.error('Failed to load sessions', error);
    } finally {
      setLoading(false);
    }
  }

  async function handleRevoke(sessionId: string) {
    setRevoking(sessionId);
    try {
      await fetch(`/api/session/devices/${sessionId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      await loadSessions();
    } catch (error) {
      console.error('Failed to revoke session', error);
    } finally {
      setRevoking(null);
    }
  }

  async function handleRevokeAll() {
    if (!confirm('Sign out from all other devices? You will stay signed in on this device.')) {
      return;
    }

    try {
      const otherSessions = sessions.filter(s => !s.isCurrentSession);
      for (const session of otherSessions) {
        await fetch(`/api/session/devices/${session.id}`, {
          method: 'DELETE',
          credentials: 'include',
        });
      }
      await loadSessions();
    } catch (error) {
      console.error('Failed to revoke sessions', error);
    }
  }

  const currentSession = sessions.find(s => s.isCurrentSession);
  const otherSessions = sessions.filter(s => !s.isCurrentSession);

  return (
    <div className="sessions-page">
      <header className="page-header">
        <h1>Active Sessions</h1>
        <p className="description">
          Manage your active sessions across all devices. You can sign out from
          devices you no longer use or don't recognize.
        </p>
      </header>

      {loading ? (
        <div className="loading-state">
          <div className="spinner" />
          <p>Loading sessions...</p>
        </div>
      ) : (
        <>
          {/* Current Session */}
          {currentSession && (
            <section className="session-section">
              <h2>Current Session</h2>
              <DeviceCard
                session={currentSession}
                isCurrent
              />
            </section>
          )}

          {/* Other Sessions */}
          <section className="session-section">
            <div className="section-header">
              <h2>Other Sessions ({otherSessions.length})</h2>
              {otherSessions.length > 0 && (
                <button
                  onClick={handleRevokeAll}
                  className="sign-out-all-btn"
                >
                  Sign out all other devices
                </button>
              )}
            </div>

            {otherSessions.length === 0 ? (
              <div className="empty-state">
                <p>No other active sessions</p>
              </div>
            ) : (
              <div className="sessions-list">
                {otherSessions.map(session => (
                  <DeviceCard
                    key={session.id}
                    session={session}
                    onRevoke={() => handleRevoke(session.id)}
                    isRevoking={revoking === session.id}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Security Notice */}
          <section className="security-notice">
            <div className="notice-icon">🔒</div>
            <div className="notice-content">
              <h3>Don't recognize a session?</h3>
              <p>
                If you see a device or location you don't recognize, sign out
                from that session immediately and change your password.
              </p>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
```

---

### 3. Device Card Component

**File**: `apps/profile/src/components/DeviceCard.tsx`

```tsx
interface DeviceCardProps {
  session: {
    id: string;
    deviceType: string;
    deviceName: string;
    ipAddress: string;
    lastActivity: string;
    createdAt: string;
    isCurrentSession: boolean;
  };
  isCurrent?: boolean;
  onRevoke?: () => void;
  isRevoking?: boolean;
}

export function DeviceCard({ session, isCurrent, onRevoke, isRevoking }: DeviceCardProps) {
  const DeviceIcon = getDeviceIcon(session.deviceType);

  return (
    <div className={`device-card ${isCurrent ? 'current' : ''}`}>
      <div className="device-icon">
        <DeviceIcon />
      </div>

      <div className="device-info">
        <div className="device-name">
          {session.deviceName}
          {isCurrent && <span className="current-badge">This device</span>}
        </div>
        <div className="device-meta">
          <span className="ip-address">{session.ipAddress}</span>
          <span className="separator">•</span>
          <span className="last-activity">
            {isCurrent ? 'Active now' : `Last active ${formatRelativeTime(session.lastActivity)}`}
          </span>
        </div>
        <div className="session-started">
          Session started {new Date(session.createdAt).toLocaleDateString()}
        </div>
      </div>

      {!isCurrent && onRevoke && (
        <button
          onClick={onRevoke}
          disabled={isRevoking}
          className="revoke-btn"
        >
          {isRevoking ? 'Signing out...' : 'Sign out'}
        </button>
      )}
    </div>
  );
}

function getDeviceIcon(type: string) {
  switch (type) {
    case 'mobile':
      return () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
          <line x1="12" y1="18" x2="12" y2="18" />
        </svg>
      );
    case 'tablet':
      return () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
          <line x1="12" y1="18" x2="12" y2="18" />
        </svg>
      );
    default:
      return () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      );
  }
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} minutes ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)} hours ago`;
  if (diffMins < 10080) return `${Math.floor(diffMins / 1440)} days ago`;
  return date.toLocaleDateString();
}
```

---

## Rollout Checklist

### Admin Dashboard
- [ ] Sessions dashboard page
- [ ] User sessions management page
- [ ] OAuth client permissions UI
- [ ] Navigation updates
- [ ] Suspicious activity alerts
- [ ] Session statistics cards

### Profile Application
- [ ] Account switcher component
- [ ] Sessions management page
- [ ] Device card component
- [ ] Settings navigation update
- [ ] Security notice components

### Shared
- [ ] Toast notification system
- [ ] Confirmation dialogs
- [ ] Loading states
- [ ] Error handling
- [ ] Responsive design testing

---

## Estimated Effort
- Admin Sessions Dashboard: 6-8 hours
- Admin User Sessions Page: 4-6 hours
- Admin Navigation & Polish: 2-3 hours
- Profile Account Switcher: 6-8 hours
- Profile Sessions Page: 4-6 hours
- Device Card Component: 2-3 hours
- Testing & Polish: 4-6 hours
- **Total: 28-40 hours**

---

## Testing Requirements

### Unit Tests

#### Account Picker (Auth App) Tests

```typescript
describe('AccountPicker Page', () => {
  describe('loader', () => {
    it('should return accounts from browser session', async () => {
      // Acceptance: accounts array with user details
    });

    it('should redirect to login if no session cookie', async () => {
      // Acceptance: Redirect to /login
    });

    it('should redirect to login if no accounts in session', async () => {
      // Acceptance: Redirect to /login
    });

    it('should set canAddAccount=true when under 3 accounts', async () => {
      // Setup: 2 accounts
      // Acceptance: canAddAccount: true
    });

    it('should set canAddAccount=false when at 3 accounts', async () => {
      // Acceptance: canAddAccount: false
    });

    it('should detect max_reached mode from URL', async () => {
      // Setup: ?mode=max_reached
      // Acceptance: isMaxReached: true
    });

    it('should preserve OAuth params', async () => {
      // Acceptance: oauthParams object with client_id, redirect_uri, etc.
    });
  });

  describe('action', () => {
    it('should set selected account as active', async () => {
      // Acceptance: setActiveAccountByUserId called
    });

    it('should redirect to /authorize with account_hint', async () => {
      // Acceptance: Redirect URL contains account_hint
    });

    it('should preserve all OAuth params in redirect', async () => {
      // Acceptance: client_id, redirect_uri, state preserved
    });
  });

  describe('Component', () => {
    it('should render all accounts with emails', async () => {
      // Acceptance: Each account visible with email
    });

    it('should show active badge on active account', async () => {
      // Acceptance: 'Currently active' or badge visible
    });

    it('should show last used time for inactive accounts', async () => {
      // Acceptance: 'Last used X ago' visible
    });

    it('should show info banner in max_reached mode', async () => {
      // Acceptance: Info banner with 3 account limit message
    });

    it('should show sign-out buttons in max_reached mode', async () => {
      // Acceptance: X button next to each account
    });

    it('should hide "Use another account" in max_reached mode', async () => {
      // Acceptance: Button not present when isMaxReached
    });

    it('should disable buttons during submission', async () => {
      // Acceptance: Buttons disabled when isSubmitting
    });

    it('should call handleSelectAccount on account click', async () => {
      // Acceptance: fetcher.submit called with userId
    });

    it('should redirect to login with prompt=login on "Use another account"', async () => {
      // Acceptance: window.location.href set correctly
    });

    it('should sign out account and redirect on sign-out button click', async () => {
      // Acceptance: DELETE /session/accounts/:userId called, then redirect
    });
  });

  describe('Helper Functions', () => {
    it('getAvatarColor should return consistent color for email', async () => {
      // Acceptance: Same email always returns same color
    });

    it('formatRelativeTime should format correctly', async () => {
      // Test: Various time differences
      // Acceptance: 'just now', '5 min ago', '2 hours ago', '3 days ago'
    });
  });
});
```

#### AccountSwitcher (Profile App) Tests

```typescript
describe('AccountSwitcher Component', () => {
  describe('Initialization', () => {
    it('should load accounts on mount', async () => {
      // Acceptance: fetch('/session/accounts') called
    });

    it('should display active account in trigger', async () => {
      // Acceptance: Active account email visible
    });

    it('should show account count when multiple accounts', async () => {
      // Setup: 3 accounts
      // Acceptance: '3 accounts' text visible
    });

    it('should show loading skeleton while fetching', async () => {
      // Acceptance: Skeleton elements visible
    });
  });

  describe('Dropdown Toggle', () => {
    it('should open dropdown on click', async () => {
      // Acceptance: Dropdown menu visible
    });

    it('should close dropdown on click', async () => {
      // Acceptance: Dropdown hidden after second click
    });

    it('should close dropdown on outside click', async () => {
      // Acceptance: Dropdown hidden when clicking outside
    });

    it('should rotate chevron when open', async () => {
      // Acceptance: chevron.open class applied
    });
  });

  describe('Account List', () => {
    it('should list all accounts', async () => {
      // Acceptance: All account emails visible
    });

    it('should show checkmark on active account', async () => {
      // Acceptance: Check icon visible on active
    });

    it('should show "Active" status on active account', async () => {
      // Acceptance: 'Active' text visible
    });

    it('should show last used time on inactive accounts', async () => {
      // Acceptance: '2h ago' etc. visible
    });

    it('should disable switch button for active account', async () => {
      // Acceptance: Button disabled attribute present
    });
  });

  describe('Account Switching', () => {
    it('should call switch API on account click', async () => {
      // Acceptance: POST /session/switch called with userId
    });

    it('should reload page after successful switch', async () => {
      // Acceptance: window.location.reload called
    });

    it('should show loading state during switch', async () => {
      // Acceptance: setLoading(true) during operation
    });
  });

  describe('Sign Out', () => {
    it('should show sign-out button on hover', async () => {
      // Acceptance: opacity changes on hover
    });

    it('should call sign-out API on button click', async () => {
      // Acceptance: DELETE /session/accounts/:userId called
    });

    it('should remove account from list after sign-out', async () => {
      // Acceptance: Account no longer visible
    });

    it('should redirect to home if all accounts signed out', async () => {
      // Setup: remainingAccounts = 0
      // Acceptance: window.location.href = '/'
    });

    it('should reload page if active account signed out', async () => {
      // Acceptance: window.location.reload if wasActive
    });

    it('should not reload if inactive account signed out', async () => {
      // Acceptance: Just update list, no reload
    });
  });

  describe('Add Account', () => {
    it('should show "Add another account" when under max', async () => {
      // Setup: 2 accounts
      // Acceptance: Button visible
    });

    it('should hide "Add another account" when at max', async () => {
      // Setup: 3 accounts
      // Acceptance: Button not visible
    });

    it('should redirect to auth with action=add_account', async () => {
      // Acceptance: Correct URL constructed and navigated to
    });
  });

  describe('Sign Out All', () => {
    it('should call sign-out-all API', async () => {
      // Acceptance: DELETE /session/all called
    });

    it('should redirect to home after sign-out-all', async () => {
      // Acceptance: window.location.href = '/'
    });
  });

  describe('Accessibility', () => {
    it('should have aria-expanded on trigger', async () => {
      // Acceptance: aria-expanded attribute present
    });

    it('should have aria-haspopup on trigger', async () => {
      // Acceptance: aria-haspopup="true"
    });

    it('should have role="menu" on dropdown', async () => {
      // Acceptance: role attribute present
    });

    it('should have role="menuitem" on options', async () => {
      // Acceptance: role attribute on each option
    });

    it('should have aria-label on sign-out buttons', async () => {
      // Acceptance: aria-label includes account email
    });
  });
});
```

#### Admin Sessions Dashboard Tests

```typescript
describe('Sessions Dashboard', () => {
  describe('loader', () => {
    it('should fetch sessions, stats, and suspicious in parallel', async () => {
      // Acceptance: All 3 API calls made
    });
  });

  describe('Stats Cards', () => {
    it('should display total sessions count', async () => {
      // Acceptance: Number visible in card
    });

    it('should display active sessions count', async () => {
      // Acceptance: Green-styled active count
    });

    it('should display logins in last 24h', async () => {
      // Acceptance: Number visible
    });

    it('should highlight suspicious card when activity detected', async () => {
      // Acceptance: Orange border on card
    });
  });

  describe('Device Breakdown', () => {
    it('should display counts per device type', async () => {
      // Acceptance: Desktop, Mobile, Tablet counts visible
    });

    it('should show correct icons per device type', async () => {
      // Acceptance: Monitor, Smartphone, Tablet icons
    });
  });

  describe('Suspicious Activity Alert', () => {
    it('should show alert when suspicious activity detected', async () => {
      // Acceptance: Orange alert card visible
    });

    it('should list users with multiple IPs', async () => {
      // Acceptance: Email and IP count visible
    });

    it('should list users with failed then success logins', async () => {
      // Acceptance: Email and failed count visible
    });

    it('should link to user sessions page', async () => {
      // Acceptance: Links point to /users/:id/sessions
    });

    it('should hide alert when no suspicious activity', async () => {
      // Acceptance: Alert not rendered
    });
  });

  describe('Sessions Table', () => {
    it('should display all sessions with user info', async () => {
      // Acceptance: Email, device, IP, last active visible
    });

    it('should show device icon per row', async () => {
      // Acceptance: Correct icon for device type
    });

    it('should show active badge for active sessions', async () => {
      // Acceptance: Green badge visible
    });

    it('should link to user page from email', async () => {
      // Acceptance: Click navigates to /users/:id
    });

    it('should have manage button linking to user sessions', async () => {
      // Acceptance: Button links to /users/:id/sessions
    });
  });

  describe('Filtering', () => {
    it('should filter by device type', async () => {
      // Acceptance: URL updated with device_type param
    });

    it('should clear filter when "All devices" selected', async () => {
      // Acceptance: device_type param removed
    });
  });
});
```

#### Admin User Sessions Page Tests

```typescript
describe('User Sessions Page', () => {
  describe('loader', () => {
    it('should fetch user sessions', async () => {
      // Acceptance: Sessions array returned
    });

    it('should throw 404 for unknown user', async () => {
      // Acceptance: Response.status = 404
    });
  });

  describe('action', () => {
    it('should terminate single session', async () => {
      // Acceptance: DELETE /admin/users/:id/sessions/:sid called
    });

    it('should terminate all sessions', async () => {
      // Acceptance: DELETE /admin/users/:id/sessions called
    });

    it('should force logout', async () => {
      // Acceptance: POST /admin/users/:id/force-logout called
    });

    it('should return error for invalid action', async () => {
      // Acceptance: { error: 'Invalid action' }, 400
    });
  });

  describe('Header', () => {
    it('should show user email', async () => {
      // Acceptance: Email visible in header
    });

    it('should have back button', async () => {
      // Acceptance: Back button navigates to previous page
    });

    it('should show Terminate All button', async () => {
      // Acceptance: Button visible
    });

    it('should show Force Logout button', async () => {
      // Acceptance: Red destructive button visible
    });

    it('should disable Terminate All when no sessions', async () => {
      // Acceptance: Button disabled
    });
  });

  describe('Session Cards', () => {
    it('should display all sessions', async () => {
      // Acceptance: Card for each session
    });

    it('should show device icon', async () => {
      // Acceptance: Correct icon per device type
    });

    it('should show device name', async () => {
      // Acceptance: 'Chrome on Windows' etc.
    });

    it('should show active badge for active session', async () => {
      // Acceptance: Green badge visible
    });

    it('should show green left border for active session', async () => {
      // Acceptance: border-l-green-500 class
    });

    it('should show IP address', async () => {
      // Acceptance: IP in code format
    });

    it('should show relative last active time', async () => {
      // Acceptance: '5 min ago' etc.
    });

    it('should have terminate button per session', async () => {
      // Acceptance: Button visible on each card
    });
  });

  describe('Confirmation Dialogs', () => {
    it('should show dialog before terminate single', async () => {
      // Acceptance: AlertDialog visible with device name
    });

    it('should show dialog before terminate all', async () => {
      // Acceptance: AlertDialog with count
    });

    it('should show critical warning in force logout dialog', async () => {
      // Acceptance: List of consequences visible
    });

    it('should close dialog on cancel', async () => {
      // Acceptance: Dialog hidden
    });
  });

  describe('Summary Stats', () => {
    it('should show total sessions count', async () => {
      // Acceptance: Number in card
    });

    it('should show desktop count', async () => {
      // Acceptance: Filtered count
    });

    it('should show mobile count', async () => {
      // Acceptance: Filtered count
    });

    it('should show active count', async () => {
      // Acceptance: Green number
    });
  });

  describe('Empty State', () => {
    it('should show empty state when no sessions', async () => {
      // Acceptance: 'No Active Sessions' message
    });
  });
});
```

#### Profile Sessions Page Tests

```typescript
describe('Sessions Settings Page', () => {
  describe('Initialization', () => {
    it('should load sessions on mount', async () => {
      // Acceptance: GET /session/devices called
    });

    it('should show loading state while fetching', async () => {
      // Acceptance: Spinner visible
    });
  });

  describe('Current Session Section', () => {
    it('should display current session prominently', async () => {
      // Acceptance: 'Current Session' header visible
    });

    it('should show "This device" badge', async () => {
      // Acceptance: Badge visible on current
    });

    it('should show "Active now" for current session', async () => {
      // Acceptance: Status text visible
    });

    it('should not show revoke button for current session', async () => {
      // Acceptance: No button present
    });
  });

  describe('Other Sessions Section', () => {
    it('should list all other sessions', async () => {
      // Acceptance: Cards for each non-current session
    });

    it('should show count in header', async () => {
      // Acceptance: '(3)' etc. in header
    });

    it('should show "Sign out" button for each session', async () => {
      // Acceptance: Button visible
    });

    it('should show "Sign out all other devices" when multiple', async () => {
      // Acceptance: Button in header
    });

    it('should hide bulk sign-out when no other sessions', async () => {
      // Acceptance: Button not present
    });

    it('should show empty state when no other sessions', async () => {
      // Acceptance: 'No other active sessions' message
    });
  });

  describe('Revoke Session', () => {
    it('should call API on revoke click', async () => {
      // Acceptance: DELETE /session/devices/:id called
    });

    it('should show loading state during revoke', async () => {
      // Acceptance: 'Signing out...' text
    });

    it('should remove session from list after revoke', async () => {
      // Acceptance: Session no longer visible
    });
  });

  describe('Revoke All', () => {
    it('should show confirmation before bulk revoke', async () => {
      // Acceptance: confirm() called
    });

    it('should revoke each session sequentially', async () => {
      // Acceptance: Multiple DELETE calls made
    });

    it('should refresh list after bulk revoke', async () => {
      // Acceptance: loadSessions called
    });
  });

  describe('Security Notice', () => {
    it('should display security advice', async () => {
      // Acceptance: Warning about unrecognized sessions
    });
  });
});
```

#### DeviceCard Component Tests

```typescript
describe('DeviceCard Component', () => {
  it('should render device icon based on type', async () => {
    // Test: mobile, tablet, desktop, unknown
    // Acceptance: Correct SVG rendered
  });

  it('should show device name', async () => {
    // Acceptance: 'Chrome on Windows' visible
  });

  it('should show "This device" badge for current', async () => {
    // Setup: isCurrent=true
    // Acceptance: Badge visible
  });

  it('should show IP address', async () => {
    // Acceptance: IP visible in meta section
  });

  it('should show relative last activity time', async () => {
    // Acceptance: '2 hours ago' etc.
  });

  it('should show session start date', async () => {
    // Acceptance: Date in locale format
  });

  it('should show revoke button for non-current', async () => {
    // Setup: isCurrent=false, onRevoke provided
    // Acceptance: Button visible
  });

  it('should hide revoke button for current session', async () => {
    // Setup: isCurrent=true
    // Acceptance: Button not present
  });

  it('should disable button during revoke', async () => {
    // Setup: isRevoking=true
    // Acceptance: Button disabled, 'Signing out...' text
  });

  it('should call onRevoke when clicked', async () => {
    // Acceptance: onRevoke callback called
  });
});
```

### E2E Tests

```typescript
test.describe('Admin UI E2E', () => {
  test('admin can view sessions dashboard', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/sessions');

    await expect(page.getByText('Session Management')).toBeVisible();
    await expect(page.getByText('Total Sessions')).toBeVisible();
    await expect(page.getByText('Active Now')).toBeVisible();
  });

  test('admin can view user sessions', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/users/user123/sessions');

    await expect(page.getByText('User Sessions')).toBeVisible();
    await expect(page.locator('[data-testid="session-card"]')).toHaveCountGreaterThan(0);
  });

  test('admin can terminate session with confirmation', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/users/user123/sessions');

    await page.click('[data-testid="terminate-btn"]');
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.click('text=Terminate');

    await expect(page.getByText('terminated')).toBeVisible();
  });

  test('suspicious activity alert appears correctly', async ({ page }) => {
    // Setup: Create suspicious activity
    await createSuspiciousActivity();

    await loginAsAdmin(page);
    await page.goto('/sessions');

    await expect(page.getByText('Suspicious Activity')).toBeVisible();
  });
});

test.describe('Account Picker E2E', () => {
  test('account picker shows all accounts', async ({ page }) => {
    await loginAs(page, 'user1@test.com');
    await addAccount(page, 'user2@test.com');

    await page.goto('/authorize?client_id=test&prompt=select_account&redirect_uri=...');

    await expect(page.getByText('user1@test.com')).toBeVisible();
    await expect(page.getByText('user2@test.com')).toBeVisible();
    await expect(page.getByText('Choose an account')).toBeVisible();
  });

  test('selecting account continues OAuth flow', async ({ page }) => {
    await loginAs(page, 'user1@test.com');
    await addAccount(page, 'user2@test.com');

    await page.goto('/authorize?client_id=test&prompt=select_account&redirect_uri=...');

    await page.click('text=user1@test.com');

    await page.waitForURL(/code=/);
  });

  test('max_reached mode shows sign-out options', async ({ page }) => {
    await loginAs(page, 'user1@test.com');
    await addAccount(page, 'user2@test.com');
    await addAccount(page, 'user3@test.com');

    await page.goto('/account-picker?mode=max_reached&client_id=test&redirect_uri=...');

    await expect(page.getByText('3 accounts signed in')).toBeVisible();
    await expect(page.locator('.sign-out-btn')).toHaveCount(3);
    await expect(page.getByText('Use another account')).not.toBeVisible();
  });
});

test.describe('Profile AccountSwitcher E2E', () => {
  test('account switcher shows all accounts', async ({ page }) => {
    await loginAs(page, 'user1@test.com');
    await addAccount(page, 'user2@test.com');

    await page.goto('/profile');

    await page.click('.account-switcher-trigger');

    await expect(page.getByText('user1@test.com')).toBeVisible();
    await expect(page.getByText('user2@test.com')).toBeVisible();
  });

  test('switching account reloads page', async ({ page }) => {
    await loginAs(page, 'user1@test.com');
    await addAccount(page, 'user2@test.com');

    await page.goto('/profile');

    await page.click('.account-switcher-trigger');
    await page.click('text=user2@test.com');

    // Page should reload with user2 active
    await page.waitForNavigation();
  });

  test('sign out removes account from list', async ({ page }) => {
    await loginAs(page, 'user1@test.com');
    await addAccount(page, 'user2@test.com');

    await page.goto('/profile');

    await page.click('.account-switcher-trigger');
    await page.hover('text=user2@test.com');
    await page.click('[aria-label="Sign out user2@test.com"]');

    await expect(page.getByText('user2@test.com')).not.toBeVisible();
  });
});

test.describe('Profile Sessions E2E', () => {
  test('sessions page shows all devices', async ({ page }) => {
    await loginAs(page, 'user@test.com');

    await page.goto('/settings/sessions');

    await expect(page.getByText('Active Sessions')).toBeVisible();
    await expect(page.getByText('Current Session')).toBeVisible();
  });

  test('can revoke other session', async ({ page, context }) => {
    // Login on first "device"
    await loginAs(page, 'user@test.com');

    // Login on second "device"
    const page2 = await context.newPage();
    await loginAs(page2, 'user@test.com');

    // Go to sessions on first device
    await page.goto('/settings/sessions');

    // Should see 2 sessions
    await expect(page.locator('[data-testid="device-card"]')).toHaveCount(2);

    // Revoke the other session
    await page.click('[data-testid="revoke-btn"]');

    // Should now see 1 session
    await expect(page.locator('[data-testid="device-card"]')).toHaveCount(1);

    // Second device should be logged out
    const check = await page2.request.get('/session/check');
    expect((await check.json()).authenticated).toBe(false);
  });
});
```

### Coverage Requirements

| Component | Target Coverage |
|-----------|----------------|
| Account Picker Page | >85% |
| AccountSwitcher Component | >85% |
| Sessions Dashboard | >80% |
| User Sessions Page | >80% |
| DeviceCard Component | 100% |
| Profile Sessions Page | >80% |

**Overall Lane 7 Coverage Target: >80%**

---

## Accessibility Requirements

- All interactive elements keyboard accessible
- ARIA labels on buttons and menus
- Focus management in dropdowns
- Screen reader announcements for state changes
- Color contrast compliance (WCAG 2.1 AA)
- Reduced motion support
