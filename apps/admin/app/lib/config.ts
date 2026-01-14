// Configuration for the admin app

// Default client ID (can be overridden via OAUTH_CLIENT_ID env var)
const DEFAULT_CLIENT_ID = "1448ed27-39a6-417d-b4c8-07f881e81269";

export const config = {
  // OAuth client configuration
  oauth: {
    clientId: DEFAULT_CLIENT_ID,
    responseType: "code",
  },
} as const;

// Get OAuth client ID from environment or use default
// Supports both ADMIN_CLIENT_ID (wrangler config) and OAUTH_CLIENT_ID (legacy)
export function getOAuthClientId(env?: { ADMIN_CLIENT_ID?: string; OAUTH_CLIENT_ID?: string }): string {
  return env?.ADMIN_CLIENT_ID || env?.OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID;
}

// Get the auth server URL from environment variables
export function getAuthServerUrl(request?: Request, env?: { AUTH_SERVER_URL?: string }): string {
  // Priority 1: Check if running locally (overrides env var for local dev)
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'http://localhost:3301';
    }
  }

  if (request) {
    const url = new URL(request.url);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return 'http://localhost:3301';
    }
  }

  // Priority 2: Environment variable (from wrangler.json vars or secrets)
  if (env?.AUTH_SERVER_URL) {
    return env.AUTH_SERVER_URL;
  }

  // Priority 3: Default fallback (should be set via environment variable in production)
  return 'https://auth.alummahnow.net';
}

// Get the current app URL (for OAuth redirect_uri)
export function getAppUrl(request?: Request, env?: { APP_URL?: string }): string {
  // Priority 1: Check if running locally (derive from request)
  if (request) {
    const url = new URL(request.url);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return url.origin;
    }
  }

  // Priority 2: Browser context (client-side)
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return window.location.origin;
    }
  }

  // Priority 3: Environment variable override (production)
  if (env?.APP_URL) {
    return env.APP_URL;
  }

  // Priority 4: Derive from request or window
  if (request) {
    return new URL(request.url).origin;
  }
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }

  // Priority 5: Default fallback for development
  return 'http://localhost:3303';
}
