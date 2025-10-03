# Al Ummah Now - User Profile Application

A separate OAuth client application that demonstrates the proper architecture for authenticating with the Al Ummah Now auth server.

## Architecture

This app solves the 522 timeout issue that occurred when the auth server tried to authenticate users on its own landing page.

**Why this works:**

```
┌─────────────────────┐         OAuth Flow         ┌─────────────────────┐
│   Profile App       │◄──────────────────────────►│   Auth Server       │
│  (profile-app.net)  │                            │  (auth.net)         │
│                     │                            │                     │
│  1. User clicks     │──── Redirect to /authorize │  2. Shows login     │
│     "Login"         │                            │     form            │
│                     │                            │                     │
│  4. Receives code   │◄─── Redirect with code ────│  3. User logs in    │
│                     │                            │                     │
│  5. Calls           │──── POST /token ───────────►│  6. Returns tokens  │
│     client.exchange()│                            │                     │
│                     │                            │                     │
│  7. Creates session │                            │                     │
│     & shows profile │                            │                     │
└─────────────────────┘                            └─────────────────────┘
```

**Key difference from the broken auth server flow:**

- ❌ **Old (Broken):** Auth server tried to call `client.exchange()` on itself → 522 timeout
- ✅ **New (Working):** Profile app calls `client.exchange()` on the auth server → Works perfectly

## Local Development

Run the profile app locally (on port 8788):

```bash
npm run dev:profile
```

Or with the auth server:

```bash
# Terminal 1 - Auth Server (port 8787)
npm run dev:auth

# Terminal 2 - Profile App (port 8788)
npm run dev:profile
```

Visit: http://localhost:8788

## Deployment

Deploy to Cloudflare Workers:

```bash
npm run deploy:profile
```

Or deploy everything:

```bash
npm run deploy:all
```

## Configuration

The profile app needs to know where the auth server is. This is configured in [wrangler.json](./wrangler.json):

```json
{
  "vars": {
    "AUTH_SERVER_URL": "https://al-ummah-now-auth.alummahnow.workers.dev"
  }
}
```

For local development, it defaults to `http://localhost:8787`.

## Features

- ✅ OAuth 2.0 authorization code flow
- ✅ Session management with KV storage
- ✅ User profile display
- ✅ Secure cookie handling
- ✅ Role-based badges (admin/user)
- ✅ Beautiful, responsive UI

## How It Works

1. **User visits profile app** → Shows login button
2. **User clicks "Sign In"** → Redirects to auth server's `/authorize` endpoint
3. **User enters email & code** → On the auth server
4. **Auth server redirects back** → To profile app's `/callback` with authorization code
5. **Profile app exchanges code** → Calls auth server's `/token` endpoint (this is the key!)
6. **Profile app creates session** → Stores in KV and sets cookie
7. **User sees profile** → With email, role, and other info

## Why This Architecture?

Cloudflare Workers **cannot make HTTP requests to themselves** in production. The auth server's landing page tried to do this, causing 522 timeouts.

By separating the client (profile app) from the server (auth server), we allow proper OAuth flow:
- The profile app is a **client** that makes external HTTP requests to the auth server
- The auth server is a **server** that handles OAuth endpoints
- No circular requests = No 522 errors!

## Client ID

The profile app uses the client ID: `profile-app`

This should be registered in the auth server's client configuration.
