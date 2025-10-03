import { issuer } from "@openauthjs/openauth";
import { CloudflareStorage } from "@openauthjs/openauth/storage/cloudflare";
import { PasswordProvider } from "@openauthjs/openauth/provider/password";
import { PasswordUI } from "@openauthjs/openauth/ui/password";
import { createSubjects } from "@openauthjs/openauth/subject";
import * as v from 'valibot';
import SendEmail from "./email";
import { getOrCreateUser, checkPasswordResetRequired, clearPasswordResetRequired } from "./users";
import { logger } from "./logger";
import { getUserSession, createSession, deleteSession, createSessionCookie, clearSessionCookie } from "./session";
import { getAuthClient, subjects as clientSubjects } from "./auth-client";

// This value should be shared between the OpenAuth server Worker and other
// client Workers that you connect to it, so the types and schema validation are
// consistent.

const subjects = createSubjects({
  user: v.object({
    id: v.string(),
    email: v.pipe(v.string(), v.email()),
    role: v.string(),
  }),
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const startTime = Date.now();
    const url = new URL(request.url);

    // Initialize D1 logging (optional - set to false to disable)
    logger.setDatabase(env.AUTH_DB, true);
    logger.setContext(ctx);

    // Log all incoming requests
    logger.logRequest(request, {
      pathname: url.pathname,
      hasAuthStorage: !!env.AUTH_STORAGE,
      hasAuthDB: !!env.AUTH_DB,
    });
    
    // Logs endpoint - view recent logs from D1
    if (url.pathname === '/logs') {
      logger.debug('Serving logs page');
      try {
        const limit = parseInt(url.searchParams.get('limit') || '100');
        const level = url.searchParams.get('level') || null;
        
        let query = 'SELECT * FROM logs';
        const params: any[] = [];
        
        if (level) {
          query += ' WHERE level = ?';
          params.push(level.toUpperCase());
        }
        
        query += ' ORDER BY timestamp DESC LIMIT ?';
        params.push(limit);
        
        const result = await env.AUTH_DB.prepare(query).bind(...params).all();
        
        return new Response(JSON.stringify(result.results, null, 2), {
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (error) {
        logger.error('Failed to fetch logs', { 
          error: error instanceof Error ? error.message : String(error) 
        });
        return new Response(JSON.stringify({ 
          error: 'Failed to fetch logs',
          message: error instanceof Error ? error.message : String(error)
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    // Handle logout
    if (url.pathname === '/logout') {
      logger.debug('Handling logout request');

      // Delete session from KV
      await deleteSession(request, env.AUTH_STORAGE);
      logger.info('User logged out');

      // Redirect to homepage with cleared cookie
      const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      return new Response(null, {
        status: 302,
        headers: {
          "Location": url.origin,
          "Set-Cookie": clearSessionCookie(isLocalhost),
        },
      });
    }

    // Redirect root to profile app
    if (url.pathname === '/' || url.pathname === '') {
      logger.debug('Redirecting to profile app');

      // Get profile app URL from environment
      const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      const profileUrl = isLocalhost ? 'http://localhost:8788' : (env.PROFILE_APP_URL || 'https://al-ummah-now-profile.alummahnow.workers.dev');

      return Response.redirect(profileUrl, 302);
    }

    // Redirect /docs to profile app
    if (url.pathname === '/docs') {
      logger.debug('Redirecting /docs to profile app');

      const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      const profileUrl = isLocalhost ? 'http://localhost:8788' : (env.PROFILE_APP_URL || 'https://al-ummah-now-profile.alummahnow.workers.dev');

      return Response.redirect(profileUrl, 302);
    }

    // Handle OAuth callback for main app
    if (url.pathname === '/callback') {
      logger.debug('Handling OAuth callback');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        logger.warn('OAuth callback error', { error });
        return Response.redirect(`${url.origin}/?error=${encodeURIComponent(error)}`, 302);
      }

      if (!code) {
        logger.warn('OAuth callback failed', { reason: 'missing_code' });
        return Response.redirect(`${url.origin}/?error=missing_code`, 302);
      }

      // Note: This callback endpoint has a fundamental issue - the auth server
      // cannot call client.exchange() on itself as it causes a 522 timeout.
      // The OpenAuth issuer handles OAuth flows internally, so this custom
      // callback is redundant and problematic.

      // Proper solution: Remove this endpoint and handle auth via OpenAuth's
      // built-in success callback or use a separate client app

      logger.warn('Auth server /callback endpoint hit - this causes 522 errors', {
        hasCode: !!code,
        issue: 'Cannot exchange tokens with self',
        solution: 'Use OpenAuth internal flow or deploy separate client'
      });

      // Redirect to home with error message
      return Response.redirect(`${url.origin}/?error=callback_not_supported`, 302);
    }
    
    // The real OpenAuth server code starts here:
    logger.debug('Initializing OpenAuth issuer', {
      hasStorage: !!env.AUTH_STORAGE,
      issuerEnv: env.OPENAUTH_ISSUER,
    });

    return issuer({
      storage: CloudflareStorage({
        namespace: env.AUTH_STORAGE,
      }),
      subjects,
      providers: {
        password: PasswordProvider(
          PasswordUI({
            // eslint-disable-next-line @typescript-eslint/require-await
            sendCode: async (email, code) => {
              // https://resend.com/docs/send-with-cloudflare-workers
              logger.info('Sending login code', { email, codeLength: code.length });
              
              try {
                const apiKey = env.RESEND_API_KEY;
                
                if (!apiKey) {
                  throw new Error('RESEND_API_KEY not configured');
                }
                
                logger.debug('Using RESEND_API_KEY from environment');
                await SendEmail(apiKey, "login@alummahnow.net", email, "Your login code", `Your login code is ${code}`);
                logger.info('Login code sent successfully', { email });
              } catch (error) {
                logger.error('Failed to send login code', {
                  email,
                  error: error instanceof Error ? error.message : String(error)
                });
                throw error;
              }
            },
            copy: {
              input_code: "Code (check your inbox)",
            },
          }),
        ),
      },
      theme: {
        title: "Al Ummah Now",
        primary: "#0891b2",
        favicon: "https://al-ummah-now-images.b-cdn.net/favicon_io/favicon.ico",
        logo: {
          dark: "https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png",
          light:
            "https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png",
        },
      },
      success: async (ctx, value) => {
        logger.info('Authentication successful', { email: value.email });
        try {
          const user = await getOrCreateUser(env, value.email);
          return ctx.subject("user", {
            id: user.id,
            email: value.email,
            role: user.role,
          });
        } catch (error) {
          throw error;
        }
      },
    }).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;


