# Admin Dashboard App

React Router v7 admin dashboard for managing Al Ummah Now authentication users.

## Configuration

### Auth Server URL

The Auth server's origin comes from the Worker's `AUTH_SERVER_URL` var (`getAuthServerUrl` in
`app/lib/config.ts`):

- `wrangler.dev.json` (`pnpm dev`, local E2E): `http://localhost:3301`, the local Auth server. To run the
  admin against another Auth server (another port, or QA), change it there or pass `--var`.
- `wrangler.qa.json`, `wrangler.json` (stage and production): the deployed Auth server.
- With no `AUTH_SERVER_URL`, a localhost admin uses `http://localhost:3301` and any other host uses
  `https://auth.alummahnow.net`.

## Development

### Prerequisites

1. **Auth server must be running** for OAuth to work:
   ```bash
   # In another terminal
   cd ../auth
   pnpm dev
   ```

2. **Configure OAuth client** in the auth server database:
   ```sql
   INSERT INTO clients (client_id, redirect_uri, theme_title, theme_primary, theme_favicon, theme_logo_dark, theme_logo_light)
   VALUES (
     'admin-dashboard',
     'http://localhost:5174/auth/callback',
     'Admin Dashboard',
     '#0ea5e9',
     'https://al-ummah-now-images.b-cdn.net/favicon_io/favicon.ico',
     'https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png',
     'https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png'
   );
   ```

### Run Development Server

**Option 1: Simple dev (no D1 database)**
```bash
pnpm dev
```
- Runs on http://localhost:5174
- Shows UI without database access
- Auth redirects to login page

**Option 2: With Cloudflare bindings**
```bash
# Build first
pnpm build

# Run with wrangler
pnpm dev:wrangler
```
- Runs on http://localhost:5175
- Full D1 and KV access
- Complete authentication flow

## Authentication Flow

1. User visits admin dashboard
2. No session → Redirect to `/login`
3. Click "Sign In with OpenAuth"
4. Redirect to auth server: `{AUTH_SERVER}/authorize?...`
5. User authenticates via email
6. Auth server redirects back: `/auth/callback?code=...`
7. Exchange code for token
8. Verify user has admin role
9. Create session in KV storage
10. Set HTTP-only cookie
11. Redirect to dashboard

## Protected Routes

All routes except `/login` and `/auth/callback` require authentication:

- `/` - Dashboard (requires admin)
- `/users` - User management (requires admin)

Non-admin users are shown a 403 Forbidden error.

## Deployment

Deploy to Cloudflare Workers:

```bash
# Build and deploy
pnpm build
pnpm deploy
```

Deploys to: `al-ummah-now-auth-admin` worker

### Environment-specific Configuration

For production deployment, update the OAuth client redirect_uri:

```sql
UPDATE clients
SET redirect_uri = 'https://al-ummah-now-auth-admin.alummahnow.workers.dev/auth/callback'
WHERE client_id = 'admin-dashboard';
```

## Project Structure

```
app/
├── routes/
│   ├── _index.tsx           # Dashboard (protected)
│   ├── users._index.tsx     # User management (protected)
│   ├── login.tsx            # Login page (public)
│   └── auth.callback.tsx    # OAuth callback handler
├── components/ui/           # shadcn/ui components
├── lib/
│   ├── config.ts           # ⚙️ Auth server configuration
│   ├── auth.server.ts      # Authentication utilities
│   ├── db.server.ts        # Database functions
│   └── utils.ts            # Helper functions
├── root.tsx                # Root layout
└── routes.ts               # Route configuration
```

## Customization

### Change Auth Server URL

Set `AUTH_SERVER_URL` in the wrangler config for that environment (see "Auth Server URL" above).

### Change OAuth Client ID

Edit `app/lib/config.ts`:

```typescript
export const config = {
  oauth: {
    clientId: "your-client-id",  // ← Must match auth server
    // ...
  },
};
```

Don't forget to update the client configuration in the auth server database!

## Troubleshooting

### Redirect Loop
- Check that `AUTH_STORAGE` KV binding is configured
- Verify the auth server is running
- Clear cookies and try again

### 403 Forbidden
- User must have `role = 'admin'` in database
- Check user role: `SELECT * FROM user WHERE email = 'your@email.com'`

### OAuth Error
- Verify `admin-dashboard` client exists in auth server
- Check `redirect_uri` matches exactly
- Ensure auth server is accessible

### No Database Access
- Run with `pnpm dev:wrangler` instead of `pnpm dev`
- Check `wrangler.json` has correct D1 binding
- Verify database migrations have been applied

## Session Management

Sessions are stored in KV with:
- **Key**: `session:{uuid}`
- **Value**: `{ user: {...}, expiresAt: "..." }`
- **TTL**: 7 days

Sessions are validated on every request to protected routes.
