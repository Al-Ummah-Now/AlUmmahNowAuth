# UI Components

Server-rendered HTML components for the Auth application.

## Overview

This directory contains UI components that generate server-rendered HTML. These components are designed to be used in Cloudflare Workers/Hono routes and do NOT use React or any client-side JavaScript framework.

All components:
- Generate pure HTML strings
- Use Tailwind CSS for styling
- Include proper HTML escaping for XSS prevention
- Are mobile-first responsive
- Support accessibility features (ARIA labels, keyboard navigation)

## Components

### 1. Account Selector (`select-account.ts`)

**Purpose**: Full-page UI shown during OAuth authorize flow when user has multiple accounts.

**When to use**:
- `prompt=select_account` parameter in authorize request
- User has multiple accounts AND no `account_hint` provided
- During OAuth/OIDC login flows

**Example usage**:
```typescript
import { renderAccountSelector, AccountSelectorProps } from './ui/select-account';

app.get('/select-account', async (c) => {
  const accounts = await getLoggedInAccounts(c);

  const html = renderAccountSelector({
    accounts: accounts.map(a => ({
      userId: a.userId,
      email: a.email,
      lastUsed: a.lastUsed,
      isActive: a.isActive,
    })),
    clientId: 'example-client',
    clientName: 'Example App',
    redirectUri: 'https://example.com/callback',
    allowAddAccount: accounts.length < 3,
  });

  return c.html(html);
});
```

---

### 2. Account Switcher (`account-switcher.ts`)

**Purpose**: Dropdown component for quick account switching in header/navbar.

**When to use**:
- Profile/settings pages
- Any authenticated page where user can switch accounts
- Always visible when user has multiple accounts

**Features**:
- Displays up to 3 logged-in accounts
- Shows active account indicator
- Switch account button
- Add account button (if < 3 accounts)
- Sign out individual account button
- Sign out all accounts button

**Example usage**:
```typescript
import { renderAccountSwitcher } from './ui/account-switcher';

// In your route handler
app.get('/profile', async (c) => {
  const accounts = await getAccountsForBrowserSession(c);

  const accountSwitcherHtml = renderAccountSwitcher({
    accounts: accounts.map(a => ({
      userId: a.userId,
      email: a.email,
      lastUsed: a.lastUsed,
      isActive: a.isActive,
    })),
    actionBaseUrl: '/session',
    showAccountCount: true,
  });

  // Embed in your page template
  return c.html(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Profile</title>
        <script src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js" defer></script>
      </head>
      <body>
        <header>
          <nav>
            ${accountSwitcherHtml}
          </nav>
        </header>
        <!-- Rest of page -->
      </body>
    </html>
  `);
});
```

**Required endpoints**:
- `POST /session/switch` - Switch active account
- `POST /session/signout/:userId` - Sign out specific account
- `POST /session/signout-all` - Sign out all accounts
- `GET /session/add` - Add new account (redirects to login)

**Dependencies**:
- Alpine.js (for dropdown interactivity) - Add to your HTML:
  ```html
  <script src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js" defer></script>
  ```

---

### 3. Session List (`session-list.ts`)

**Purpose**: User-facing session management page showing all active sessions/devices.

**When to use**:
- Settings/Security pages
- "Active sessions" or "Devices" management page
- Allow users to view and revoke their own sessions

**Features**:
- List all active sessions across devices
- Current session indicator
- Device type icons (desktop, mobile, tablet)
- IP address and last activity display
- Revoke individual session button
- Revoke all other sessions button
- Security notice for unrecognized sessions

**Example usage**:
```typescript
import { renderSessionList } from './ui/session-list';

app.get('/settings/sessions', async (c) => {
  const userId = c.get('userId'); // From auth middleware
  const sessions = await getSessionsForUser(userId);
  const currentSessionId = c.get('browserSessionId');

  const html = renderSessionList({
    sessions: sessions.map(s => ({
      id: s.id,
      browserSessionId: s.browserSessionId,
      deviceType: s.deviceType,
      deviceName: s.deviceName,
      ipAddress: s.ipAddress,
      lastActivity: s.lastActivity,
      createdAt: s.createdAt,
      isCurrentSession: s.id === currentSessionId,
    })),
    actionBaseUrl: '/session/devices',
    showRevokeAll: true,
  });

  return c.html(wrapInPageTemplate(html, 'Active Sessions'));
});
```

**Required endpoints**:
- `DELETE /session/devices/:id` - Revoke specific session
- `POST /session/devices/revoke-all` - Revoke all other sessions (keeps current)

---

### 4. Admin Sessions Dashboard (`admin-sessions.ts`)

**Purpose**: Admin dashboard for system-wide session monitoring and management.

**When to use**:
- Admin dashboard
- Security monitoring interface
- System-wide session analytics

**Features**:
- Session statistics (total, active, logins)
- Device breakdown (desktop, mobile, tablet)
- Suspicious activity alerts
- Session search and filtering
- User session management links

**Example usage**:
```typescript
import { renderAdminSessionsDashboard } from './ui/admin-sessions';

app.get('/admin/sessions', async (c) => {
  const filters = {
    deviceType: c.req.query('device_type'),
    search: c.req.query('search'),
  };

  const [stats, sessions, suspicious] = await Promise.all([
    getSessionStats(),
    getSessions(filters),
    getSuspiciousActivity(),
  ]);

  const html = renderAdminSessionsDashboard({
    stats: {
      totalSessions: stats.total,
      activeSessions: stats.active,
      loginsLast24h: stats.logins24h,
      deviceBreakdown: {
        desktop: stats.devices.desktop,
        mobile: stats.devices.mobile,
        tablet: stats.devices.tablet,
        unknown: stats.devices.unknown,
      },
    },
    sessions: sessions.map(s => ({
      id: s.id,
      userId: s.userId,
      email: s.userEmail,
      deviceType: s.deviceType,
      deviceName: s.deviceName,
      ipAddress: s.ipAddress,
      lastUsed: s.lastUsed,
      isActive: s.isActive,
      createdAt: s.createdAt,
    })),
    suspicious: {
      multipleIPsInShortTime: suspicious.multipleIPs?.map(item => ({
        userId: item.userId,
        email: item.email,
        ipCount: item.ipCount,
      })),
      failedThenSuccessfulLogins: suspicious.failedLogins?.map(item => ({
        userId: item.userId,
        email: item.email,
        failedAttempts: item.failedAttempts,
      })),
    },
    filters,
    userBaseUrl: '/admin/users',
    actionBaseUrl: '/admin/sessions',
  });

  return c.html(wrapInAdminTemplate(html, 'Session Management'));
});
```

**Required endpoints**:
- `GET /admin/sessions` - List sessions with filters
- `GET /admin/sessions/stats` - Get session statistics
- `GET /admin/sessions/suspicious` - Get suspicious activity data
- `GET /admin/users/:id/sessions` - User-specific session management

---

## Security Considerations

### XSS Prevention

All components use the `escapeHtml()` utility function to prevent XSS attacks. This is crucial when displaying user-generated content (emails, names, etc.).

**Always escape user input**:
```typescript
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
```

### CSRF Protection

All forms should include CSRF tokens when implementing the backend routes:

```typescript
app.post('/session/switch', csrfMiddleware, async (c) => {
  // Handle account switch
});
```

### Session Validation

Always validate that:
1. User owns the session they're trying to manage
2. Current session is authenticated
3. Actions are authorized (e.g., admin-only routes)

---

## Styling

All components use Tailwind CSS utility classes. Ensure your HTML template includes Tailwind CSS:

```html
<link href="https://cdn.jsdelivr.net/npm/tailwindcss@3/dist/tailwind.min.css" rel="stylesheet">
```

Or use a build process to include Tailwind CSS in your bundle.

### Mobile-First Approach

All components are built mobile-first with responsive breakpoints:
- Base (no prefix): Mobile (≥0px)
- `sm:`: Small (≥640px) - Mobile landscape
- `md:`: Medium (≥768px) - Tablet
- `lg:`: Large (≥1024px) - Desktop

---

## Accessibility

All components include:
- Semantic HTML elements
- ARIA labels where appropriate
- Keyboard navigation support
- Focus states for interactive elements
- Screen reader friendly text

**Example ARIA usage**:
```html
<button
  aria-label="Sign out ${email}"
  aria-expanded="false"
  aria-haspopup="true"
>
  Sign Out
</button>
```

---

## Testing

When testing these components:

1. **Visual Testing**: Render HTML in browser at different screen sizes
2. **XSS Testing**: Test with malicious input (e.g., `<script>alert('xss')</script>` in email)
3. **Accessibility Testing**: Use screen reader and keyboard-only navigation
4. **Cross-browser Testing**: Test in Chrome, Firefox, Safari

**Example test**:
```typescript
import { renderAccountSwitcher } from './account-switcher';

describe('Account Switcher', () => {
  it('should escape HTML in email addresses', () => {
    const html = renderAccountSwitcher({
      accounts: [{
        userId: '1',
        email: '<script>alert("xss")</script>@example.com',
        lastUsed: new Date().toISOString(),
        isActive: true,
      }],
    });

    // Should NOT contain raw script tag
    expect(html).not.toContain('<script>alert("xss")</script>');
    // Should contain escaped version
    expect(html).toContain('&lt;script&gt;');
  });
});
```

---

## Future Enhancements

Potential improvements for these components:

1. **Internationalization (i18n)**
   - Support for multiple languages
   - RTL support for Arabic, Hebrew, etc.

2. **Dark Mode**
   - Add dark mode variants using Tailwind's dark mode classes

3. **Animation**
   - Smooth transitions for dropdowns and state changes
   - Loading skeletons for async operations

4. **Enhanced Icons**
   - Replace inline SVGs with icon library
   - Add more device type recognition

5. **Real-time Updates**
   - WebSocket integration for live session updates
   - Real-time suspicious activity alerts

---

## Related Documentation

- [Lane 7 Implementation Plan](../../../../docs/plans/LANE-7-UI-IMPLEMENTATION.md)
- [Session Types](../types/sessions.ts)
- [Browser Session Service](../services/browser-session.service.ts)
- [Account Session Service](../services/account-session.service.ts)
