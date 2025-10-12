# API Reference

Complete API documentation for the Al Ummah Now Authentication Server.

## Base URL

- **Local Development**: `http://localhost:8787`
- **Production**: `https://your-auth-server.workers.dev`

## Authentication

The auth server uses OAuth 2.0 for authentication. All client applications must be configured as OAuth clients to interact with the server.

## Endpoints

### OAuth 2.0 Endpoints

These endpoints are provided by OpenAuth.js and follow the OAuth 2.0 specification.

#### `GET /authorize`

Start the OAuth authorization flow.

**Query Parameters:**
- `client_id` (string, required): Your application's client ID
- `redirect_uri` (string, required): Where to redirect after authorization
- `response_type` (string, required): Must be `code`
- `state` (string, optional but recommended): Random string to prevent CSRF

**Response:**
- Redirects to login UI if user is not authenticated
- Redirects to redirect_uri with authorization code if user is authenticated

**Example:**
```http
GET /authorize?client_id=profile&redirect_uri=http://localhost:8788/callback&response_type=code&state=random123
```

#### `POST /token`

Exchange authorization code for access token.

**Content-Type:** `application/x-www-form-urlencoded`

**Body Parameters:**
- `grant_type` (string, required): Must be `authorization_code`
- `code` (string, required): Authorization code from /authorize
- `redirect_uri` (string, required): Same redirect_uri used in /authorize
- `client_id` (string, required): Your application's client ID
- `client_secret` (string, required): Your application's client secret
- `code_verifier` (string, optional): PKCE code verifier

**Response:** `200 OK`
```json
{
  "access_token": "eyJhbGc...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "eyJhbGc...",
  "subject": {
    "type": "user",
    "properties": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "user@example.com",
      "role": "user"
    }
  }
}
```

**Example:**
```bash
curl -X POST http://localhost:8787/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=abc123" \
  -d "redirect_uri=http://localhost:8788/callback" \
  -d "client_id=profile" \
  -d "client_secret=your-secret"
```

#### `POST /token` (Refresh Token)

Refresh an expired access token.

**Content-Type:** `application/x-www-form-urlencoded`

**Body Parameters:**
- `grant_type` (string, required): Must be `refresh_token`
- `refresh_token` (string, required): Refresh token from previous /token call
- `client_id` (string, required): Your application's client ID
- `client_secret` (string, required): Your application's client secret

**Response:** `200 OK`
```json
{
  "access_token": "eyJhbGc...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "eyJhbGc...",
  "subject": {
    "type": "user",
    "properties": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "user@example.com",
      "role": "user"
    }
  }
}
```

**Example:**
```bash
curl -X POST http://localhost:8787/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token" \
  -d "refresh_token=eyJhbGc..." \
  -d "client_id=profile" \
  -d "client_secret=your-secret"
```

### Custom Endpoints

#### `GET /`

Root endpoint redirects to the configured profile app.

**Response:** `302 Found`
- **Location:** Value of `PROFILE_APP_URL` environment variable

**Example:**
```http
GET /
→ 302 Redirect to http://localhost:8788
```

#### `GET /logout`

Log out the current user by deleting their session.

**Request:**
- Must include session cookie

**Response:** `302 Found`
- **Location:** Auth server root URL
- **Set-Cookie:** Clears `auth_session` cookie

**Example:**
```bash
curl -X GET http://localhost:8787/logout \
  -H "Cookie: auth_session=your-session-token" \
  -i
```

**Response:**
```http
HTTP/1.1 302 Found
Location: http://localhost:8787
Set-Cookie: auth_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0
```

## User Subject

The user subject is returned in the token response and contains user information.

```typescript
interface UserSubject {
  type: "user";
  properties: {
    id: string;        // UUID
    email: string;     // User's email address
    role: string;      // "user" or "admin"
  };
}
```

## Error Responses

### OAuth Errors

OAuth endpoints follow the OAuth 2.0 error format:

```json
{
  "error": "invalid_request",
  "error_description": "Missing required parameter: client_id"
}
```

**Common OAuth Error Codes:**
- `invalid_request`: Missing or invalid parameters
- `unauthorized_client`: Client not authorized for this grant type
- `access_denied`: User denied authorization
- `unsupported_response_type`: Invalid response_type parameter
- `invalid_scope`: Requested scope is invalid
- `server_error`: Internal server error
- `temporarily_unavailable`: Server temporarily unavailable

### Custom Endpoint Errors

Custom endpoints return plain text or JSON errors:

**Example:**
```http
HTTP/1.1 500 Internal Server Error
Content-Type: text/plain

Profile app URL not configured
```

## Rate Limiting

**Login Attempts:**
- **Limit:** 5 attempts per IP address
- **Window:** 5 minutes (300 seconds)
- **Response on Limit:** Error thrown with retry time

**Example Error:**
```
Too many login attempts. Please try again in 4 minutes.
```

## Security Headers

All responses include comprehensive security headers:

```http
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
Strict-Transport-Security: max-age=31536000; includeSubDomains
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; ...
```

## Authentication Flow Examples

### Complete OAuth Flow

1. **Client redirects user to /authorize**
```http
GET /authorize?client_id=profile&redirect_uri=http://localhost:8788/callback&response_type=code&state=abc123
```

2. **User enters email and receives code**
```
Email: user@example.com
Code: 123456
```

3. **Auth server redirects back with code**
```http
HTTP/1.1 302 Found
Location: http://localhost:8788/callback?code=xyz789&state=abc123
```

4. **Client exchanges code for tokens**
```bash
curl -X POST http://localhost:8787/token \
  -d "grant_type=authorization_code" \
  -d "code=xyz789" \
  -d "client_id=profile" \
  -d "client_secret=secret" \
  -d "redirect_uri=http://localhost:8788/callback"
```

5. **Client receives tokens**
```json
{
  "access_token": "eyJhbGc...",
  "refresh_token": "eyJhbGc...",
  "expires_in": 3600,
  "subject": {
    "type": "user",
    "properties": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "user@example.com",
      "role": "user"
    }
  }
}
```

6. **Client can now access protected resources using access_token**

### Token Refresh Flow

1. **Access token expires**

2. **Client uses refresh token to get new access token**
```bash
curl -X POST http://localhost:8787/token \
  -d "grant_type=refresh_token" \
  -d "refresh_token=eyJhbGc..." \
  -d "client_id=profile" \
  -d "client_secret=secret"
```

3. **Client receives new tokens**
```json
{
  "access_token": "eyJhbGc...",  // New access token
  "refresh_token": "eyJhbGc...", // New refresh token
  "expires_in": 3600
}
```

## Database Schema

### User Table

```sql
CREATE TABLE user (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  role TEXT DEFAULT 'user',
  password_reset_required BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_user_email ON user(email);
CREATE INDEX idx_user_role ON user(role);
```

## KV Storage

The auth server uses Cloudflare KV for session and rate limiting storage:

### Session Keys

**Format:** `session:{sessionToken}`

**Value:**
```json
{
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "role": "user"
  },
  "expiresAt": 1735689600000
}
```

**TTL:** 7 days (604800 seconds)

### Rate Limit Keys

**Format:** `login:{ipAddress}`

**Value:** Integer count of attempts

**TTL:** 300 seconds (5 minutes)

## Configuration

### Environment Variables

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `RESEND_API_KEY` | Yes | Resend API key for sending emails | `re_abc123...` |
| `PROFILE_APP_URL` | Yes | URL of the profile app | `http://localhost:8788` |
| `OPENAUTH_ISSUER` | No | OAuth issuer identifier | `http://localhost:8787` |

### D1 Database

- **Binding Name:** `AUTH_DB`
- **Purpose:** User data and logs
- **Migrations:** See `apps/auth/migrations/`

### KV Namespace

- **Binding Name:** `AUTH_STORAGE`
- **Purpose:** Sessions and rate limiting
- **TTL:** Varies by key type

## Client Configuration

To connect a client application to the auth server, you need:

1. **Client ID:** Unique identifier for your app (e.g., `profile`, `admin`)
2. **Client Secret:** Secret key for token exchange
3. **Redirect URI:** Where users return after auth (e.g., `http://localhost:8788/callback`)

### Example Client Setup

```typescript
import { createClient } from "@openauthjs/openauth/client";

const client = createClient({
  clientID: "profile",
  issuer: "http://localhost:8787",
});

// Start authorization
const authorize = client.authorize("http://localhost:8788/callback", "code");

// Exchange code for tokens
const tokens = await client.exchange(code, "http://localhost:8788/callback");

// Verify token
const verified = await client.verify(subjects, tokens.access, {
  issuer: "http://localhost:8787",
});
```

See [SDK_USAGE.md](./SDK_USAGE.md) for complete examples.

## Logging

The auth server logs all requests, errors, and authentication events. Logs are stored in the D1 database.

**Log Levels:**
- `DEBUG`: Detailed debugging information
- `INFO`: General informational messages
- `WARN`: Warning messages
- `ERROR`: Error messages

**Viewing Logs:**
```bash
# View logs in database
npx wrangler d1 execute AUTH_DB --local \
  --command="SELECT * FROM logs ORDER BY timestamp DESC LIMIT 100"
```

## Testing

### Local Testing

```bash
# Start auth server
pnpm --filter auth dev

# Test authorization endpoint
curl "http://localhost:8787/authorize?client_id=test&redirect_uri=http://localhost/callback&response_type=code"

# Test token endpoint (requires valid code)
curl -X POST http://localhost:8787/token \
  -d "grant_type=authorization_code" \
  -d "code=YOUR_CODE" \
  -d "client_id=test" \
  -d "client_secret=test-secret" \
  -d "redirect_uri=http://localhost/callback"
```

### Integration Tests

See [TESTING.md](./TESTING.md) for comprehensive testing documentation.

## Further Reading

- [QUICKSTART.md](./QUICKSTART.md) - Get started quickly
- [AUTHENTICATION_FLOWS.md](./AUTHENTICATION_FLOWS.md) - Detailed flow diagrams
- [SDK_USAGE.md](./SDK_USAGE.md) - Client SDK examples
- [ARCHITECTURE.md](./ARCHITECTURE.md) - System architecture
- [OpenAuth.js Documentation](https://github.com/openauthjs/openauth)
