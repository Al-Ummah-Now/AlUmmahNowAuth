# Quick Start Guide

Get the Al Ummah Now authentication system running in minutes!

## Prerequisites

- Node.js 18+ or Node.js 20+
- pnpm 9.0.0+
- Cloudflare account (for deployment)

## Installation

```bash
# Clone the repository
cd AlUmmahNowAuth

# Install all dependencies
pnpm install
```

## Local Development

### Option 1: Run All Apps

```bash
npm run dev
```

This starts all three applications in parallel:
- **Auth Server**: http://localhost:8787
- **Admin Dashboard**: http://localhost:5174
- **Profile App**: http://localhost:8788

### Option 2: Run Individual Apps

```bash
# Terminal 1 - Auth Server
npm run dev:auth

# Terminal 2 - Admin Dashboard (optional)
npm run dev:admin

# Terminal 3 - Profile App (optional)
npm run dev:profile
```

## First Time Setup

### 1. Run Database Migrations

```bash
cd apps/auth
npm run migrations:local
```

### 2. Test the Profile App

1. Visit http://localhost:8788
2. Click "Sign In"
3. You'll be redirected to http://localhost:8787/authorize
4. Enter your email address
5. Check your email for the login code
6. Enter the code
7. You'll be redirected back to the profile app
8. See your profile!

### 3. Test the Admin Dashboard

1. Visit http://localhost:5174
2. Click "Admin Sign In"
3. Complete the OAuth flow (same as profile app)
4. You'll see the admin dashboard with user statistics

**Note:** Only users with `role = "admin"` can access the admin dashboard.

## Understanding the Apps

### Auth Server (Port 8787)

The OAuth 2.0 authentication server.

**What you'll see:**
- Landing page with documentation links
- OAuth login flow when redirected from other apps
- API documentation at `/docs`
- Logs viewer at `/logs`

**Important:** Don't try to login directly on the auth server's landing page - use the Profile App or Admin Dashboard instead. (This is to avoid the 522 timeout issue.)

### Profile App (Port 8788)

A user-facing profile application that demonstrates OAuth client integration.

**What you'll see:**
- Login button → Redirects to auth server
- After login: User profile with email, ID, and role badge
- Clean, modern UI

**This is the recommended way** to test the authentication flow!

### Admin Dashboard (Port 5174)

Administrative interface for managing users.

**What you'll see:**
- Dashboard with user statistics
- User management page with search and CRUD operations
- Requires admin role

## Testing the OAuth Flow

### Happy Path

1. Start all apps: `npm run dev`
2. Visit Profile App: http://localhost:8788
3. Click "Sign In"
4. Complete email verification
5. See your profile! ✅

### Admin Access

1. Make yourself an admin:
   ```bash
   cd apps/auth
   npx wrangler d1 execute AUTH_DB --local \
     --command="UPDATE users SET role = 'admin' WHERE email = 'your@email.com'"
   ```
2. Visit Admin Dashboard: http://localhost:5174
3. Click "Admin Sign In"
4. See the dashboard! ✅

## Deployment

### 1. Deploy Auth Server

```bash
npm run deploy:auth
```

This will:
- Run database migrations on production
- Deploy to Cloudflare Workers
- Output your auth server URL

### 2. Update Environment Variables

Update `apps/admin/wrangler.json` and `apps/profile/wrangler.json`:

```json
{
  "vars": {
    "AUTH_SERVER_URL": "https://your-auth-server.workers.dev"
  }
}
```

### 3. Deploy Client Apps

```bash
npm run deploy:admin
npm run deploy:profile
```

### 4. Configure Custom Domains (Optional)

In Cloudflare dashboard:
- Auth Server → `auth.yourdomain.com`
- Admin Dashboard → `admin.yourdomain.com`
- Profile App → `profile.yourdomain.com`

Update the `AUTH_SERVER_URL` in wrangler configs accordingly.

## Common Issues

### Issue: 522 Timeout on Auth Server Landing Page

**Problem:** Clicking "Login" on the auth server's landing page causes a 522 error.

**Solution:** Don't use the auth server's landing page for login! Use the Profile App (http://localhost:8788) or Admin Dashboard instead.

**Why:** The auth server cannot make HTTP requests to itself in production. The profile app is a separate client that properly handles the OAuth flow.

### Issue: Email Not Sending

**Problem:** Login codes aren't being sent.

**Solution:**
1. Check if `RESEND_API_KEY` is set in `apps/auth/wrangler.json`
2. For local dev, check the console logs - the code is printed there
3. Verify your Resend account is active

### Issue: Admin Access Denied

**Problem:** Can't access admin dashboard.

**Solution:**
1. Verify your user has `role = "admin"` in the database
2. Check the logs: http://localhost:8787/logs
3. Make sure you're authenticated

### Issue: Session Not Persisting

**Problem:** Logged out after page refresh.

**Solution:**
1. Check browser cookies - look for `profile_session` or `auth_session`
2. Verify KV namespace is properly configured in wrangler.json
3. Check session expiration (7 days by default)

## Next Steps

1. ✅ Read [ARCHITECTURE.md](./ARCHITECTURE.md) to understand the system design
2. ✅ Explore the admin dashboard user management features
3. ✅ Check out the logs at http://localhost:8787/logs
4. ✅ Deploy to production when ready

## Need Help?

- Check the logs: http://localhost:8787/logs
- Review the architecture docs: [ARCHITECTURE.md](./ARCHITECTURE.md)
- See individual app READMEs:
  - [Auth Server](./apps/auth/README.md)
  - [Admin Dashboard](./apps/admin/README.md)
  - [Profile App](./apps/profile/README.md)

## Development Tips

### Viewing Logs

```bash
# Auth server logs
npm run --prefix apps/auth tail

# Or view in browser
# http://localhost:8787/logs
```

### Database Queries

```bash
# Local database
cd apps/auth
npx wrangler d1 execute AUTH_DB --local --command="SELECT * FROM users"

# Production database
npx wrangler d1 execute AUTH_DB --remote --command="SELECT * FROM users"
```

### Clearing Sessions

```bash
# Clear all KV data (local)
rm -rf .wrangler/state

# Clear all KV data (production)
# Use Cloudflare dashboard → KV → AUTH_STORAGE
```

Happy coding! 🚀
