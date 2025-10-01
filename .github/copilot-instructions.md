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

## ⚡ Essential Commands

**Always use pnpm** (NOT npm). Commands run from monorepo root:

```powershell
# Install dependencies (13s, use 300s timeout)
pnpm install

# Development (concurrent mode - both apps)
pnpm dev              # Auth on :8787, Admin on :5174

# Development (individual apps)
pnpm dev:auth         # Auth server only (:8787)
pnpm dev:admin        # Admin dashboard only (:5174)

# Type checking & validation
pnpm type-check       # Both apps (~3s, use 30s timeout)

# Deployment
pnpm deploy           # Both apps to production
pnpm deploy:auth      # Auth server only
pnpm deploy:admin     # Admin dashboard only
```

**Never cancel** long-running terminal operations - they're actually fast but may appear slow.

## 🗄️ Database & Migrations

**Schema** (`apps/auth/migrations/`):
- `0001_create_user_table.sql` - Users: id, email, created_at
- `0002_create_clients_table.sql` - OAuth clients config
- `0003_add_user_role.sql` - Adds role column (admin/user), indexes
- `0004_add_password_reset_required.sql` - Password reset flags

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

## 🔐 Authentication Patterns

**Auth Server** (`apps/auth/src/index.ts`):
- Uses OpenAuth's `PasswordProvider` with email verification codes
- `getOrCreateUser()` - Returns existing user or creates new (role='user')
- Sessions stored in KV: `session:${token}` keys
- Cloudflare bindings: `AUTH_DB` (D1), `AUTH_STORAGE` (KV), `RESEND_API_KEY` (Secret)

**Admin Dashboard** (`apps/admin/app/lib/auth.server.ts`):
- `requireAuth()` - Server-side auth guard, reads session from KV
- `getAuthenticatedUser()` - Validates session cookie against KV storage
- Admin routes check `user.role === 'admin'` via `requireAuth(request, env, true)`

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

## 📦 Deployment & CI/CD

**Preview Deployments** (automatic on PRs):
- Auth: `https://al-ummah-now-auth-pr-{PR-NUMBER}.mahmoud-s-darwish.workers.dev/`
- Admin: `https://al-ummah-now-auth-admin-pr-{PR-NUMBER}.mahmoud-s-darwish.workers.dev/`

**Production**:
- Auth: `https://al-ummah-now-auth.alummahnow.workers.dev`
- Admin: `https://al-ummah-now-auth-admin.alummahnow.workers.dev`

**GitHub Actions**: `.github/workflows/deploy.yml` handles CI/CD with separate jobs for auth/admin

## 🛠️ Project Conventions

- **No linting tools** - manual code review required
- **No test framework** - manual validation only
- **TypeScript strict mode** - all code strongly typed
- **Server-side rendering** - Admin uses React Router v7 SSR
- **Shared subjects schema** (`apps/auth/src/index.ts`): Defines user type validation with Valibot
- **Migrations are sequential** - numbered prefixes (0001, 0002, etc.)

## 🚨 Common Pitfalls

1. **Wrong package manager**: Always use `pnpm`, not `npm` or `yarn`
2. **Missing bindings**: Ensure `wrangler.json` has `AUTH_DB`, `AUTH_STORAGE` bindings
3. **Auth without KV**: Admin routes fail if `AUTH_STORAGE` unavailable (check `env` parameter)
4. **Type generation**: Run `pnpm run types` in `apps/auth` after changing `wrangler.json`
5. **Database access**: D1 binding only available with `pnpm dev:wrangler` for admin (not `pnpm dev`)