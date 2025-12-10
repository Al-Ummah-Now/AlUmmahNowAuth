import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { getAppUrl, getAuthServerUrl } from "../lib/config";
import { getOpenAuthClient, subjects } from "../lib/openauth.client.server";
import { logger } from "../lib/logger.server";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const requestId = crypto.randomUUID();

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

  // Set execution context if available
  if (context?.cloudflare?.ctx) {
    logger.setContext(context.cloudflare.ctx);
  }

  // Initialize request context to prevent stale timer usage
  logger.initialRequest(requestId);

  logger.logLoader('auth.callback', request, { requestId });

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    // Handle login_required from prompt=none - retry with normal auth flow
    if (error === 'login_required') {
      const appUrl = getAppUrl(request, env);
      const { url: authorizeUrl } = await getOpenAuthClient(request, env).authorize(`${appUrl}/auth/callback`, "code");
      logger.info('Retrying auth without prompt=none', { authorizeUrl });
      await logger.finalizeRequest();
      return redirect(authorizeUrl);
    }
    logger.warn('OAuth error received', { error });
    await logger.finalizeRequest();
    return redirect(`/?error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    logger.warn('No authorization code received');
    await logger.finalizeRequest();
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
      clientId: '1448ed27-39a6-417d-b4c8-07f881e81269',
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
      await logger.finalizeRequest();
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
    // IMPORTANT: Never decode JWT tokens without verification first.
    // JWTs can be forged, and decoding without verification exposes the application
    // to security vulnerabilities. Always use client.verify() before trusting token contents.
    logger.debug('Verifying access token', { hasTokens: !!result.tokens, hasAccess: !!result.tokens.access });

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
    console.debug('DEBUG: Full userInfo:', JSON.stringify(userInfo, null, 2));
    console.debug('DEBUG: userInfo.properties:', JSON.stringify(userInfo.properties, null, 2));
    const userRoles = userInfo.properties.roles || [];
    logger.info('Token verified', { email: userInfo.properties.email, roles: userRoles });

    // Verify user is admin
    const hasAdminAccess = userRoles.includes("admin") || userRoles.includes("super_admin");
    if (!hasAdminAccess) {
      logger.warn('Non-admin user attempted to access admin dashboard', {
        email: userInfo.properties.email,
        roles: userRoles
      });
      await logger.finalizeRequest();
      return redirect("/?error=admin_required");
    }

    // Store session in KV
    if (env?.AUTH_STORAGE) {
      const sessionToken = crypto.randomUUID();
      const sessionData = {
        user: {
          id: userInfo.properties.id,
          email: userInfo.properties.email,
          roles: userRoles,
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

      // Finalize request before returning
      await logger.finalizeRequest();

      // Set cookie and redirect
      return redirect("/", {
        headers: {
          "Set-Cookie": `auth_session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${7 * 24 * 60 * 60}`,
        },
      });
    }

    // Fallback if no KV available
    logger.warn('No KV storage available, using demo mode');
    await logger.finalizeRequest();
    return redirect("/?demo=true");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Auth callback error", {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined
    });
    await logger.finalizeRequest();
    return redirect(`/login?error=${encodeURIComponent(errorMessage)}`);
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
