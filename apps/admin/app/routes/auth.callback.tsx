import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { getAppUrl, getAuthServerUrl } from "../lib/config";
import { getOpenAuthClient, subjects } from "../lib/openauth.client.server";
import { logger } from "../lib/logger.server";

export async function loader({ request, context }: LoaderFunctionArgs) {
  // Initialize logger with D1 database (if available in Cloudflare Workers context)
  const env = context?.cloudflare?.env as { 
    AUTH_DB?: D1Database; 
    AUTH_STORAGE?: KVNamespace;
    AUTH_SERVER_URL?: string;
    APP_URL?: string;
  };
  if (env?.AUTH_DB) {
    logger.setDatabase(env.AUTH_DB, true);
  } else {
    // Running in dev mode without Cloudflare bindings - console only
    logger.setDatabase(null, false);
  }

  logger.logLoader('auth.callback', request);

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    logger.warn('OAuth error received', { error });
    return redirect(`/?error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    logger.warn('No authorization code received');
    return redirect("/?error=missing_code");
  }

  try {
    const appUrl = getAppUrl(request, env);
    const client = getOpenAuthClient(request, env);
    const authServerUrl = getAuthServerUrl(request, env);

    logger.debug('OAuth configuration', {
      appUrl,
      authServerUrl,
      redirectUri: `${appUrl}/auth/callback`,
      clientId: 'admin-dashboard',
      tokenEndpoint: `${authServerUrl}/token`
    });

    // Exchange code for tokens
    logger.debug('Exchanging authorization code for tokens', {
      code: code.substring(0, 10) + '...',
      redirectUri: `${appUrl}/auth/callback`,
      tokenUrl: `${authServerUrl}/token`
    });
    let result;
    try {
      result = await client.exchange(code, `${appUrl}/auth/callback`);
    } catch (exchangeError) {
      logger.error('Token exchange request failed', {
        error: exchangeError instanceof Error ? exchangeError.message : String(exchangeError),
        authServerUrl,
        hint: 'Auth server may be down or timing out (Cloudflare 522)'
      });
      return redirect("/login?error=auth_server_unavailable");
    }

    if (result.err !== false) {
      logger.error('Token exchange returned error', { error: result.err });
      throw new Error(`Exchange failed: ${result.err}`);
    }

    logger.info('Tokens exchanged successfully', {
      hasAccess: !!result.tokens.access,
      hasRefresh: !!result.tokens.refresh
    });

    // Verify the token and get user info
    logger.debug('Verifying access token', { hasTokens: !!result.tokens, hasAccess: !!result.tokens.access });

    // Decode token to inspect claims (for debugging)
    try {
      const tokenParts = result.tokens.access.split('.');
      if (tokenParts.length === 3) {
        const payload = JSON.parse(atob(tokenParts[1]));
        logger.debug('Token payload', {
          iss: payload.iss,
          sub: payload.sub,
          aud: payload.aud,
          exp: payload.exp
        });
      }
    } catch (e) {
      logger.warn('Could not decode token for debugging');
    }

    const verified = await client.verify(subjects, result.tokens.access, {
      refresh: result.tokens.refresh,
    });

    // Check if verification returned an error
    if (verified?.err) {
      logger.error('Token verification returned error', {
        error: verified.err,
        errorType: typeof verified.err,
        errorMessage: verified.err instanceof Error ? verified.err.message : String(verified.err)
      });
      throw new Error(`Token verification failed: ${verified.err instanceof Error ? verified.err.message : String(verified.err)}`);
    }

    if (!verified || !verified.subject) {
      logger.error('Token verification failed - no subject', {
        verified: !!verified,
        hasSubject: !!verified?.subject,
        verifiedKeys: verified ? Object.keys(verified) : []
      });
      throw new Error("Failed to verify token - no subject returned");
    }

    const userInfo = verified.subject;
    logger.info('Token verified', { email: userInfo.properties.email, role: userInfo.properties.role });

    // Verify user is admin
    if (userInfo.properties.role !== "admin") {
      logger.warn('Non-admin user attempted to access admin dashboard', {
        email: userInfo.properties.email,
        role: userInfo.properties.role
      });
      return redirect("/?error=admin_required");
    }

    // Store session in KV
    if (env?.AUTH_STORAGE) {
      const sessionToken = crypto.randomUUID();
      const sessionData = {
        user: {
          id: userInfo.properties.id,
          email: userInfo.properties.email,
          role: userInfo.properties.role,
        },
        tokens: {
          access: result.tokens.access,
          refresh: result.tokens.refresh,
        },
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
      };

      logger.debug('Storing session in KV', { sessionToken });
      await env.AUTH_STORAGE.put(
        `session:${sessionToken}`,
        JSON.stringify(sessionData),
        { expirationTtl: 7 * 24 * 60 * 60 } // 7 days
      );

      logger.logAuth('User session created', {
        userId: userInfo.properties.id,
        email: userInfo.properties.email
      });

      // Set cookie and redirect
      return redirect("/", {
        headers: {
          "Set-Cookie": `auth_session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`,
        },
      });
    }

    // Fallback if no KV available
    logger.warn('No KV storage available, using demo mode');
    return redirect("/?demo=true");
  } catch (error) {
    logger.error("Auth callback error", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    return redirect("/login?error=auth_failed");
  }
}

export default function AuthCallback() {
  return (
    <div className="min-h-screen bg-[rgb(var(--color-background))] flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[rgb(var(--color-primary))] mx-auto mb-4"></div>
        <p className="text-[rgb(var(--color-foreground))]">Completing sign in...</p>
      </div>
    </div>
  );
}
