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
import { checkRateLimit, getClientIP } from "./rate-limit";

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

/**
 * Add security headers to response
 *
 * Applies comprehensive security headers to all responses:
 * - X-Content-Type-Options: Prevent MIME type sniffing
 * - X-Frame-Options: Prevent clickjacking
 * - X-XSS-Protection: Enable browser XSS protection
 * - Referrer-Policy: Control referrer information
 * - Strict-Transport-Security: Enforce HTTPS (production only)
 * - Content-Security-Policy: Restrict resource loading
 *
 * @param response - The response to add headers to
 * @param isProduction - Whether the app is running in production
 * @returns Response with security headers applied
 */
function addSecurityHeaders(response: Response, isProduction: boolean = true): Response {
  const headers = new Headers(response.headers);

  // Prevent MIME type sniffing
  headers.set('X-Content-Type-Options', 'nosniff');

  // Prevent clickjacking
  headers.set('X-Frame-Options', 'DENY');

  // Enable XSS protection (legacy browsers)
  headers.set('X-XSS-Protection', '1; mode=block');

  // Control referrer information
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Enforce HTTPS in production
  if (isProduction) {
    // HSTS: Enforce HTTPS for 1 year, include subdomains
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // Content Security Policy
  // - default-src 'self': Only load resources from same origin by default
  // - script-src 'self' 'unsafe-inline': Allow inline scripts for OpenAuth UI
  // - style-src 'self' 'unsafe-inline': Allow inline styles for OpenAuth UI
  // - img-src 'self' data: https: Allow images from same origin, data URIs, and HTTPS
  // - font-src 'self': Only load fonts from same origin
  // - connect-src 'self': Only make network requests to same origin
  // - frame-ancestors 'none': Prevent embedding (same as X-Frame-Options: DENY)
  headers.set(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https:; " +
    "font-src 'self'; " +
    "connect-src 'self'; " +
    "frame-ancestors 'none'"
  );

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const startTime = Date.now();
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();

    // Determine if running in production
    const isProduction = url.hostname !== 'localhost' && url.hostname !== '127.0.0.1';

    // Initialize D1 logging (optional - set to false to disable)
    logger.setDatabase(env.AUTH_DB, true);
    logger.setContext(ctx);

    // Initialize request context to prevent stale timer usage
    logger.initialRequest(requestId);

    // Log all incoming requests
    logger.logRequest(request, {
      requestId,
      pathname: url.pathname,
      hasAuthStorage: !!env.AUTH_STORAGE,
      hasAuthDB: !!env.AUTH_DB,
    });

    // Handle logout
    if (url.pathname === '/logout') {
      logger.debug('Handling logout request');

      // Delete session from KV
      await deleteSession(request, env.AUTH_STORAGE);
      logger.info('User logged out');

      // Finalize request before returning
      ctx.waitUntil(logger.finalizeRequest());

      // Redirect to homepage with cleared cookie
      const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      const response = new Response(null, {
        status: 302,
        headers: {
          "Location": url.origin,
          "Set-Cookie": clearSessionCookie(isLocalhost),
        },
      });
      return addSecurityHeaders(response, isProduction);
    }

    // Redirect root to profile app
    if (url.pathname === '/' || url.pathname === '') {
      logger.debug('Redirecting to profile app');

      // Get profile app URL from environment (configured in wrangler.json or .dev.vars)
      if (!env.PROFILE_APP_URL) {
        logger.error('PROFILE_APP_URL not configured');
        ctx.waitUntil(logger.finalizeRequest());
        const response = new Response('Profile app URL not configured', { status: 500 });
        return addSecurityHeaders(response, isProduction);
      }

      ctx.waitUntil(logger.finalizeRequest());
      const response = Response.redirect(env.PROFILE_APP_URL, 302);
      return addSecurityHeaders(response, isProduction);
    }

    // Redirect /docs to profile app
    if (url.pathname === '/docs') {
      logger.debug('Redirecting /docs to profile app');

      // Get profile app URL from environment (configured in wrangler.json or .dev.vars)
      if (!env.PROFILE_APP_URL) {
        logger.error('PROFILE_APP_URL not configured');
        ctx.waitUntil(logger.finalizeRequest());
        const response = new Response('Profile app URL not configured', { status: 500 });
        return addSecurityHeaders(response, isProduction);
      }

      ctx.waitUntil(logger.finalizeRequest());
      const response = Response.redirect(env.PROFILE_APP_URL, 302);
      return addSecurityHeaders(response, isProduction);
    }

    // Handle OAuth callback for main app
    if (url.pathname === '/callback') {
      logger.debug('Handling OAuth callback');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        logger.warn('OAuth callback error', { error });
        ctx.waitUntil(logger.finalizeRequest());
        const response = Response.redirect(`${url.origin}/?error=${encodeURIComponent(error)}`, 302);
        return addSecurityHeaders(response, isProduction);
      }

      if (!code) {
        logger.warn('OAuth callback failed', { reason: 'missing_code' });
        ctx.waitUntil(logger.finalizeRequest());
        const response = Response.redirect(`${url.origin}/?error=missing_code`, 302);
        return addSecurityHeaders(response, isProduction);
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
      ctx.waitUntil(logger.finalizeRequest());
      const response = Response.redirect(`${url.origin}/?error=callback_not_supported`, 302);
      return addSecurityHeaders(response, isProduction);
    }
    
    // The real OpenAuth server code starts here:
    logger.debug('Initializing OpenAuth issuer', {
      hasStorage: !!env.AUTH_STORAGE,
      issuerEnv: env.OPENAUTH_ISSUER,
    });

    // Handle OpenAuth issuer and apply security headers
    const issuerResponse = await issuer({
      storage: CloudflareStorage({
        namespace: env.AUTH_STORAGE,
      }),
      subjects,
      providers: {
        password: PasswordProvider(
          PasswordUI({
            sendCode: async (email, code) => {
              // https://resend.com/docs/send-with-cloudflare-workers
              logger.info('Sending login code', { email, codeLength: code.length });

              // Rate limiting: 5 attempts per 5 minutes per IP
              const clientIP = getClientIP(request);
              const rateLimitKey = `login:${clientIP}`;
              const rateLimit = await checkRateLimit(
                env.AUTH_STORAGE,
                rateLimitKey,
                5, // limit
                300 // 5 minutes in seconds
              );

              if (!rateLimit.allowed) {
                const retryAfter = rateLimit.resetAt - Math.floor(Date.now() / 1000);
                logger.warn('Rate limit exceeded for login attempt', {
                  clientIP,
                  email,
                  retryAfter,
                });
                throw new Error(`Too many login attempts. Please try again in ${Math.ceil(retryAfter / 60)} minutes.`);
              }

              logger.debug('Rate limit check passed', {
                clientIP,
                email,
                remaining: rateLimit.remaining,
              });

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

    // Apply security headers to all OpenAuth responses
    return addSecurityHeaders(issuerResponse, isProduction);
  },
} satisfies ExportedHandler<Env>;


