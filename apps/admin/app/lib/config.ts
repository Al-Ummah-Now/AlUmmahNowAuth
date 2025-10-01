// Configuration for the admin app

export const config = {
  // Auth server URL - change based on environment
  authServer: {
    // Production
    production: "https://al-ummah-now-auth.alummahnow.workers.dev",

    // Preview/Staging
    preview: "https://al-ummah-now-auth-preview.mahmoud-s-darwish.workers.dev",

    // Local development
    local: "http://localhost:8787",
  },

  // OAuth client configuration
  oauth: {
    clientId: "admin-dashboard",
    responseType: "code",
  },
} as const;

// Get the auth server URL based on current environment
export function getAuthServerUrl(request?: Request): string {
  // If running in browser, check the hostname
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;

    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return config.authServer.local;
    }

    if (hostname.includes('preview') || hostname.includes('-pr-')) {
      return config.authServer.preview;
    }

    return config.authServer.production;
  }

  // Server-side detection
  if (request) {
    const url = new URL(request.url);

    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return config.authServer.local;
    }

    if (url.hostname.includes('preview') || url.hostname.includes('-pr-')) {
      return config.authServer.preview;
    }
  }

  // Default to production
  return config.authServer.production;
}

// Get the current app URL (for OAuth redirect_uri)
export function getAppUrl(request?: Request): string {
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }

  if (request) {
    const url = new URL(request.url);
    return url.origin;
  }

  return 'http://localhost:5174';
}
