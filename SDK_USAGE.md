# SDK Usage Guide

Complete guide for integrating with the Al Ummah Now Authentication Server using the OpenAuth.js client SDK.

## Table of Contents

- [Installation](#installation)
- [Client Setup](#client-setup)
- [Frontend Integration](#frontend-integration)
- [Backend Integration](#backend-integration)
- [Token Management](#token-management)
- [Session Management](#session-management)
- [Error Handling](#error-handling)
- [Complete Examples](#complete-examples)

## Installation

### For TypeScript/JavaScript Projects

```bash
npm install @openauthjs/openauth
# or
pnpm add @openauthjs/openauth
```

### For Cloudflare Workers

```bash
npm install @openauthjs/openauth
npm install --save-dev @cloudflare/workers-types
```

## Client Setup

### Basic Client Configuration

```typescript
import { createClient } from "@openauthjs/openauth/client";
import { subjects } from "./auth-client";

const client = createClient({
  clientID: "your-client-id", // e.g., "profile", "admin"
  issuer: "http://localhost:8787", // Auth server URL
});
```

### Subject Definition

Define the user subject type to ensure type safety:

```typescript
import { createSubjects } from "@openauthjs/openauth/subject";
import * as v from "valibot";

export const subjects = createSubjects({
  user: v.object({
    id: v.string(),
    email: v.pipe(v.string(), v.email()),
    role: v.string(),
  }),
});
```

## Frontend Integration

### React Example (Profile App)

Complete React integration with hooks and session management.

#### 1. Create Auth Hook

```typescript
// hooks/useAuth.ts
import { useState, useEffect } from "react";

interface User {
  id: string;
  email: string;
  role: string;
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check if user is authenticated
    fetch("/api/user")
      .then((res) => res.json())
      .then((data) => {
        if (data.user) {
          setUser(data.user);
        }
      })
      .catch((err) => console.error("Auth check failed:", err))
      .finally(() => setLoading(false));
  }, []);

  const login = () => {
    // Redirect to auth server
    window.location.href = "/auth/login";
  };

  const logout = () => {
    // Clear session
    fetch("/auth/logout", { method: "POST" })
      .then(() => {
        setUser(null);
        window.location.href = "/";
      })
      .catch((err) => console.error("Logout failed:", err));
  };

  return { user, loading, login, logout };
}
```

#### 2. Login Component

```typescript
// components/LoginButton.tsx
import { useAuth } from "../hooks/useAuth";

export function LoginButton() {
  const { user, loading, login, logout } = useAuth();

  if (loading) {
    return <div>Loading...</div>;
  }

  if (user) {
    return (
      <div>
        <span>Welcome, {user.email}!</span>
        <button onClick={logout}>Logout</button>
      </div>
    );
  }

  return <button onClick={login}>Sign In</button>;
}
```

#### 3. Protected Route

```typescript
// components/ProtectedRoute.tsx
import { useAuth } from "../hooks/useAuth";
import { Navigate } from "react-router-dom";

interface Props {
  children: React.ReactNode;
  requiredRole?: string;
}

export function ProtectedRoute({ children, requiredRole }: Props) {
  const { user, loading } = useAuth();

  if (loading) {
    return <div>Loading...</div>;
  }

  if (!user) {
    return <Navigate to="/login" />;
  }

  if (requiredRole && user.role !== requiredRole) {
    return <Navigate to="/unauthorized" />;
  }

  return <>{children}</>;
}
```

## Backend Integration

### Cloudflare Workers Example

Complete backend integration for a Cloudflare Worker client.

#### 1. Create Auth Client

```typescript
// src/auth-client.ts
import { createClient } from "@openauthjs/openauth/client";
import { createSubjects } from "@openauthjs/openauth/subject";
import * as v from "valibot";

export const subjects = createSubjects({
  user: v.object({
    id: v.string(),
    email: v.pipe(v.string(), v.email()),
    role: v.string(),
  }),
});

export function getAuthClient(env: Env) {
  return createClient({
    clientID: env.CLIENT_ID || "profile",
    issuer: env.AUTH_SERVER_URL || "http://localhost:8787",
  });
}
```

#### 2. OAuth Callback Handler

```typescript
// src/routes/callback.ts
import { getAuthClient, subjects } from "../auth-client";

export async function handleCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  // Handle OAuth errors
  if (error) {
    return new Response(`OAuth error: ${error}`, { status: 400 });
  }

  if (!code) {
    return new Response("Missing authorization code", { status: 400 });
  }

  try {
    const client = getAuthClient(env);

    // Exchange code for tokens
    const redirectUri = `${url.origin}/callback`;
    const tokens = await client.exchange(code, redirectUri);

    // Verify token
    const verified = await client.verify(subjects, tokens.access, {
      issuer: env.AUTH_SERVER_URL,
    });

    if (verified.err) {
      throw new Error("Token verification failed");
    }

    const user = verified.subject.properties;

    // Create session
    const sessionToken = crypto.randomUUID();
    const sessionData = {
      user,
      tokens,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    };

    // Store session in KV
    await env.SESSION_STORAGE.put(
      `session:${sessionToken}`,
      JSON.stringify(sessionData),
      { expirationTtl: 7 * 24 * 60 * 60 }
    );

    // Set session cookie
    const isLocalhost = url.hostname === "localhost";
    const cookieValue = [
      `session=${sessionToken}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=604800", // 7 days
      isLocalhost ? "" : "Secure",
    ]
      .filter(Boolean)
      .join("; ");

    return Response.redirect(url.origin, 302, {
      headers: {
        "Set-Cookie": cookieValue,
      },
    });
  } catch (error) {
    console.error("Callback error:", error);
    return new Response("Authentication failed", { status: 500 });
  }
}
```

#### 3. Login Handler

```typescript
// src/routes/login.ts
import { getAuthClient } from "../auth-client";

export async function handleLogin(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const client = getAuthClient(env);

  const redirectUri = `${url.origin}/callback`;
  const authorizeUrl = client.authorize(redirectUri, "code");

  return Response.redirect(authorizeUrl, 302);
}
```

#### 4. Logout Handler

```typescript
// src/routes/logout.ts
export async function handleLogout(
  request: Request,
  env: Env
): Promise<Response> {
  // Get session cookie
  const cookies = request.headers.get("Cookie") || "";
  const sessionMatch = cookies.match(/session=([^;]+)/);
  const sessionToken = sessionMatch?.[1];

  if (sessionToken) {
    // Delete session from KV
    await env.SESSION_STORAGE.delete(`session:${sessionToken}`);
  }

  // Clear session cookie
  const url = new URL(request.url);
  const isLocalhost = url.hostname === "localhost";
  const cookieValue = [
    "session=",
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    isLocalhost ? "" : "Secure",
  ]
    .filter(Boolean)
    .join("; ");

  return Response.redirect(url.origin, 302, {
    headers: {
      "Set-Cookie": cookieValue,
    },
  });
}
```

#### 5. Session Middleware

```typescript
// src/middleware/auth.ts
export async function getSession(request: Request, env: Env) {
  const cookies = request.headers.get("Cookie") || "";
  const sessionMatch = cookies.match(/session=([^;]+)/);
  const sessionToken = sessionMatch?.[1];

  if (!sessionToken) {
    return null;
  }

  const sessionData = await env.SESSION_STORAGE.get(
    `session:${sessionToken}`,
    "text"
  );

  if (!sessionData) {
    return null;
  }

  try {
    const session = JSON.parse(sessionData);

    // Check if session is expired
    if (session.expiresAt < Date.now()) {
      await env.SESSION_STORAGE.delete(`session:${sessionToken}`);
      return null;
    }

    return session;
  } catch (error) {
    console.error("Session parse error:", error);
    await env.SESSION_STORAGE.delete(`session:${sessionToken}`);
    return null;
  }
}

export function requireAuth(
  handler: (request: Request, env: Env, session: any) => Promise<Response>
) {
  return async (request: Request, env: Env): Promise<Response> => {
    const session = await getSession(request, env);

    if (!session) {
      return new Response("Unauthorized", { status: 401 });
    }

    return handler(request, env, session);
  };
}

export function requireRole(role: string) {
  return (
    handler: (request: Request, env: Env, session: any) => Promise<Response>
  ) => {
    return requireAuth(async (request, env, session) => {
      if (session.user.role !== role) {
        return new Response("Forbidden", { status: 403 });
      }

      return handler(request, env, session);
    });
  };
}
```

## Token Management

### Refresh Token Flow

```typescript
import { getAuthClient, subjects } from "./auth-client";

export async function refreshAccessToken(
  refreshToken: string,
  env: Env
): Promise<{ access: string; refresh: string } | null> {
  try {
    const client = getAuthClient(env);

    // Refresh tokens using the client (if supported)
    // Note: OpenAuth.js may not have built-in refresh token support
    // You may need to call the /token endpoint directly

    const response = await fetch(`${env.AUTH_SERVER_URL}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: env.CLIENT_ID,
        client_secret: env.CLIENT_SECRET,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return {
      access: data.access_token,
      refresh: data.refresh_token,
    };
  } catch (error) {
    console.error("Token refresh error:", error);
    return null;
  }
}
```

### Auto-Refresh Middleware

```typescript
export async function withTokenRefresh(
  request: Request,
  env: Env,
  session: any
): Promise<any> {
  const { tokens } = session;

  // Check if token is expired (decode JWT exp claim)
  const payload = JSON.parse(atob(tokens.access.split(".")[1]));
  const expiresAt = payload.exp * 1000; // Convert to milliseconds

  // Refresh if token expires in less than 5 minutes
  if (expiresAt - Date.now() < 5 * 60 * 1000) {
    const newTokens = await refreshAccessToken(tokens.refresh, env);

    if (newTokens) {
      // Update session with new tokens
      session.tokens = {
        access: newTokens.access,
        refresh: newTokens.refresh,
      };

      // Save updated session
      const sessionToken = getSessionTokenFromRequest(request);
      await env.SESSION_STORAGE.put(
        `session:${sessionToken}`,
        JSON.stringify(session),
        { expirationTtl: 7 * 24 * 60 * 60 }
      );
    }
  }

  return session;
}
```

## Session Management

### Session Storage Structure

```typescript
interface SessionData {
  user: {
    id: string;
    email: string;
    role: string;
  };
  tokens: {
    access: string;
    refresh: string;
  };
  expiresAt: number;
}
```

### Session Helper Functions

```typescript
// Create session
export async function createSession(
  env: Env,
  user: any,
  tokens: any
): Promise<string> {
  const sessionToken = crypto.randomUUID();
  const sessionData: SessionData = {
    user,
    tokens,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  };

  await env.SESSION_STORAGE.put(
    `session:${sessionToken}`,
    JSON.stringify(sessionData),
    { expirationTtl: 7 * 24 * 60 * 60 }
  );

  return sessionToken;
}

// Get session
export async function getSessionData(
  env: Env,
  sessionToken: string
): Promise<SessionData | null> {
  const data = await env.SESSION_STORAGE.get(`session:${sessionToken}`, "text");

  if (!data) {
    return null;
  }

  try {
    const session = JSON.parse(data);

    if (session.expiresAt < Date.now()) {
      await env.SESSION_STORAGE.delete(`session:${sessionToken}`);
      return null;
    }

    return session;
  } catch (error) {
    await env.SESSION_STORAGE.delete(`session:${sessionToken}`);
    return null;
  }
}

// Delete session
export async function deleteSessionData(
  env: Env,
  sessionToken: string
): Promise<void> {
  await env.SESSION_STORAGE.delete(`session:${sessionToken}`);
}
```

## Error Handling

### Common Errors and Solutions

```typescript
try {
  const tokens = await client.exchange(code, redirectUri);
} catch (error) {
  if (error.message.includes("invalid_grant")) {
    // Authorization code expired or already used
    return Response.redirect("/login?error=expired", 302);
  }

  if (error.message.includes("unauthorized_client")) {
    // Client credentials invalid
    console.error("Check CLIENT_ID and CLIENT_SECRET");
    return new Response("Configuration error", { status: 500 });
  }

  if (error.message.includes("access_denied")) {
    // User denied authorization
    return Response.redirect("/login?error=denied", 302);
  }

  // Generic error
  console.error("OAuth error:", error);
  return new Response("Authentication failed", { status: 500 });
}
```

## Complete Examples

### Example 1: Simple Cloudflare Worker Client

```typescript
// Complete minimal example
import { getAuthClient, subjects } from "./auth-client";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Login endpoint
    if (url.pathname === "/login") {
      const client = getAuthClient(env);
      const redirectUri = `${url.origin}/callback`;
      const authorizeUrl = client.authorize(redirectUri, "code");
      return Response.redirect(authorizeUrl, 302);
    }

    // Callback endpoint
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      if (!code) {
        return new Response("Missing code", { status: 400 });
      }

      const client = getAuthClient(env);
      const tokens = await client.exchange(code, `${url.origin}/callback`);
      const verified = await client.verify(subjects, tokens.access, {
        issuer: env.AUTH_SERVER_URL,
      });

      if (verified.err) {
        return new Response("Verification failed", { status: 401 });
      }

      return new Response(
        JSON.stringify({
          user: verified.subject.properties,
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response("Hello World!");
  },
};
```

### Example 2: React + Express Backend

See the [apps/profile](./apps/profile) and [apps/admin](./apps/admin) directories for complete working examples.

## Testing

### Local Testing

```bash
# Start auth server
pnpm --filter auth dev

# Start your client app
pnpm --filter your-app dev

# Test login flow
open http://localhost:YOUR_PORT/login
```

### Integration Tests

```typescript
import { describe, it, expect } from "vitest";
import { getAuthClient } from "./auth-client";

describe("OAuth Flow", () => {
  it("should generate authorize URL", () => {
    const client = getAuthClient({
      CLIENT_ID: "test",
      AUTH_SERVER_URL: "http://localhost:8787",
    });

    const url = client.authorize("http://localhost/callback", "code");

    expect(url).toContain("/authorize");
    expect(url).toContain("client_id=test");
    expect(url).toContain("response_type=code");
  });
});
```

## Further Reading

- [API_REFERENCE.md](./API_REFERENCE.md) - Complete API documentation
- [AUTHENTICATION_FLOWS.md](./AUTHENTICATION_FLOWS.md) - Flow diagrams
- [QUICKSTART.md](./QUICKSTART.md) - Getting started guide
- [OpenAuth.js Documentation](https://github.com/openauthjs/openauth)
