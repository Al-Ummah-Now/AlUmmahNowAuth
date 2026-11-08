# AlUmmahNowAuth - AI Agent Instructions

OpenAuth authentication system built as a **pnpm monorepo** with two Cloudflare Workers apps: Auth Server and Admin Dashboard.

## 🏗️ Architecture

**Monorepo Structure** (pnpm workspace):
- `apps/auth/` - OpenAuth server (email-based authentication)
- `apps/admin/` - React Router v7 admin dashboard
- **Shared Resources**: Both apps use same D1 database (`AUTH_DB`) and KV storage (`AUTH_STORAGE`)

**Data Flow**:
1. Users authenticate via Auth Server (`apps/auth`) → email verification codes sent via Resend API
2. Auth Server stores sessions in KV and user data in D1
3. Admin Dashboard (`apps/admin`) reads from D1 for user management
4. OAuth flow: Admin redirects to Auth → Auth validates → returns code → Admin exchanges for token → creates session

**Visual Flow**:
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

## ⚡ Essential Commands

**Always use pnpm** (NOT npm). Commands run from monorepo root:

```powershell
# Install dependencies (13s, use 300s timeout)
pnpm install

# Development (concurrent mode - both apps)
pnpm dev              # Auth on :8787, Admin on :5174

# Development (individual apps)
pnpm dev:auth         # Auth server only (:8787)
pnpm dev:admin        # Admin dashboard only (:5174) - Fast Vite HMR, no D1/KV bindings
pnpm dev:wrangler     # Admin with full Wrangler context (D1+KV access) - Required for user management

# Type checking & validation
pnpm type-check       # Both apps (~3s, use 30s timeout)

# Deployment
pnpm deploy           # Both apps to production
pnpm deploy:auth      # Auth server only
pnpm deploy:admin     # Admin dashboard only
```

**Development Mode Differences**:
- `pnpm dev:admin` - Fast Vite HMR, no D1/KV bindings (auth redirects work, user management doesn't)
- `pnpm dev:wrangler` - Full Wrangler context with D1/KV bindings (slower, but required for database operations)

**Never cancel** long-running terminal operations - they're actually fast but may appear slow.

## 🗄️ Database & Migrations

**Schema** (`apps/auth/migrations/`):
- `0001_create_user_table.sql` - Users: id, email, created_at
- `0002_create_clients_table.sql` - OAuth clients config
- `0003_add_user_role.sql` - Adds role column (admin/user), indexes
- `0004_add_password_reset_required.sql` - Password reset flags
- `0005_add_admin_dashboard_client.sql` - Adds admin-dashboard OAuth client
- `0006_create_logs_table.sql` - System logging table

**Apply Migrations**:
```powershell
cd apps/auth
pnpm run migrations:local    # Local D1 database
pnpm run migrations:remote   # Production D1 database
```

**Critical Pattern**: All database access uses D1 prepared statements:
```typescript
await env.AUTH_DB.prepare(`SELECT * FROM user WHERE email = ?`)
  .bind(email)
  .first<{ id: string; role: string }>();
```

**User Management**:
- Default role is `'user'` for new registrations
- Admin role must be manually set via SQL:
  ```sql
  UPDATE user SET role = 'admin' WHERE email = 'admin@example.com';
  ```
- Role column has index for performance: `CREATE INDEX idx_user_role ON user(role);`
- First user is automatically assigned `'admin'` role via migration

## 🔐 Authentication Patterns

**Auth Server** (`apps/auth/src/index.ts`):
- Uses OpenAuth's `PasswordProvider` with email verification codes
- `getOrCreateUser()` - Returns existing user or creates new (role='user')
- Sessions stored in KV: `session:${token}` keys
- Cloudflare bindings: `AUTH_DB` (D1), `AUTH_STORAGE` (KV), `RESEND_API_KEY` (environment variable)
- **Error Logging**: All errors logged to console with context objects:
  ```typescript
  console.error("Error in getOrCreateUser:", {
    error: error instanceof Error ? error.message : String(error),
    email,
    timestamp: new Date().toISOString()
  });
  ```
- **Critical**: D1 logging must be `await`ed to prevent execution context termination cancelling writes

**Resend API Key Configuration**:
- **Local Development**: Set in `apps/auth/.dev.vars`:
  ```env
  RESEND_API_KEY=re_xxxxxxxxxxxxx
  ```
- **Production**: Set via Cloudflare Dashboard → Workers → Settings → Variables and Secrets → Environment Variables
- **DO NOT use Secrets Store** - causes issues in local dev, use plain environment variables
- **Validation**: Auth server will log "Secret RESEND_API_KEY not found" warning if missing (email won't send)

**Admin Dashboard** (`apps/admin/app/lib/auth.server.ts`):
- `requireAuth()` - Server-side auth guard, reads session from KV
- `getAuthenticatedUser()` - Validates session cookie against KV storage
- Admin routes check `user.role === 'admin'` via `requireAuth(request, env, true)`
- **Session Cookie**: `auth_session` contains access token (JWT)

**OAuth Exchange Result Check**:
```typescript
import { exchangeCode } from "@openauthjs/openauth/client";

const result = await exchangeCode({
  code,
  redirectURI: "http://localhost:5174/auth/callback",
  clientID: "admin-dashboard",
  issuer: "http://localhost:8787"
});

// Check for success - result.err is false for success, string for error
if (result.err !== false) {
  console.error("Token exchange failed:", result.err);
  throw new Response("Authentication failed", { status: 401 });
}

// Success - access tokens and user data
const { access, refresh } = result.tokens;
const subject = result.subject; // User data from subjects schema
```

**Environment Detection** (`apps/admin/app/lib/config.ts`):
- Localhost → `http://localhost:8787` (auth server)
- Preview/PR domains → preview auth server URL
- Production → production auth server URL

## 🎨 UI & Components

**Admin Dashboard** uses shadcn/ui with dark theme (Slate/Blue):
- Components: `apps/admin/app/components/ui/` (button, card, dialog, table, etc.)
- Routes: `apps/admin/app/routes/` (React Router v7 file-based routing)
- Loaders MUST call `requireAuth()` and handle redirects properly
- Example: `users._index.tsx` - User CRUD with loader fetching from D1

**Common Pattern**:
```typescript
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as { AUTH_DB: D1Database; AUTH_STORAGE: KVNamespace };
  await requireAuth(request, env, true); // throws redirect if not authed
  const users = await getAllUsers(env.AUTH_DB);
  return { users };
}
```

**Error Handling in Loaders**:
```typescript
export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    const env = context?.cloudflare?.env as Env;
    const user = await requireAuth(request, env, true);
    
    // Your logic here
    
  } catch (error) {
    console.error("Loader error:", {
      error: error instanceof Error ? error.message : String(error),
      path: new URL(request.url).pathname,
      timestamp: new Date().toISOString()
    });
    
    if (error instanceof Response) {
      throw error; // Re-throw redirects
    }
    throw new Response("Internal Server Error", { status: 500 });
  }
}
```

## 🚀 Testing & Validation

**Manual Testing** (required for auth changes):
1. Start auth server: `cd apps/auth && pnpm dev`
2. Test auth flow: `http://localhost:8787/authorize?response_type=code&client_id=test&redirect_uri=http://localhost:3000/callback`
3. Expected: Login form displays, email sending fails with "Secret RESEND_API_KEY not found" (normal in local dev)

**Admin Dashboard Testing**:
1. Start both servers: `pnpm dev` (from root)
2. Create OAuth client in local D1:
   ```sql
   INSERT INTO clients (client_id, redirect_uri, theme_title)
   VALUES ('admin-dashboard', 'http://localhost:5174/auth/callback', 'Admin Dashboard');
   ```
3. Navigate to `http://localhost:5174` → should redirect to login
4. For user management testing, use `pnpm dev:wrangler` to access D1

**Debugging Checklist**:
- Check browser console for client-side errors
- Check terminal output for server-side errors with context objects
- Verify KV storage has session: `wrangler kv:key get --binding=AUTH_STORAGE "session:${token}"`
- Verify D1 database has user: `wrangler d1 execute AUTH_DB --command="SELECT * FROM user WHERE email='test@example.com'"`

## 📦 Deployment & CI/CD

**Preview Deployments** (automatic on PRs):
- Auth: `https://al-ummah-now-auth-pr-{PR-NUMBER}.mahmoud-s-darwish.workers.dev/`
- Admin: `https://al-ummah-now-auth-admin-pr-{PR-NUMBER}.mahmoud-s-darwish.workers.dev/`

**Production**:
- Auth: `https://al-ummah-now-auth.alummahnow.workers.dev`
- Admin: `https://al-ummah-now-auth-admin.alummahnow.workers.dev`

**GitHub Actions**: `.github/workflows/release.yml` releases every merge to main (stage, E2E, then production at 0% → 100% with auto-rollback); `rollback.yml` is the one-click rollback; `test.yml` runs PR checks and QA E2E

**Deployment Secrets** (required):
- `CLOUDFLARE_API_TOKEN` - For Wrangler deployments
- `RESEND_API_KEY` - Must be set in Cloudflare Workers secrets (not in GitHub)

## 🗺️ Roadmap & Future Features

**Phase 1: Core Infrastructure** (Current)
- ✅ Monorepo setup with pnpm
- ✅ Email-based authentication
- ✅ Admin dashboard with user management
- ✅ Role-based access control
- 🔄 Password reset functionality

**Phase 2: Enhanced Security**
- Two-factor authentication (TOTP)
- Session management (device tracking, logout all)
- Account lockout after failed attempts
- Password strength requirements

**Phase 3: Advanced Features**
- OAuth provider support (Google, GitHub)
- Audit logging for admin actions
- User activity monitoring
- API rate limiting

**Phase 4: Multi-tenancy**
- Organization/tenant support
- Team management
- Custom branding per client

**V1.0 Release Target**: March 31, 2025
- Alpha (v0.8.0): February 15, 2025 - Core features complete, internal testing
- Beta (v0.9.0): March 15, 2025 - Feature complete, community testing, security audit
- v1.0.0: March 31, 2025 - Production ready, full documentation, performance validated

See `ROADMAP.md` for detailed feature breakdown and timeline.

## 🛠️ Project Conventions

- **No linting tools** - manual code review required
- **No test framework** - manual validation only
- **TypeScript strict mode** - all code strongly typed
- **Server-side rendering** - Admin uses React Router v7 SSR
- **Shared subjects schema** (`apps/auth/src/index.ts`): Defines user type validation with Valibot
- **Migrations are sequential** - numbered prefixes (0001, 0002, etc.)
- **Error logging** - Always include context objects with timestamp, email, error message
- **Console methods**: Use `console.error()` for errors, `console.log()` for info (Cloudflare Workers logs visible in dashboard)

## 🚨 Common Pitfalls

1. **Wrong package manager**: Always use `pnpm`, not `npm` or `yarn`
2. **Missing bindings**: Ensure `wrangler.json` has `AUTH_DB`, `AUTH_STORAGE` bindings
3. **Auth without KV**: Admin routes fail if `AUTH_STORAGE` unavailable (check `env` parameter)
4. **Type generation**: Run `pnpm run types` in `apps/auth` after changing `wrangler.json`
5. **Database access**: D1 binding only available with `pnpm dev:wrangler` for admin (not `pnpm dev`)
6. **Silent errors**: Always wrap database operations in try-catch with error logging
7. **OAuth exchange**: Check `result.err !== false` (not truthy check) for proper type narrowing
8. **Session cookies**: Must be httpOnly and secure in production
9. **Resend API**: Requires valid API key in `.dev.vars` or Cloudflare secrets, test emails only work with verified domains
10. **D1 Logging**: All D1 writes must be awaited before sending response, or execution context terminates and cancels writes

## 📚 Key Files Reference

- `apps/auth/src/index.ts` - Auth server entry, OpenAuth configuration, subjects schema
- `apps/admin/app/lib/auth.server.ts` - Server-side auth utilities (requireAuth, getAuthenticatedUser)
- `apps/admin/app/lib/config.ts` - Environment-based configuration (auth server URLs)
- `apps/admin/app/routes/auth.callback.tsx` - OAuth callback handler, token exchange
- `apps/auth/migrations/` - Database schema migrations (run sequentially)
- `.github/workflows/release.yml` - stage-then-promote release pipeline (see CICD.md)