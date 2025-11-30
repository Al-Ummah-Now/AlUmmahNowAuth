import { issuer } from "@meywd/openauth";
import { CloudflarePatchedStorage } from "./storage/cloudflare-patched";
import { PasswordProvider } from "@meywd/openauth/provider/password";
import { PasswordUI } from "@meywd/openauth/ui/password";
import { createSubjects } from "@meywd/openauth/subject";
import { AuditService } from "@meywd/openauth/services/audit";
import * as v from 'valibot';
import SendEmail from "./email";
import {
  getVerificationCodeTemplate,
  getVerificationCodePlainText,
  getVerificationCodeSubject,
} from "./email-templates";
import { getOrCreateUser } from "./users";
import { logger } from "./logger";
import { getUserSession, deleteSession, clearSessionCookie } from "./session";
import { subjects as _clientSubjects } from "./auth-client";
import { checkRateLimit, getClientIP } from "./rate-limit";
import { AdminRBACRoutes } from "./admin-rbac-routes";
import { RBACRoutes } from "./rbac-routes";
import { AdminEnterpriseRoutes } from "./admin-enterprise-routes";
import { initializeAuditEmitter, getAuditEmitter } from "./audit-emitter";
import {
  createLoginSuccessEvent,
  createLoginFailedEvent,
  createLogoutEvent,
  createRateLimitExceededEvent,
  createAccountCreatedEvent,
} from "./audit-events";
import { routeAdminDLQ } from "./admin-dlq-routes";
import { handleTokenCron } from "./cron/token-cron";

/**
 * Check if an origin matches allowed origins (supports wildcards like *.example.com)
 */
function matchOrigin(origin: string, allowedOrigins: string[]): boolean {
  for (const allowed of allowedOrigins) {
    if (allowed.startsWith('*.')) {
      // Wildcard match: *.example.com matches sub.example.com
      const domain = allowed.slice(2); // Remove "*."
      try {
        const originHost = new URL(origin).hostname;
        if (originHost.endsWith(domain) && originHost !== domain) {
          return true;
        }
      } catch {
        continue;
      }
    } else if (allowed === origin) {
      return true;
    }
  }
  return false;
}

/**
 * Get allowed origins from env, supporting wildcards
 */
function getAllowedOrigins(env: Env, requestOrigin?: string | null): string[] {
  const origins = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map((o: string) => o.trim()) : [];

  // If request origin matches a wildcard pattern, include it explicitly
  if (requestOrigin && matchOrigin(requestOrigin, origins)) {
    // Return the actual origin for CORS header (wildcards don't work in headers)
    if (!origins.includes(requestOrigin)) {
      return [...origins.filter(o => !o.startsWith('*.')), requestOrigin];
    }
  }

  return origins.filter(o => !o.startsWith('*.'));
}

// This value should be shared between the OpenAuth server Worker and other
// client Workers that you connect to it, so the types and schema validation are
// consistent.

const subjects = createSubjects({
  user: v.object({
    id: v.string(),
    email: v.pipe(v.string(), v.email()),
    roles: v.array(v.string()),
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
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();

    // Determine if running in production
    const isProduction = url.hostname !== 'localhost' && url.hostname !== '127.0.0.1';

    // Initialize D1 logging (optional - set to false to disable)
    logger.setDatabase(env.AUTH_DB, true);
    logger.setContext(ctx);

    // Initialize request context to prevent stale timer usage
    logger.initialRequest(requestId);

    // Initialize audit emitter with batch size 1 for immediate D1 writes
    initializeAuditEmitter({
      enableStdout: true,
      webhookUrl: env.AUDIT_WEBHOOK_URL,
      webhookSecret: env.AUDIT_WEBHOOK_SECRET,
      db: env.AUTH_DB,
      ctx,
      d1Config: {
        batchSize: 1,  // Write events immediately to database
        batchTimeout: 100,  // Very short timeout (not needed with batchSize=1)
      },
    });

    // Log all incoming requests
    logger.logRequest(request, {
      requestId,
      pathname: url.pathname,
      hasAuthStorage: !!env.AUTH_STORAGE,
      hasAuthDB: !!env.AUTH_DB,
    });

    // Initialize RBAC route handlers
    const adminRBACRoutes = new AdminRBACRoutes(env.AUTH_DB, env.AUTH_STORAGE);
    const rbacRoutes = new RBACRoutes(env.AUTH_DB, env.AUTH_STORAGE);
    const adminEnterpriseRoutes = new AdminEnterpriseRoutes(env.AUTH_DB, env.AUTH_STORAGE);

    // Handle admin RBAC routes
    if (url.pathname.startsWith('/admin/roles')) {
      const response = await adminRBACRoutes.handle(request, env, ctx);
      if (response.status !== 404) {
        return addSecurityHeaders(response, isProduction);
      }
    }

    // Handle admin enterprise routes (audit logs, client management, token management, health)
    if (url.pathname.startsWith('/admin/audit-logs') ||
        url.pathname.startsWith('/admin/clients') ||
        url.pathname.startsWith('/admin/users') ||
        url.pathname === '/admin/health' ||
        url.pathname === '/admin/metrics') {
      const response = await adminEnterpriseRoutes.handle(request, env, ctx);
      if (response.status !== 404) {
        return addSecurityHeaders(response, isProduction);
      }
    }

    // Handle user-facing RBAC routes
    if (url.pathname.startsWith('/api/users/') || url.pathname.startsWith('/api/permissions')) {
      const response = await rbacRoutes.handle(request, env, ctx);
      if (response.status !== 404) {
        return addSecurityHeaders(response, isProduction);
      }
    }

    // Handle logout
    if (url.pathname === '/logout') {
      logger.debug('Handling logout request');

      // Get user session before deleting it
      const session = await getUserSession(request, env.AUTH_STORAGE);
      const userId = session?.user?.id;

      // Delete session from KV
      await deleteSession(request, env.AUTH_STORAGE);
      logger.info('User logged out');

      // Emit logout audit event
      if (userId) {
        const clientIP = getClientIP(request);
        const auditEvent = createLogoutEvent(userId, {
          ipAddress: clientIP,
          userAgent: request.headers.get('User-Agent') ?? undefined,
          requestId,
        });
        ctx.waitUntil(getAuditEmitter().emit(auditEvent));
      }

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

    // Test endpoint to retrieve email verification code (E2E tests only)
    if (url.pathname.startsWith('/test/email/') && !isProduction) {
      const email = decodeURIComponent(url.pathname.split('/test/email/')[1]);
      logger.debug('Test endpoint: retrieving email code', { email });

      try {
        const testKey = `test:email:${email}`;
        const stored = await env.AUTH_STORAGE.get(testKey);

        if (!stored) {
          ctx.waitUntil(logger.finalizeRequest());
          return new Response(JSON.stringify({ error: 'No email found for this address' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const data = JSON.parse(stored);
        ctx.waitUntil(logger.finalizeRequest());
        return new Response(JSON.stringify({ code: data.code, emailId: data.emailId }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        logger.error('Error retrieving test email', { email, error });
        ctx.waitUntil(logger.finalizeRequest());
        return new Response(JSON.stringify({ error: 'Internal server error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Test endpoint to promote user to admin (E2E tests only)
    if (url.pathname.startsWith('/test/promote/') && !isProduction && request.method === 'POST') {
      const email = decodeURIComponent(url.pathname.split('/test/promote/')[1]);
      logger.debug('Test endpoint: promoting user to admin', { email });

      // Additional security: require TEST_PROMOTE_SECRET header
      const providedSecret = request.headers.get('X-Test-Secret');
      const expectedSecret = env.TEST_PROMOTE_SECRET;

      if (!expectedSecret) {
        logger.error('TEST_PROMOTE_SECRET not configured');
        ctx.waitUntil(logger.finalizeRequest());
        return new Response(JSON.stringify({ error: 'Test endpoint not properly configured' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (providedSecret !== expectedSecret) {
        logger.warn('Invalid test secret provided for /test/promote', { email });
        ctx.waitUntil(logger.finalizeRequest());
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      try {
        // First get the user
        const user = await env.AUTH_DB.prepare(
          `SELECT id, email FROM user WHERE email = ?`
        )
          .bind(email)
          .first<{ id: string; email: string }>();

        if (!user) {
          ctx.waitUntil(logger.finalizeRequest());
          return new Response(JSON.stringify({ error: 'User not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Assign admin role via RBAC (upsert to handle existing role assignments)
        await env.AUTH_DB.prepare(
          `INSERT INTO user_roles (user_id, role_id, granted_by, is_active)
           VALUES (?, 'role_admin', 'system', 1)
           ON CONFLICT(user_id, role_id) DO UPDATE SET is_active = 1, granted_by = 'system'`
        ).bind(user.id).run();

        logger.info('User promoted to admin (E2E test)', { userId: user.id, email: user.email });
        ctx.waitUntil(logger.finalizeRequest());
        return new Response(JSON.stringify({ success: true, user: { ...user, role: 'admin' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        logger.error('Error promoting user to admin', { email, error });
        ctx.waitUntil(logger.finalizeRequest());
        return new Response(JSON.stringify({ error: 'Internal server error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Test endpoint to get refresh tokens for E2E testing (localhost only)
    // Returns existing refresh tokens from the database for a user
    if (url.pathname.startsWith('/test/tokens/') && !isProduction && request.method === 'POST') {
      const email = decodeURIComponent(url.pathname.split('/test/tokens/')[1]);
      logger.debug('Test endpoint: getting tokens for user', { email });

      // Require TEST_PROMOTE_SECRET header for security
      const providedSecret = request.headers.get('X-Test-Secret');
      const expectedSecret = env.TEST_PROMOTE_SECRET;

      if (!expectedSecret) {
        logger.error('TEST_PROMOTE_SECRET not configured');
        ctx.waitUntil(logger.finalizeRequest());
        return new Response(JSON.stringify({ error: 'Test endpoint not properly configured' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (providedSecret !== expectedSecret) {
        logger.warn('Invalid test secret provided for /test/tokens', { email });
        ctx.waitUntil(logger.finalizeRequest());
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      try {
        // Get the user from database
        const user = await env.AUTH_DB.prepare(
          `SELECT id, email FROM user WHERE email = ?`
        )
          .bind(email)
          .first<{ id: string; email: string }>();

        if (!user) {
          ctx.waitUntil(logger.finalizeRequest());
          return new Response(JSON.stringify({ error: 'User not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Get the most recent active refresh token for this user
        const refreshTokenRecord = await env.AUTH_DB.prepare(
          `SELECT id, token_hash, client_id, scope, expires_at, issued_at
           FROM refresh_tokens
           WHERE user_id = ?
           AND revoked = 0
           AND expires_at > ?
           ORDER BY issued_at DESC
           LIMIT 1`
        )
          .bind(user.id, Math.floor(Date.now() / 1000))
          .first<{
            id: string;
            token_hash: string;
            client_id: string;
            scope: string;
            expires_at: number;
            issued_at: number;
          }>();

        if (!refreshTokenRecord) {
          ctx.waitUntil(logger.finalizeRequest());
          return new Response(JSON.stringify({
            error: 'No active refresh token found',
            hint: 'User needs to login first to create a refresh token'
          }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Note: We can't return the actual refresh token since we only store the hash
        // Instead, return the token hash which can be used for introspection/revocation testing
        logger.info('Token info retrieved for E2E test', { userId: user.id, email: user.email });
        ctx.waitUntil(logger.finalizeRequest());
        return new Response(JSON.stringify({
          success: true,
          user: { id: user.id, email: user.email },
          token_info: {
            id: refreshTokenRecord.id,
            token_hash: refreshTokenRecord.token_hash,
            client_id: refreshTokenRecord.client_id,
            scope: refreshTokenRecord.scope,
            expires_at: refreshTokenRecord.expires_at,
            issued_at: refreshTokenRecord.issued_at,
          },
          note: 'Refresh token hash returned - actual token not available (only hash stored)'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        logger.error('Error getting tokens', { email, error });
        ctx.waitUntil(logger.finalizeRequest());
        return new Response(JSON.stringify({ error: 'Internal server error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Handle admin DLQ management routes
    if (url.pathname.startsWith('/admin/dlq')) {
      logger.debug('Handling admin DLQ request', { pathname: url.pathname });
      const dlqResponse = await routeAdminDLQ(request, env, ctx);
      if (dlqResponse) {
        ctx.waitUntil(logger.finalizeRequest());
        return addSecurityHeaders(dlqResponse, isProduction);
      }
    }

    // Note: Token endpoints (/token, /token/introspect, /token/revoke) are now
    // handled by the forked OpenAuth issuer with built-in enterprise features

    // The real OpenAuth server code starts here:
    logger.debug('Initializing OpenAuth issuer', {
      hasStorage: !!env.AUTH_STORAGE,
      issuerEnv: env.OPENAUTH_ISSUER,
    });

    // Initialize OpenAuth audit service with queue for async processing
    const auditService = new AuditService({
      database: env.AUTH_DB,
      queue: env.AUDIT_QUEUE, // Queue-based mode for better performance
    });

    // Handle OpenAuth issuer and apply security headers
    const issuerResponse = await issuer({
      storage: CloudflarePatchedStorage({
        namespace: env.AUTH_STORAGE,
      }),
      subjects,
      // Enable client authentication with D1 database
      clientDb: env.AUTH_DB,
      // Enable audit logging for token operations
      audit: {
        service: auditService,
        hooks: {
          onTokenGenerated: true,
          onTokenRefreshed: true,
          onTokenRevoked: true,
          onTokenReused: true,
        },
      },
      // Configure CORS for token endpoints (supports wildcards like *.alummahnow.net)
      cors: {
        origins: getAllowedOrigins(env, request.headers.get('Origin')),
        credentials: true,
      },
      providers: {
        password: PasswordProvider(
          PasswordUI({
            sendCode: async (email, code) => {
              // https://resend.com/docs/send-with-cloudflare-workers
              logger.info('Sending login code', { email, codeLength: code.length });

              // Rate limiting: 5 attempts per 5 minutes per IP (production)
              // or 100 attempts per 5 minutes for localhost (E2E tests)
              const clientIP = getClientIP(request);
              const rateLimitKey = `login:${clientIP}`;
              const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
              const limit = isLocalhost ? 100 : 5; // Higher limit for local development/testing
              const rateLimit = await checkRateLimit(
                env.AUTH_STORAGE,
                rateLimitKey,
                limit,
                300 // 5 minutes in seconds
              );

              if (!rateLimit.allowed) {
                const retryAfter = rateLimit.resetAt - Math.floor(Date.now() / 1000);
                logger.warn('Rate limit exceeded for login attempt', {
                  clientIP,
                  email,
                  retryAfter,
                });

                // Emit rate limit exceeded audit event
                const auditEvent = createRateLimitExceededEvent(
                  '/sendCode',
                  5,
                  300,
                  retryAfter,
                  {
                    ipAddress: clientIP,
                    userAgent: request.headers.get('User-Agent') ?? undefined,
                    requestId,
                  }
                );
                ctx.waitUntil(getAuditEmitter().emit(auditEvent));

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

                // Generate email content from professional template
                const emailData = {
                  code,
                  email,
                  expiryMinutes: 1440, // 24 hours (matches OpenAuth's provider session TTL)
                };
                const htmlContent = getVerificationCodeTemplate(emailData);
                const textContent = getVerificationCodePlainText(emailData);
                const subject = getVerificationCodeSubject();

                const emailResult = await SendEmail({
                  apiKey,
                  from: "Al Ummah Now <login@alummahnow.net>",
                  to: email,
                  subject,
                  html: htmlContent,
                  text: textContent,
                });
                logger.info('Login code sent successfully', { email, emailId: emailResult.emailId });

                // For E2E tests, store the email ID in KV so tests can retrieve it
                if (isLocalhost && emailResult.emailId) {
                  const testKey = `test:email:${email}`;
                  await env.AUTH_STORAGE.put(testKey, JSON.stringify({
                    emailId: emailResult.emailId,
                    code,
                    timestamp: Date.now()
                  }), { expirationTtl: 300 }); // 5 minute TTL
                  logger.debug('Stored email ID for E2E test', { email, emailId: emailResult.emailId });
                }
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
      success: async (oauthCtx, value) => {
        logger.info('Authentication successful', { email: value.email });
        try {
          const user = await getOrCreateUser(env, value.email, true);
          const isNewUser = user.isNew; // Track if this is a new account

          // Debug: Log the roles being returned
          logger.info('User roles from RBAC', {
            userId: user.id,
            email: value.email,
            roles: user.roles,
            rolesCount: user.roles.length
          });

          // Emit login success audit event
          const clientIP = getClientIP(request);
          const loginEvent = createLoginSuccessEvent(
            value.email,
            user.id,
            {
              ipAddress: clientIP,
              userAgent: request.headers.get('User-Agent') ?? undefined,
              requestId,
            }
          );
          ctx.waitUntil(getAuditEmitter().emit(loginEvent));

          // If new user, emit account created event
          // Note: In rare race conditions with concurrent logins for the same new user,
          // duplicate ACCOUNT_CREATED events may be emitted. This is acceptable as the
          // events will have different requestIds for correlation.
          if (isNewUser) {
            const accountEvent = createAccountCreatedEvent(
              user.id,
              value.email,
              user.roles.join(','),
              {
                ipAddress: clientIP,
                userAgent: request.headers.get('User-Agent') ?? undefined,
                requestId,
              }
            );
            ctx.waitUntil(getAuditEmitter().emit(accountEvent));
          }

          return oauthCtx.subject("user", {
            id: user.id,
            email: value.email,
            roles: user.roles,
          });
        } catch (error) {
          // Emit login failed audit event
          const clientIP = getClientIP(request);
          const failedEvent = createLoginFailedEvent(
            value.email,
            error instanceof Error ? error.message : String(error),
            {
              ipAddress: clientIP,
              userAgent: request.headers.get('User-Agent') ?? undefined,
              requestId,
            }
          );
          ctx.waitUntil(getAuditEmitter().emit(failedEvent));

          throw error;
        }
      },
    }).fetch(request, env, ctx);

    // Apply security headers to all OpenAuth responses
    return addSecurityHeaders(issuerResponse, isProduction);
  },

  /**
   * Scheduled handler for cron triggers
   *
   * Configure cron triggers in wrangler.toml:
   * ```
   * [triggers]
   * crons = ["0 * * * *"]  // Every hour - cleanup expired tokens
   * ```
   */
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    // Determine which cron job to run based on schedule
    // For now, we'll run all token maintenance tasks
    const cronName = event.cron || 'token-maintenance';

    try {
      await handleTokenCron(env, cronName);
    } catch (error) {
      console.error('Scheduled token cron failed', error);
      // Don't throw - let other scheduled tasks continue
    }
  },
} satisfies ExportedHandler<Env>;


