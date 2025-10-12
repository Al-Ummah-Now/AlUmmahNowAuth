# Auth Server

OAuth 2.0 authentication server for Al Ummah Now platform, built with OpenAuth and Cloudflare Workers.

## Overview

The auth server provides centralized authentication services using:

- **OAuth 2.0 Authorization Code Flow** - Industry-standard authentication protocol
- **Email-based passwordless login** - No passwords to manage or leak
- **OpenAuth framework** - Built on OpenAuth for OAuth 2.0 compliance
- **Cloudflare Workers** - Edge-deployed for low latency worldwide
- **D1 Database** - User data and application logs
- **KV Storage** - Session management and OAuth state

## Features

- Email-based passwordless authentication
- OAuth 2.0 authorization server
- Multi-tenant client support
- Role-based access control (admin/user)
- Session management with KV
- Request logging to D1
- Rate limiting on auth endpoints
- Security headers (CSP, HSTS, XSS protection)
- Custom branding per OAuth client

## Quick Start

### Prerequisites

- Node.js 18+ or 20+
- pnpm 9.0.0+
- Cloudflare account
- Resend API key (for sending emails)

### Installation

```bash
# From project root
pnpm install

# Navigate to auth app
cd apps/auth
```

### Local Development

#### 1. Configure Environment

```bash
# Copy example file
cp .dev.vars.example .dev.vars

# Edit .dev.vars
PROFILE_APP_URL=http://localhost:8788
RESEND_API_KEY=re_your_api_key_here
```

#### 2. Run Database Migrations

```bash
pnpm migrations:local
```

This creates the required tables:
- `user` - User accounts
- `clients` - OAuth client registrations
- `logs` - Application logs

#### 3. Start Development Server

```bash
pnpm dev
```

Server runs at: http://localhost:8787

**Available endpoints:**
- `/` - Landing page (redirects to profile app)
- `/authorize` - OAuth authorization endpoint
- `/token` - OAuth token endpoint
- `/logout` - Clear session
- `/logs` - View application logs (admin only)

### Testing Locally

**Don't use the auth server directly for login!** Instead, use a client app:

#### Option 1: Profile App (Recommended)

```bash
# In another terminal
cd apps/profile
pnpm dev

# Visit http://localhost:8788
# Click "Sign In"
```

#### Option 2: Admin Dashboard

```bash
# In another terminal
cd apps/admin
pnpm dev

# Visit http://localhost:5174
# Click "Admin Sign In"
```

### Why Not Use Auth Server Directly?

The auth server cannot make HTTP requests to itself in production (causes 522 timeout). Client apps make external requests to the auth server, which works correctly.

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `RESEND_API_KEY` | Resend API key for sending emails | `re_abc123...` |
| `PROFILE_APP_URL` | Profile app URL for redirects | `http://localhost:8788` |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENAUTH_ISSUER` | OAuth issuer URL | Inferred from request URL |

### Setting Variables

**Local development (.dev.vars):**
```bash
PROFILE_APP_URL=http://localhost:8788
RESEND_API_KEY=re_your_key_here
```

**Production (wrangler.json):**
```json
{
  "vars": {
    "PROFILE_APP_URL": "https://profile.alummahnow.net"
  }
}
```

**Production secrets (use Wrangler CLI):**
```bash
wrangler secret put RESEND_API_KEY
# Enter your key when prompted
```

## Database Setup

### Migrations

The auth server uses Cloudflare D1 for persistent storage.

**Run migrations locally:**
```bash
pnpm migrations:local
```

**Run migrations in production:**
```bash
pnpm migrations:remote
```

**Create new migration:**
```bash
npx wrangler d1 migrations create AUTH_DB migration_name
```

### Database Schema

#### user table

```sql
CREATE TABLE user (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  password_reset_required BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**Columns:**
- `id` - Unique user identifier (auto-generated hex string)
- `email` - User's email address (unique)
- `role` - User role: "admin" or "user"
- `password_reset_required` - Flag for admin-created users
- `created_at` - Account creation timestamp

#### clients table

```sql
CREATE TABLE clients (
  client_id TEXT PRIMARY KEY,
  redirect_uri TEXT NOT NULL,
  theme_title TEXT NOT NULL,
  theme_primary TEXT NOT NULL,
  theme_favicon TEXT NOT NULL,
  theme_logo_dark TEXT NOT NULL,
  theme_logo_light TEXT NOT NULL
);
```

**Purpose:** Store OAuth client configurations with custom branding.

#### logs table

```sql
CREATE TABLE logs (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT,
  request_id TEXT,
  user_id TEXT,
  ip_address TEXT
);
```

**Purpose:** Store application logs for debugging and monitoring.

### Database Queries

**Local database:**
```bash
# Query users
npx wrangler d1 execute AUTH_DB --local --command="SELECT * FROM user"

# Make user admin
npx wrangler d1 execute AUTH_DB --local \
  --command="UPDATE user SET role = 'admin' WHERE email = 'you@example.com'"

# View logs
npx wrangler d1 execute AUTH_DB --local --command="SELECT * FROM logs ORDER BY timestamp DESC LIMIT 10"
```

**Production database:**
```bash
# Same commands, replace --local with --remote
npx wrangler d1 execute AUTH_DB --remote --command="SELECT * FROM user"
```

## API Endpoints

### OAuth 2.0 Endpoints

#### GET /authorize

Initiate OAuth authorization flow.

**Parameters:**
- `client_id` (required) - Client application identifier
- `redirect_uri` (required) - Where to redirect after auth
- `response_type` (required) - Must be "code"
- `state` (recommended) - CSRF protection token

**Example:**
```http
GET /authorize?client_id=profile&redirect_uri=http://localhost:8788/callback&response_type=code&state=random_state HTTP/1.1
Host: localhost:8787
```

**Response:**
- Shows email login form (OpenAuth UI)
- After authentication, redirects to `redirect_uri` with authorization code

#### POST /token

Exchange authorization code for access tokens.

**Request:**
```http
POST /token HTTP/1.1
Host: localhost:8787
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=AUTH_CODE&redirect_uri=http://localhost:8788/callback&client_id=profile
```

**Response:**
```json
{
  "access_token": "eyJhbGc...",
  "refresh_token": "eyJhbGc...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

**Refresh token:**
```http
POST /token HTTP/1.1
Host: localhost:8787
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token=REFRESH_TOKEN&client_id=profile
```

### Authentication Endpoints

#### GET /logout

Clear user session and redirect to homepage.

**Request:**
```http
GET /logout HTTP/1.1
Host: localhost:8787
Cookie: auth_session=uuid-here
```

**Response:**
```http
HTTP/1.1 302 Found
Location: /
Set-Cookie: auth_session=; Max-Age=0
```

### Utility Endpoints

#### GET /logs

View application logs (requires authentication).

**Request:**
```http
GET /logs HTTP/1.1
Host: localhost:8787
Cookie: auth_session=uuid-here
```

**Response:**
- HTML page with log viewer
- Filterable by level (debug, info, warn, error)
- Searchable by message, user ID, IP

#### GET / and GET /docs

Redirect to profile app.

## Authentication Flow

See [AUTHENTICATION_FLOWS.md](../../AUTHENTICATION_FLOWS.md) for detailed flow diagrams and examples.

### High-Level Flow

1. **User clicks "Sign In"** on client app
2. **Client redirects** to `/authorize` with client_id
3. **Auth server shows** email input form
4. **User enters email**, server sends 6-digit code
5. **User enters code**, server verifies
6. **Server redirects** back to client with authorization code
7. **Client exchanges code** for access/refresh tokens
8. **Client creates session** and stores tokens
9. **User is authenticated** and can access protected resources

## Session Management

Sessions are stored in Cloudflare KV with a 7-day TTL.

### Session Structure

**KV Key:** `session:{uuid}`

**KV Value:**
```json
{
  "user": {
    "id": "user-id",
    "email": "user@example.com",
    "role": "user"
  },
  "tokens": {
    "access": "access_token",
    "refresh": "refresh_token"
  },
  "expiresAt": "2025-10-19T12:00:00.000Z"
}
```

**Cookie:**
```
auth_session=uuid; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800
```

### Session Security

- **HttpOnly** - JavaScript cannot access (XSS protection)
- **Secure** - HTTPS only in production
- **SameSite=Lax** - CSRF protection while allowing OAuth
- **7-day expiration** - Auto-cleanup after 7 days

## Rate Limiting

Rate limiting protects against brute force attacks.

### Current Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| Login code sending | 5 attempts | 5 minutes per IP |

### Implementation

```typescript
import { checkRateLimit, getClientIP } from './rate-limit';

const clientIP = getClientIP(request);
const rateLimit = await checkRateLimit(
  env.AUTH_STORAGE,
  `login:${clientIP}`,
  5,  // limit
  300 // window in seconds
);

if (!rateLimit.allowed) {
  throw new Error('Too many attempts');
}
```

### Bypassing Rate Limits (Development)

Rate limits are enforced in all environments. To test without limits:

1. Clear KV data: `rm -rf ../../.wrangler/state`
2. Wait for rate limit window to expire
3. Use different IP address (VPN)

## Security Features

### Security Headers

All responses include comprehensive security headers:

```typescript
// Automatically added to all responses
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
Strict-Transport-Security: max-age=31536000; includeSubDomains (production)
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; ...
```

### CSRF Protection

- State parameter in OAuth flow
- SameSite=Lax cookie attribute
- Origin validation on token requests

### Token Security

- **Access tokens:** Short-lived (1 hour), JWT format
- **Refresh tokens:** Longer-lived (30 days), rotated on use
- **Single-use codes:** Authorization codes expire after 10 minutes

### Email Security

- Email validation using valibot
- SPF/DKIM via Resend
- 6-digit codes (1 million combinations)
- 5-minute code expiration

## Logging

Application logs are stored in D1 for debugging and monitoring.

### Log Levels

- **debug** - Detailed information for debugging
- **info** - General informational messages
- **warn** - Warning messages (recoverable issues)
- **error** - Error messages (unrecoverable issues)

### Logging API

```typescript
import { logger } from './logger';

// Initialize (done automatically in index.ts)
logger.setDatabase(env.AUTH_DB, true);
logger.setContext(ctx);

// Log messages
logger.debug('Debugging info', { key: 'value' });
logger.info('User logged in', { userId: '123' });
logger.warn('Unusual activity', { ip: '1.2.3.4' });
logger.error('Failed to send email', { error: err.message });
```

### Viewing Logs

**In browser:**
- Visit http://localhost:8787/logs (requires auth)

**In terminal:**
```bash
# Tail live logs
pnpm tail

# Query D1 directly
npx wrangler d1 execute AUTH_DB --local \
  --command="SELECT * FROM logs WHERE level = 'error' ORDER BY timestamp DESC LIMIT 10"
```

### Log Retention

Logs are retained indefinitely in D1. To clean up old logs:

```bash
# Delete logs older than 30 days
npx wrangler d1 execute AUTH_DB --remote \
  --command="DELETE FROM logs WHERE timestamp < datetime('now', '-30 days')"
```

## Deployment

### Prerequisites

1. Cloudflare account with Workers enabled
2. D1 database created
3. KV namespace created
4. Resend API key

### First-Time Setup

#### 1. Create D1 Database

```bash
npx wrangler d1 create al-ummah-now-d1
```

Copy the `database_id` to `wrangler.json`.

#### 2. Create KV Namespace

```bash
npx wrangler kv:namespace create AUTH_STORAGE
```

Copy the `id` to `wrangler.json`.

#### 3. Configure Secrets

```bash
wrangler secret put RESEND_API_KEY
# Enter your Resend API key when prompted
```

#### 4. Update wrangler.json

```json
{
  "name": "al-ummah-now-auth",
  "compatibility_date": "2025-04-19",
  "kv_namespaces": [
    {
      "binding": "AUTH_STORAGE",
      "id": "your_kv_id_here"
    }
  ],
  "d1_databases": [
    {
      "binding": "AUTH_DB",
      "database_name": "al-ummah-now-d1",
      "database_id": "your_database_id_here",
      "migrations_dir": "migrations"
    }
  ],
  "vars": {
    "PROFILE_APP_URL": "https://profile.alummahnow.net"
  }
}
```

### Deploy

```bash
# From apps/auth directory
pnpm deploy
```

This will:
1. Run database migrations on production
2. Build the worker
3. Deploy to Cloudflare Workers
4. Output the deployed URL

**Note:** `predeploy` script automatically runs migrations before deployment.

### Custom Domain

1. Go to Cloudflare dashboard
2. Navigate to Workers & Pages
3. Select your worker
4. Click "Triggers" tab
5. Add custom domain (e.g., `auth.alummahnow.net`)

Update client apps' `AUTH_SERVER_URL` to use custom domain.

## Development

### Project Structure

```
apps/auth/
├── src/
│   ├── index.ts           # Main worker entry point
│   ├── users.ts           # User management functions
│   ├── session.ts         # Session management
│   ├── email.ts           # Email sending with retry logic
│   ├── logger.ts          # Logging utilities
│   ├── clients.ts         # OAuth client configuration
│   ├── auth-client.ts     # OpenAuth client setup
│   └── rate-limit.ts      # Rate limiting implementation
├── migrations/            # D1 database migrations
│   ├── 0001_create_user_table.sql
│   ├── 0002_create_clients_table.sql
│   └── ...
├── package.json
├── wrangler.json          # Cloudflare Workers config
├── tsconfig.json
└── .dev.vars.example      # Example environment variables
```

### Adding Features

#### Add New OAuth Client

1. **Create migration:**
```bash
npx wrangler d1 migrations create AUTH_DB add_new_client
```

2. **Insert client data:**
```sql
-- migrations/XXXX_add_new_client.sql
INSERT INTO clients (
  client_id,
  redirect_uri,
  theme_title,
  theme_primary,
  theme_favicon,
  theme_logo_dark,
  theme_logo_light
) VALUES (
  'new-client',
  'https://newclient.example.com/callback',
  'New Client',
  '#0891b2',
  'https://example.com/favicon.ico',
  'https://example.com/logo-dark.png',
  'https://example.com/logo-light.png'
);
```

3. **Run migration:**
```bash
pnpm migrations:local  # or migrations:remote
```

#### Add New User Role

1. **Update user creation logic in `users.ts`**
2. **Add role validation**
3. **Update admin checks in client apps**

#### Add Custom Endpoint

```typescript
// src/index.ts
if (url.pathname === '/custom-endpoint') {
  // Your logic here
  return new Response('Custom response', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}
```

### Testing

```bash
# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run tests with coverage
pnpm test:coverage
```

### Type Checking

```bash
pnpm type-check
```

## Troubleshooting

### Common Issues

#### Issue: Email Not Sending

**Symptoms:**
- No email received
- Error in logs: "RESEND_API_KEY not configured"

**Solutions:**
1. Check `.dev.vars` file exists and has `RESEND_API_KEY`
2. Verify Resend API key is valid
3. Check spam folder
4. View logs: http://localhost:8787/logs

#### Issue: 522 Timeout in Production

**Symptoms:**
- 522 error when clicking "Login" on auth server
- Works locally but fails in production

**Solution:**
Don't use auth server's landing page for login. Use Profile App or Admin Dashboard instead.

**Why:** Auth server cannot make HTTP requests to itself in Cloudflare Workers.

#### Issue: Migration Failed

**Symptoms:**
- Error: "no such table: user"
- Deployment fails

**Solution:**
```bash
# Check migration status
npx wrangler d1 migrations list AUTH_DB --local

# Run migrations
pnpm migrations:local

# For production
pnpm migrations:remote
```

#### Issue: Rate Limit Exceeded

**Symptoms:**
- Error: "Too many login attempts"
- Cannot send login code

**Solution:**
1. Wait 5 minutes
2. Clear KV data (local): `rm -rf ../../.wrangler/state`
3. Use different IP (production)

#### Issue: Session Not Persisting

**Symptoms:**
- Logged out after page refresh
- Cookie not set

**Solution:**
1. Check KV binding in `wrangler.json`
2. Verify cookie in browser DevTools
3. Check session expiration date
4. Try incognito mode (test for browser extensions)

#### Issue: Token Verification Failed

**Symptoms:**
- Error: "Invalid token"
- Client cannot verify access token

**Solution:**
1. Check `AUTH_SERVER_URL` in client app
2. Verify token hasn't expired (decode at jwt.io)
3. Ensure `client_id` matches in token request
4. Check issuer URL matches

### Debug Mode

Enable detailed logging:

```typescript
// src/index.ts
logger.setDatabase(env.AUTH_DB, true); // true = verbose logging
```

View logs:
```bash
pnpm tail  # Live logs
# or
# Visit http://localhost:8787/logs
```

## Performance

### Benchmarks

| Metric | Value |
|--------|-------|
| Cold start | ~50ms |
| Request latency (auth) | ~100-200ms |
| Request latency (token) | ~50-100ms |
| Email sending | ~500-1000ms |

### Optimization Tips

1. **Use KV for caching** - Cache user lookups
2. **Minimize D1 queries** - Batch queries when possible
3. **Use waitUntil for logging** - Don't block responses
4. **Enable compression** - Automatic in Cloudflare Workers

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for contribution guidelines.

## Security

See [SECURITY.md](../../SECURITY.md) for security policy and reporting vulnerabilities.

## License

MIT License - see [LICENSE](../../LICENSE) for details.

## Related Documentation

- [ARCHITECTURE.md](../../ARCHITECTURE.md) - System architecture overview
- [AUTHENTICATION_FLOWS.md](../../AUTHENTICATION_FLOWS.md) - Detailed auth flow diagrams
- [QUICKSTART.md](../../QUICKSTART.md) - Quick start guide for the entire system
- [Profile App README](../profile/README.md) - OAuth client example
- [Admin Dashboard README](../admin/README.md) - Admin interface

## Support

For issues and questions:
- GitHub Issues: [AlUmmahNowAuth/issues](https://github.com/yourusername/AlUmmahNowAuth/issues)
- Email: security@alummahnow.net (security issues only)

---

**Last Updated:** October 12, 2025
