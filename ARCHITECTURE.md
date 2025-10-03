# Al Ummah Now - System Architecture

## Overview

The Al Ummah Now authentication system consists of three main applications:

1. **Auth Server** - OpenAuth-based OAuth 2.0 provider
2. **Admin Dashboard** - React Router v7 app for user management
3. **Profile App** - User-facing profile and authentication demo

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare Workers                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────┐      ┌──────────────────┐               │
│  │   Auth Server    │      │  Admin Dashboard │               │
│  │  (auth.net)      │◄────►│  (admin.net)     │               │
│  │                  │      │                  │               │
│  │ • /authorize     │      │ • User CRUD      │               │
│  │ • /token         │      │ • Role mgmt      │               │
│  │ • /callback (x)  │      │ • Analytics      │               │
│  │ • Landing page   │      └──────────────────┘               │
│  └──────────────────┘               │                          │
│          │                           │                          │
│          │                           │                          │
│          │      ┌──────────────────┐ │                          │
│          └─────►│   Profile App    │◄┘                          │
│                 │  (profile.net)   │                            │
│                 │                  │                            │
│                 │ • User profile   │                            │
│                 │ • /callback ✓    │                            │
│                 │ • Session mgmt   │                            │
│                 └──────────────────┘                            │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                   Shared Resources                              │
│                                                                 │
│  ┌─────────────────┐         ┌─────────────────┐              │
│  │  KV Namespace   │         │  D1 Database    │              │
│  │  (Sessions)     │         │  (Users, Logs)  │              │
│  └─────────────────┘         └─────────────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

## Application Details

### 1. Auth Server (apps/auth)

**Purpose:** OAuth 2.0 authentication provider

**Technology Stack:**
- OpenAuth (OAuth 2.0 implementation)
- Cloudflare Workers
- KV (session storage)
- D1 (user data, logs)

**Key Endpoints:**
- `GET /` - Landing page (documentation only)
- `GET /authorize` - OAuth authorization endpoint
- `POST /token` - OAuth token endpoint
- `GET /logout` - Clear session
- `GET /logs` - View application logs
- `GET /docs` - API documentation
- ~~`GET /callback`~~ - **Removed** (caused 522 errors)

**Why /callback was removed:**
The auth server tried to call `client.exchange()` on its own `/token` endpoint, creating a circular request that Cloudflare Workers cannot handle. This works in local development but fails in production with a 522 timeout.

### 2. Admin Dashboard (apps/admin)

**Purpose:** Administrative interface for user management

**Technology Stack:**
- React Router v7
- shadcn/ui components
- Cloudflare Pages
- KV & D1 (shared with auth)

**Features:**
- User list and search
- Role management (admin/user)
- User statistics dashboard
- OAuth authentication via auth server

**OAuth Flow:**
```
Admin App → Auth Server /authorize
         ← Redirect with code
Admin App → Auth Server /token (exchange code)
         ← Access & refresh tokens
Admin App → Creates session
```

### 3. Profile App (apps/profile) **NEW**

**Purpose:** User-facing profile application (OAuth client example)

**Technology Stack:**
- Cloudflare Workers
- OpenAuth Client SDK
- KV (session storage)
- D1 (read user data)

**Features:**
- User profile display
- OAuth authentication flow
- Session management
- Role badges

**Why This Exists:**
The profile app demonstrates the **correct architecture** for OAuth clients. It:
- Makes external HTTP requests to the auth server (no circular requests)
- Handles `/callback` endpoint properly
- Shows how other apps should integrate with the auth server

**OAuth Flow:**
```
Profile App → Auth Server /authorize
           ← Redirect with code
Profile App → Auth Server /token (exchange code) ✓ Works!
           ← Access & refresh tokens
Profile App → Creates session & displays profile
```

## The 522 Timeout Issue

### Problem

When the auth server's landing page tried to authenticate users, it would:

1. User clicks "Login" on auth server
2. Redirects to auth server `/authorize`
3. User enters credentials
4. Redirects back to auth server `/callback`
5. **Auth server calls `client.exchange()` → Makes HTTP request to itself**
6. **FAILS with 522 timeout in production**

### Why It Worked Locally But Not in Production

| Environment | Behavior |
|-------------|----------|
| **Local (wrangler dev)** | Runs in Node.js, HTTP requests to self work fine |
| **Production (Cloudflare)** | Workers cannot make HTTP requests to themselves |

### Solution

**Separate the client from the server:**

1. ✅ Auth server = OAuth provider (handles `/authorize`, `/token`)
2. ✅ Profile app = OAuth client (handles `/callback`, calls auth server)
3. ✅ No circular requests = No 522 errors!

## OAuth 2.0 Flow

### Authorization Code Flow

```
┌─────────┐                                           ┌──────────┐
│  User   │                                           │  Client  │
│ Browser │                                           │   App    │
└────┬────┘                                           └────┬─────┘
     │                                                      │
     │ 1. Click "Login"                                    │
     │────────────────────────────────────────────────────►│
     │                                                      │
     │ 2. Redirect to /authorize                           │
     │◄────────────────────────────────────────────────────│
     │                                                      │
     │         ┌──────────┐                                │
     │────────►│   Auth   │                                │
     │ 3. Show │  Server  │                                │
     │   login │          │                                │
     │   form  └──────────┘                                │
     │            │                                         │
     │ 4. Submit  │                                         │
     │   email &  │                                         │
     │   code     │                                         │
     │───────────►│                                         │
     │            │                                         │
     │            │ 5. Redirect with authorization code    │
     │◄───────────┴─────────────────────────────────────────│
     │                                                      │
     │                                                      │
     │                  6. Exchange code for tokens        │
     │                     ┌─────────────────────────┐     │
     │                     │  Client App             │     │
     │                     │  POST /token            │     │
     │                     │  with code & redirect_uri│    │
     │                     └─────────────────────────┘     │
     │                                │                    │
     │                                ▼                    │
     │                     ┌─────────────────────────┐     │
     │                     │  Auth Server            │     │
     │                     │  Validates code         │     │
     │                     │  Returns access +       │     │
     │                     │  refresh tokens         │     │
     │                     └─────────────────────────┘     │
     │                                │                    │
     │                                ▼                    │
     │                  7. Create session & redirect       │
     │◄────────────────────────────────────────────────────│
     │                                                      │
     │ 8. Display authenticated content                    │
     │────────────────────────────────────────────────────►│
     │                                                      │
```

## Shared Resources

### KV Namespace (AUTH_STORAGE)

Stores session data for all applications:

**Key Format:**
- `session:{uuid}` - Session data

**Session Structure:**
```typescript
{
  user: {
    id: string;
    email: string;
    role: "admin" | "user";
  },
  tokens: {
    access: string;
    refresh: string;
  },
  expiresAt: string; // ISO timestamp
}
```

### D1 Database (AUTH_DB)

**Tables:**
- `users` - User accounts
- `logs` - Application logs (auth, errors, requests)
- `clients` - OAuth client registrations

## Development

### Running Locally

```bash
# All apps in parallel
npm run dev

# Individual apps
npm run dev:auth     # Port 8787
npm run dev:admin    # Port 5174
npm run dev:profile  # Port 8788
```

### Deployment

```bash
# Deploy all
npm run deploy:all

# Individual deployments
npm run deploy:auth
npm run deploy:admin
npm run deploy:profile
```

## Security Considerations

1. **Session Storage:** Sessions stored in KV with 7-day TTL
2. **Cookie Security:** HttpOnly, Secure (in production), SameSite=Lax
3. **Token Validation:** Access tokens verified on each request
4. **Role-Based Access:** Admin endpoints require admin role
5. **CORS:** Not enabled (same-origin only)

## Future Enhancements

- [ ] Add refresh token rotation
- [ ] Implement PKCE for public clients
- [ ] Add MFA support
- [ ] Rate limiting on auth endpoints
- [ ] Audit log for admin actions
- [ ] Client registration UI
