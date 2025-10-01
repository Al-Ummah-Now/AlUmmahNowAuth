// Configuration for the admin app

export const config = {
  // OAuth client configuration
  oauth: {
    clientId: "admin-dashboard",
    responseType: "code",
  },
} as const;

// Get the auth server URL from environment variables
export function getAuthServerUrl(request?: Request, env?: Record<string, any>): string {
  // Priority 1: Environment variable (from wrangler.json vars or secrets)
  if (env?.AUTH_SERVER_URL) {
    return env.AUTH_SERVER_URL;
  }

  // Priority 2: Check if running locally
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'http://localhost:8787';
    }
  }

  if (request) {
    const url = new URL(request.url);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return 'http://localhost:8787';
    }
  }

  // Priority 3: Default fallback (should be set via environment variable in production)
  return 'https://al-ummah-now-auth.alummahnow.workers.dev';
}

// Get the current app URL (for OAuth redirect_uri)
export function getAppUrl(request?: Request, env?: Record<string, any>): string {
  // Priority 1: Environment variable override
  if (env?.APP_URL) {
    return env.APP_URL;
  }

  // Priority 2: Browser context (client-side)
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }

  // Priority 3: Server-side request
  if (request) {
    const url = new URL(request.url);
    return url.origin;
  }

  // Priority 4: Default fallback for development
  return 'http://localhost:5174';
}
