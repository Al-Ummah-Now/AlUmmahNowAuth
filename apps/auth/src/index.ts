// DEBUG: Force reload trigger - 2025-12-03T12:15:00
import { Hono } from "hono";
import { createMultiTenantIssuer } from "@al-ummah-now/openauth";
import { RBACAdapter, RBACServiceImpl, rbacEndpoints, rbacAdminEndpoints } from "@al-ummah-now/openauth/rbac/index";
import { AuditService } from "@al-ummah-now/openauth/services/audit";
import { CloudflarePatchedStorage } from "./storage/cloudflare-patched";
import { D1SessionAdapter } from "./adapters/session-adapter";
import { D1TenantAdapter } from "./adapters/tenant-adapter";
import { hexToSecret } from "./utils/crypto";
import { matchOrigin, getAllowedOrigins } from "./utils/cors";
import { addSecurityHeaders } from "./utils/security-headers";
import { renderErrorPage } from "./ui/error-page";
import { createOnSuccessHandler, createSendCodeHandler } from "./handlers/auth-handlers";
import { PasswordProvider } from "@al-ummah-now/openauth/provider/password";
import { PasswordUI } from "@al-ummah-now/openauth/ui/password";
import { createSubjects } from "@al-ummah-now/openauth/subject";
import * as v from 'valibot';
import { logger } from "./logger";
import { AdminEnterpriseRoutes } from "./admin-enterprise-routes";
import { initializeAuditEmitter } from "./audit-emitter";
import {
  userApiRoutes,
  createUserService,
  D1UserAdapter,
  clientAdminRoutes,
} from "@al-ummah-now/openauth";
import { userRoleRoutes } from "./custom/user-role-routes";
import { userListRoutes } from "./custom/user-list-routes";
import { adminContextMiddleware, methodCompatMiddleware, clientResponseCompatMiddleware } from "./custom/admin-context-middleware";
import { requireAdmin } from "./middleware/admin-auth";
import { handleTokenCron } from "./cron/token-cron";
import { routeRequest, type RouterContext } from "./router";

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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();

    // Determine if running in production (test endpoints disabled in production)
    // Use ENVIRONMENT env var if set, otherwise fall back to hostname check
    const isProduction = env.ENVIRONMENT
      ? env.ENVIRONMENT === 'production'
      : (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1');

    // D1 logging disabled - use Cloudflare Logpush or wrangler tail instead
    // D1 is not designed for high-volume logs (causes bloat and slow queries)
    logger.setDatabase(env.AUTH_DB, false);
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

    // Wrap entire request handling in try-catch for graceful error handling
    try {
    // Log all incoming requests
    logger.logRequest(request, {
      requestId,
      pathname: url.pathname,
      hasAuthStorage: !!env.AUTH_STORAGE,
      hasAuthDB: !!env.AUTH_DB,
    });

    // Initialize enterprise route handlers
    const adminEnterpriseRoutes = new AdminEnterpriseRoutes(env.AUTH_DB, env.AUTH_STORAGE);

    // Create storage for UserService and RBAC (needed early for apps)
    const storage = CloudflarePatchedStorage({ namespace: env.AUTH_STORAGE });

    // Create RBAC service (Phase 3: OpenAuth migration)
    const rbacAdapter = new RBACAdapter(env.AUTH_DB);
    const rbacService = new RBACServiceImpl(rbacAdapter, storage);

    // Create audit service for token lifecycle events
    const auditService = new AuditService({ database: env.AUTH_DB });

    // Create UserService and admin user app (Phase 2: OpenAuth migration)
    const userAdapter = new D1UserAdapter({ db: env.AUTH_DB, usersTable: 'users' });
    const userService = createUserService({ storage, d1Adapter: userAdapter });
    const adminUserApp = new Hono();
    adminUserApp.use('*', requireAdmin());  // M2M auth required
    adminUserApp.use('*', adminContextMiddleware);
    adminUserApp.use('*', methodCompatMiddleware);
    // Mount custom user listing route FIRST - provides users with RBAC roles
    adminUserApp.route('/', userListRoutes(env.AUTH_DB));
    // Then OpenAuth's user CRUD routes (GET /:id, POST /, PATCH /:id, DELETE /:id, etc.)
    adminUserApp.route('/', userApiRoutes(userService));
    // Finally custom role management routes (GET /:id/roles, POST /:id/roles, DELETE /:id/roles/:roleId)
    adminUserApp.route('/', userRoleRoutes(env.AUTH_DB, env.AUTH_STORAGE));

    // Create admin RBAC app (Phase 3: OpenAuth migration)
    const adminRbacApp = new Hono();
    adminRbacApp.use('*', requireAdmin());  // M2M auth required
    adminRbacApp.use('*', adminContextMiddleware);
    adminRbacApp.use('*', methodCompatMiddleware);
    adminRbacApp.route('/', rbacAdminEndpoints(rbacService));

    // Create public RBAC app (Phase 3: OpenAuth migration)
    const rbacApp = new Hono();
    // Note: rbacEndpoints expects userId, tenantId, appId from auth middleware
    // These should be set by the parent app's auth middleware before calling rbacApp
    rbacApp.route('/', rbacEndpoints(rbacService));

    // Create admin client app (Phase 4: OpenAuth client management)
    // Uses OpenAuth's clientAdminRoutes with middleware for:
    // - Auth context (adminContextMiddleware)
    // - PUT->PATCH translation (methodCompatMiddleware)
    // - Backward compat response aliases: client_id, allowed_grants (clientResponseCompatMiddleware)
    const adminClientApp = new Hono();
    adminClientApp.use('*', clientResponseCompatMiddleware); // Response transform (runs last in response phase)
    adminClientApp.use('*', adminContextMiddleware);
    adminClientApp.use('*', methodCompatMiddleware);
    adminClientApp.route('/', clientAdminRoutes(env.AUTH_DB));

    // Route request through extracted router
    // Router handles: admin routes, session routes, API routes, redirects, test endpoints
    const routerContext: RouterContext = {
      request,
      env,
      ctx,
      url,
      requestId,
      isProduction,
      adminUserApp,
      adminRbacApp,
      adminClientApp,
      rbacApp,
      adminEnterpriseRoutes,
    };

    const routedResponse = await routeRequest(routerContext);
    if (routedResponse) {
      return routedResponse;
    }

    // Token endpoints (/token, /token/introspect, /token/revoke) are
    // handled by OpenAuth issuer with consistent JWKS keys

    // Initialize OpenAuth enterprise issuer with multi-account session support
    logger.debug('Initializing OpenAuth enterprise issuer', {
      hasStorage: !!env.AUTH_STORAGE,
      issuerEnv: env.OPENAUTH_ISSUER,
    });

    // Note: OpenAuth enterprise issuer handles session management via D1SessionAdapter
    // No need for manual session token tracking - OpenAuth manages the __session cookie

    // Create session and tenant services for enterprise issuer (storage already created above)
    const sessionService = new D1SessionAdapter(env.AUTH_DB);
    const tenantService = new D1TenantAdapter(env.AUTH_DB);
    const sessionSecret = hexToSecret(env.SESSION_SECRET || '0'.repeat(64));

    // RBAC service already created above (Phase 3: reused for both endpoints and token enrichment)

    // Create enterprise issuer with multi-account session support
    const { app } = createMultiTenantIssuer({
      storage,
      sessionService,
      tenantService,
      sessionSecret,
      subjects,
      rbacService,
      clientDb: env.AUTH_DB,
      audit: {
        service: auditService,
        hooks: {
          onTokenGenerated: true,
          onTokenRefreshed: true,
          onTokenRevoked: true,
          onTokenReused: true, // Security: detects potential token theft
        },
      },
      tenantResolver: {
        customDomains: new Map([
          ['localhost', 'default'],
          ['127.0.0.1', 'default'],
          ['auth.alummahnow.net', 'default'],
          ['auth.qa.alummahnow.net', 'default'],
        ]),
      },
      providers: {
        password: PasswordProvider(
          PasswordUI({
            sendCode: createSendCodeHandler(userService, {
              request,
              env,
              ctx,
              requestId,
              url,
            }),
            copy: {
              input_code: "Code (check your inbox)",
            },
          }),
        ),
      },
      theme: (() => {
        // Randomly select a background image
        const backgroundImages = [
          'https://images.alummahnow.net/background_1.jpg',
          'https://images.alummahnow.net/background_3.jpg',
        ];
        const randomBg = backgroundImages[Math.floor(Math.random() * backgroundImages.length)];

        // Detect locale from URL parameter (OpenAuth also does this, but we need it for direction)
        const locale = url.searchParams.get('lang') || 'en';
        const isRtl = locale === 'ar';

        return {
          title: {
            en: "Al Ummah Now",
            ar: "الأمة الآن",
          },
          locale: locale as 'en' | 'ar',
          direction: isRtl ? 'rtl' : 'ltr',
          primary: {
            light: "#d4930d",  // Warm amber gold on light mode
            dark: "#f5b014",   // Warm golden on dark mode
          },
          background: {
            light: "#1a1a1a",
            dark: "#0c0a09",
          },
          favicon: "https://al-ummah-now-images.b-cdn.net/favicon_io/favicon.ico",
          logo: {
            dark: "https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png",
            light: "https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png",
          },
          radius: "md",
          font: {
            family: "Cairo, sans-serif",
          },
          css: `
            @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700&display=swap');

            @font-face {
              font-family: 'Farsi Simple Bold';
              src: url('https://cdn.alummahnow.net/fonts/Farsi%20Simple%20Bold%20Regular.ttf') format('truetype');
              font-display: swap;
            }

            [data-component="root"] {
              background-image: url('${randomBg}');
              background-size: cover;
              background-position: center;
              background-repeat: no-repeat;
            }

            [data-component="center"] {
              background: rgba(0, 0, 0, 0.4);
              padding: 2rem;
              border-radius: 1rem;
              backdrop-filter: blur(10px);
            }

            /* Golden halo around logo */
            [data-component="logo"] {
              filter: drop-shadow(0 0 15px rgba(245, 176, 20, 0.6)) drop-shadow(0 0 30px rgba(245, 176, 20, 0.3));
            }

            /* Style title with Farsi font for Arabic */
            [data-component="title"] {
              font-family: ${isRtl ? '"Farsi Simple Bold"' : 'Cairo, sans-serif'};
            }
          `,
        };
      })(),
      onSuccess: createOnSuccessHandler(userService, rbacService, {
        request,
        env,
        ctx,
        requestId,
      }),
    });

    // Call issuer to handle the request
    // OpenAuth enterprise issuer manages sessions via D1SessionAdapter and sets the __session cookie
    const issuerResponse = await app.fetch(request, env, ctx);

    // DEBUG: Log what the issuer returned
    const isRedirect = issuerResponse.status >= 300 && issuerResponse.status < 400;
    const contentType = issuerResponse.headers.get('Content-Type') || '';
    logger.info('[DEBUG] Issuer response', {
      status: issuerResponse.status,
      isRedirect,
      contentType,
      location: issuerResponse.headers.get('Location') || 'none',
      pathname: url.pathname,
    });

    // If it's JSON but should be a redirect, log more details
    if (contentType.includes('application/json') && url.pathname.includes('/password')) {
      try {
        const clonedResponse = issuerResponse.clone();
        const body = await clonedResponse.text();
        logger.warn('[DEBUG] Unexpected JSON from password flow', {
          body: body.slice(0, 1000),
          pathname: url.pathname,
        });
      } catch (e) {
        logger.error('[DEBUG] Could not read response body', { error: String(e) });
      }
    }

    // Handle session API responses - add CORS and enrich /session/accounts with user data
    if (url.pathname.startsWith('/session/')) {
      const origin = request.headers.get('Origin');
      const allowedOrigins = getAllowedOrigins(env, origin);
      const isAllowed = origin && matchOrigin(origin, [...allowedOrigins, ...(env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) || [])]);

      let finalResponse = issuerResponse;

      // Enrich /session/accounts response with user profile data (email, name, avatar)
      // OpenAuth only returns session data, but profile app needs user info
      if (url.pathname === '/session/accounts' && issuerResponse.ok) {
        try {
          const data = await issuerResponse.clone().json() as { accounts?: Array<{ userId: string; isActive: boolean; authenticatedAt: number }> };
          if (data.accounts && data.accounts.length > 0) {
            // Fetch user data for all accounts
            const userIds = data.accounts.map(a => a.userId);
            const placeholders = userIds.map(() => '?').join(',');
            const usersResult = await env.AUTH_DB
              .prepare(`SELECT id, email, name FROM users WHERE id IN (${placeholders})`)
              .bind(...userIds)
              .all();

            const usersMap = new Map<string, { email: string; name: string | null }>();
            for (const row of usersResult.results || []) {
              usersMap.set(row.id as string, {
                email: row.email as string,
                name: row.name as string | null,
              });
            }

            // Enrich accounts with user data
            const enrichedAccounts = data.accounts.map(account => {
              const user = usersMap.get(account.userId);
              return {
                ...account,
                email: user?.email || '',
                name: user?.name || null,
                lastUsed: new Date(account.authenticatedAt * 1000).toISOString(),
              };
            });

            const enrichedData = { accounts: enrichedAccounts };
            finalResponse = new Response(JSON.stringify(enrichedData), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        } catch (e) {
          logger.error('Failed to enrich session accounts', { error: String(e) });
          // Fall back to original response
        }
      }

      if (isAllowed && origin) {
        const corsHeaders = new Headers(finalResponse.headers);
        corsHeaders.set('Access-Control-Allow-Origin', origin);
        corsHeaders.set('Access-Control-Allow-Credentials', 'true');
        const corsResponse = new Response(finalResponse.body, {
          status: finalResponse.status,
          statusText: finalResponse.statusText,
          headers: corsHeaders,
        });
        return addSecurityHeaders(corsResponse, isProduction);
      }

      return addSecurityHeaders(finalResponse, isProduction);
    }

    // Apply security headers to all OpenAuth responses
    return addSecurityHeaders(issuerResponse, isProduction);

    } catch (error) {
      // Log the error
      logger.error('Unhandled error in request handler', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        pathname: url.pathname,
      });

      // Finalize logging
      ctx.waitUntil(logger.finalizeRequest());

      // Return user-friendly error page with original URL preserved
      return addSecurityHeaders(renderErrorPage(error, requestId, request.url), isProduction);
    }
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
      logger.error('Scheduled token cron failed', { cronName, error });
      // Don't throw - let other scheduled tasks continue
    }
  },
} satisfies ExportedHandler<Env>;


