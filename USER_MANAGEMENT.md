# User Management Guide

## Overview

The Al Ummah Now Auth system provides a comprehensive user management interface through the Admin Dashboard. This guide covers all aspects of managing users, roles, and authentication.

## Table of Contents

- [Accessing the Admin Dashboard](#accessing-the-admin-dashboard)
- [User Roles](#user-roles)
- [Managing Users](#managing-users)
- [Authentication Flow](#authentication-flow)
- [Security Best Practices](#security-best-practices)
- [Troubleshooting](#troubleshooting)

## Accessing the Admin Dashboard

### Production
- **URL**: [https://al-ummah-now-auth-admin.alummahnow.workers.dev](https://al-ummah-now-auth-admin.alummahnow.workers.dev)
- **Requirements**: Admin role required

### Local Development
1. Start the auth server:
   ```bash
   cd apps/auth
   pnpm dev
   ```

2. Start the admin dashboard:
   ```bash
   cd apps/admin
   pnpm dev:wrangler  # Use wrangler for full D1/KV access
   ```

3. Access at: [http://localhost:5174](http://localhost:5174)

### Preview Deployments
For each pull request, preview deployments are automatically created:
- Admin: `https://al-ummah-now-auth-admin-pr-{PR-NUMBER}.mahmoud-s-darwish.workers.dev/`

## User Roles

### Available Roles

#### Admin
- **Capabilities**:
  - Full access to admin dashboard
  - View and manage all users
  - Create, edit, and delete users
  - Access system logs
  - Manage authentication settings

#### User (Regular)
- **Capabilities**:
  - Authenticate with the auth server
  - Access authorized applications
  - Cannot access admin dashboard

### Role Assignment

**Default Behavior**:
- New user registrations automatically receive the `'user'` role
- First user is automatically assigned `'admin'` role via database migration

**Manual Role Assignment**:
To manually promote a user to admin:

```sql
UPDATE user SET role = 'admin' WHERE email = 'user@example.com';
```

Execute via:
```bash
# Local database
wrangler d1 execute AUTH_DB --local --command="UPDATE user SET role = 'admin' WHERE email = 'user@example.com';"

# Production database
wrangler d1 execute AUTH_DB --remote --command="UPDATE user SET role = 'admin' WHERE email = 'user@example.com';"
```

## Managing Users

### Viewing Users

The admin dashboard displays a comprehensive list of all users with:
- User ID
- Email address
- Role
- Account creation date

**Access**: Navigate to the Users page after logging into the admin dashboard.

### Creating Users

Users are typically created through the authentication flow:

1. User visits an application that uses the auth server
2. Initiates login/registration
3. Receives email verification code via Resend API
4. Verifies email and account is created
5. Default role: `'user'`

**Manual Creation** (via SQL):
```sql
INSERT INTO user (id, email, role, created_at)
VALUES ('unique-id', 'user@example.com', 'user', datetime('now'));
```

### Editing Users

Currently, user editing is available through:
1. Admin dashboard UI (for basic fields)
2. Direct database access (for advanced changes)

**Update via SQL**:
```sql
-- Update user role
UPDATE user SET role = 'admin' WHERE email = 'user@example.com';

-- Update user email
UPDATE user SET email = 'newemail@example.com' WHERE id = 'user-id';
```

### Deleting Users

**Via SQL**:
```sql
DELETE FROM user WHERE email = 'user@example.com';
```

**Important**: Deletion is permanent and cannot be undone. Ensure you have proper backups.

### Suspending Users

`POST /admin/users/:id/suspend` sets `users.status = 'suspended'` in D1, signs the user out everywhere (revocation list) and ends their browser sessions. `POST /admin/users/:id/unsuspend` reinstates them.

A suspended or deleted account (D1 `users.status` is not `active`, or `deleted_at` is set) gets no tokens by any way in. D1 is read on every check, never a KV copy (`apps/auth/src/security/account-status.ts`):

| Way in | Where it is refused | What the user or app sees |
|---|---|---|
| Password sign-in, email-code sign-in/reset, silent single sign-on, device `/activate` sign-in | the issuer's `onSuccess` (`handlers/auth-handlers.ts`) | the "This account is suspended" page (en/ar, in the sign-in theme); silent sign-on with `prompt=none` redirects to the app with `error=login_required` |
| Authorization code redeemed at `/token` (code minted before the suspension) | issuer storage guard (`revocation/token-gate.ts`) | `invalid_grant` |
| Refresh token grant | `onRefresh` (`handlers/refresh-check.ts`) | `invalid_grant`; the token family is revoked, so it stays refused after reinstatement |
| Device code grant (TV polling `/token`) | issuer storage guard | `access_denied` |

Reinstated users sign in again normally. Refresh tokens and codes refused while suspended don't come back.

## Authentication Flow

### OAuth 2.0 Authorization Code Flow

The system implements standard OAuth 2.0 authorization code flow:

```
┌─────────────────┐         OAuth 2.0          ┌──────────────────┐
│  Admin Dashboard│ <──────────────────────> │  Auth Server     │
│  (OpenAuth      │    Authorization Code    │  (OpenAuth       │
│   Client)       │         Flow             │   Issuer)        │
└─────────────────┘                          └──────────────────┘
       │                                              │
       ├─────── Stores sessions ─────┐               │
       ▼                              ▼               ▼
 ┌───────────┐                  ┌─────────────────────────┐
 │ KV Storage│                  │    D1 Database          │
 │ AUTH_     │                  │  - users table          │
 │ STORAGE   │                  │  - clients table        │
 └───────────┘                  └─────────────────────────┘
```

### Email-Based Authentication

1. **Initiate Login**: User provides email address
2. **Send Code**: Verification code sent via Resend API
3. **Verify Code**: User enters code from email
4. **Create Session**: Session stored in KV with 7-day expiration
5. **Access Token**: JWT access token issued
6. **Authorization**: User can access authorized applications

### Session Management

**Session Storage**: Cloudflare KV (AUTH_STORAGE)
- Key format: `session:${token}`
- TTL: 7 days (604,800 seconds)
- Data stored:
  ```json
  {
    "user": {
      "id": "user-id",
      "email": "user@example.com",
      "role": "admin"
    },
    "tokens": {
      "access": "jwt-token",
      "refresh": "refresh-token"
    },
    "expiresAt": "2025-01-15T10:00:00.000Z"
  }
  ```

**Session Verification**:
- Every protected route validates session cookie
- Checks KV storage for session data
- Validates user role for admin routes

## Security Best Practices

### Environment Variables

**Never commit secrets to source code**:
- ✅ Use `.dev.vars` for local development (gitignored)
- ✅ Use Cloudflare Workers secrets for production
- ❌ Don't store secrets in `wrangler.json`

**Required Secrets**:
```env
# apps/auth/.dev.vars
RESEND_API_KEY=re_xxxxxxxxxxxxx
```

### Database Security

- All queries use prepared statements to prevent SQL injection
- User input is validated before database operations
- Sensitive data is never logged

### Session Security

- **HttpOnly cookies**: Prevents XSS attacks
- **Secure flag**: Ensures HTTPS-only transmission (production)
- **SameSite=Lax**: CSRF protection
- **7-day expiration**: Limits attack window

### Role-Based Access Control

- Admin routes check user role on every request
- Non-admin users redirected on admin access attempts
- Role changes require database access (cannot be done via API)

## Troubleshooting

### Issue: Cannot Access Admin Dashboard

**Symptom**: Redirect to login or error page

**Solution**:
1. Verify user has `'admin'` role:
   ```sql
   SELECT email, role FROM user WHERE email = 'your@email.com';
   ```
2. If role is `'user'`, promote to admin:
   ```sql
   UPDATE user SET role = 'admin' WHERE email = 'your@email.com';
   ```
3. Clear cookies and log in again

### Issue: Email Verification Not Sending

**Symptom**: "Secret RESEND_API_KEY not found" error

**Solution**:
1. **Local Development**: Add to `apps/auth/.dev.vars`:
   ```env
   RESEND_API_KEY=re_xxxxxxxxxxxxx
   ```
2. **Production**: Set via Cloudflare Dashboard:
   - Navigate to Workers → Settings → Variables
   - Add environment variable `RESEND_API_KEY`

### Issue: Session Expired

**Symptom**: Logged out unexpectedly

**Cause**: Sessions expire after 7 days

**Solution**: Log in again. Sessions cannot be manually extended.

### Issue: Type Check Failures

**Symptom**: TypeScript errors in admin app

**Solution**:
1. Ensure generated types are excluded:
   ```json
   // tsconfig.json
   {
     "exclude": [".react-router/types/**/*"]
   }
   ```
2. Run type generation:
   ```bash
   cd apps/admin
   pnpm run typecheck
   ```

### Issue: Database Migration Errors

**Symptom**: "table already exists" or migration errors

**Solution**:
1. Check migration status:
   ```bash
   wrangler d1 migrations list AUTH_DB --local
   ```
2. Apply migrations:
   ```bash
   cd apps/auth
   pnpm run migrations:local
   ```

## Database Schema

### User Table

```sql
CREATE TABLE user (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'user',
  password_reset_required INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_user_email ON user(email);
CREATE INDEX idx_user_role ON user(role);
```

### Clients Table

```sql
CREATE TABLE clients (
  client_id TEXT PRIMARY KEY,
  redirect_uri TEXT NOT NULL,
  theme_title TEXT,
  theme_primary TEXT,
  theme_favicon TEXT,
  theme_logo_dark TEXT,
  theme_logo_light TEXT
);
```

### Logs Table

```sql
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  context TEXT
);

CREATE INDEX idx_logs_timestamp ON logs(timestamp);
CREATE INDEX idx_logs_level ON logs(level);
```

## API Reference

### Authentication Endpoints

**Base URL**: `https://al-ummah-now-auth.alummahnow.workers.dev`

#### Authorize
```
GET /authorize
Query Parameters:
  - response_type: code
  - client_id: string
  - redirect_uri: string
  - state: optional string
```

#### Token Exchange
```
POST /token
Body:
  - grant_type: authorization_code
  - code: string
  - redirect_uri: string
  - client_id: string
```

#### Token Verification
Handled automatically by OpenAuth client library.

## Additional Resources

- [Main README](./README.md)
- [CI/CD Documentation](./CICD.md)
- [Project Roadmap](./ROADMAP.md)
- [OpenAuth Documentation](https://openauth.js.org/)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)

## Support

For issues or questions:
1. Check this documentation
2. Review [GitHub Issues](https://github.com/meywd/AlUmmahNowAuth/issues)
3. Create a new issue using the appropriate template
