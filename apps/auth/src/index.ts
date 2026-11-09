import { Hono } from "hono";
import { createMultiTenantIssuer } from "@al-ummah-now/openauth";
import { RBACAdapter, RBACServiceImpl, rbacEndpoints, rbacAdminEndpoints } from "@al-ummah-now/openauth/rbac/index";
import { authStorage } from "./storage/auth-storage";
import { D1SessionAdapter } from "./adapters/session-adapter";
import { D1TenantAdapter } from "./adapters/tenant-adapter";
import { hexToSecret } from "./utils/crypto";
import { isAllowedOrigin } from "./utils/cors";
import { addSecurityHeaders } from "./utils/security-headers";
import { renderErrorPage } from "./ui/error-page";
import { signInFallbackUrl, clientRegistryMode } from "./utils/sign-in-restart";
import { withPreviewRedirects } from "./utils/preview-redirects";
import { createOnSuccessHandler, createSendCodeHandler } from "./handlers/auth-handlers";
import { PasswordProvider } from "@al-ummah-now/openauth/provider/password";
import { PasswordUI } from "@al-ummah-now/openauth/ui/password";
import { createSubjects } from "@al-ummah-now/openauth/subject";
import * as v from 'valibot';
import { logger } from "./logger";
import { AdminEnterpriseRoutes } from "./admin-enterprise-routes";
import { ensureAuditEmitter, flushAuditEvents } from "./audit-emitter";
import { resolveRequestId, withRequestId } from "./utils/request-id";
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
import { ACCOUNT_PICKER_REMOVE_PATH, afterAccountPickerRemove } from "./handlers/account-picker-signout";
import { deepHealth } from "./health";
import { requestTheme } from "./ui/theme";
import { tenantCustomDomains } from "./utils/tenant-domains";
import { guardIssuerStorage, handleTokenRevoke, parseAccessTtl } from "./revocation/token-gate";
import { revokeOnAdminUserAction, revokeOnPasswordChange } from "./revocation/lifecycle";
import { guardPasswordRequest, type PasswordCopy } from "./security/password-guard";
import { DEFAULT_SITE_THEME, fetchSiteTheme } from '../../../packages/ui/src/site-theme';
import { applySiteTheme, withSiteTheme } from './ui/site-theme';

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
 * Initialize the shared audit emitter for this invocation.
 * Events go to stdout + AUDIT_QUEUE (consumed by apps/audit-consumer into
 * audit_events); without a queue binding they are written to D1 directly.
 */
function setupAuditEmitter(env: Env, ctx: ExecutionContext) {
  return ensureAuditEmitter({
    enableStdout: true,
    webhookUrl: env.AUDIT_WEBHOOK_URL,
    webhookSecret: env.AUDIT_WEBHOOK_SECRET,
    db: env.AUTH_DB,
    queue: env.AUDIT_QUEUE,
    ctx,
    d1Config: {
      batchSize: 1,  // Write events immediately when falling back to direct D1
      batchTimeout: 100,
    },
  });
}

/** Public liveness probe (Issue #96). Intentionally reveals nothing about dependencies. */
function healthResponse(method: string): Response {
  return new Response(method === 'HEAD' ? null : JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = resolveRequestId(request);
    const { pathname } = new URL(request.url);

    if (pathname === '/health' && (request.method === 'GET' || request.method === 'HEAD')) {
      // ?deep=1: release smoke check that every required binding resolves (src/health.ts)
      if (request.method === 'GET' && new URL(request.url).searchParams.get('deep') === '1') {
        const report = await deepHealth(env);
        return withRequestId(
          new Response(JSON.stringify(report), {
            status: report.status === 'ok' ? 200 : 503,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          }),
          requestId
        );
      }
      return withRequestId(healthResponse(request.method), requestId);
    }

    setupAuditEmitter(env, ctx);
    try {
      const response = await handleFetch(request, env, ctx, requestId);
      return withRequestId(response, requestId);
    } finally {
      // Deliver any audit events buffered during this request
      ctx.waitUntil(flushAuditEvents());
    }
  },

  /**
   * Scheduled handler for cron triggers.
   * Cron expressions are configured in `triggers.crons` (wrangler.json production env
   * and wrangler.qa.json) and mapped to jobs in cron/token-cron.ts.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    logger.setDatabase(env.AUTH_DB, false);
    logger.setContext(ctx);
    setupAuditEmitter(env, ctx);

    try {
      await handleTokenCron(env, event.cron);
    } catch (error) {
      logger.error('Scheduled cron failed', {
        cron: event.cron,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - let other scheduled tasks continue
    } finally {
      ctx.waitUntil(flushAuditEvents());
      ctx.waitUntil(logger.finalizeRequest());
    }
  },
} satisfies ExportedHandler<Env>;

async function handleFetch(request: Request, env: Env, ctx: ExecutionContext, requestId: string): Promise<Response> {
    const url = new URL(request.url);

    // Determine if running in production (test endpoints disabled in production)
    // Use ENVIRONMENT env var if set, otherwise fall back to hostname check
    const isProduction = env.ENVIRONMENT
      ? env.ENVIRONMENT === 'production'
      : (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1');

    // D1 logging stays off: every log line cost ~4 rows written (row, two
    // indexes, autoincrement) and nothing reads the table. Logs go to Workers Logs.
    logger.setDatabase(env.AUTH_DB, false);
    logger.setContext(ctx);

    // Initialize request context to prevent stale timer usage
    logger.initialRequest(requestId);

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
    // Codes, refresh tokens and other single-use credentials go to D1 (KV can't make them single-use)
    const storage = authStorage(env);

    // Create RBAC service (Phase 3: OpenAuth migration)
    const rbacAdapter = new RBACAdapter(env.AUTH_DB);
    const rbacService = new RBACServiceImpl(rbacAdapter, storage);

    // Create UserService and admin user app (Phase 2: OpenAuth migration)
    const userAdapter = new D1UserAdapter({ db: env.AUTH_DB, usersTable: 'users' });
    const userService = createUserService({ storage, d1Adapter: userAdapter });
    const adminUserApp = new Hono();
    adminUserApp.use('*', requireAdmin());  // M2M auth required
    adminUserApp.use('*', adminContextMiddleware);
    adminUserApp.use('*', methodCompatMiddleware);
    // Suspend/delete/session wipe/forced reset sign the user out everywhere (#437)
    adminUserApp.use('*', revokeOnAdminUserAction(env.TOKEN_REVOCATIONS, env.AUTH_DB));
    // Mount custom user listing route FIRST - provides users with RBAC roles
    adminUserApp.route('/', userListRoutes(env.AUTH_DB));
    // Then OpenAuth's user CRUD routes (GET /:id, POST /, PATCH /:id, DELETE /:id, etc.)
    adminUserApp.route('/', userApiRoutes(userService));
    // Finally custom role management routes (GET /:id/roles, POST /:id/roles, DELETE /:id/roles/:roleId)
    adminUserApp.route('/', userRoleRoutes(env.AUTH_DB, env.AUTH_STORAGE, env.OPENAUTH_ISSUER));

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
    adminClientApp.use('*', requireAdmin());  // M2M auth required
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

    // Token endpoints (/token, /token/introspect) are handled by the OpenAuth
    // issuer with consistent JWKS keys. /token/revoke is ours (#437): the
    // issuer's needs client authentication our public clients don't have.
    if (request.method === 'POST' && url.pathname === '/token/revoke') {
      return await handleTokenRevoke(request, storage);
    }
    const accessTtl = parseAccessTtl(env.ACCESS_TOKEN_TTL);

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
    // SESSION_SECRET encrypts the __session SSO cookie (A256GCM JWE). The all-zero
    // fallback is a public key, so production refuses to run without the secret.
    if (!env.SESSION_SECRET && env.ENVIRONMENT === 'production') {
      logger.error('SESSION_SECRET is not set; refusing to issue SSO sessions with a public key');
      return new Response('Server misconfigured', { status: 503 });
    }
    if (!env.SESSION_SECRET) {
      logger.warn('SESSION_SECRET is not set; using the insecure development key');
    }
    const sessionSecret = hexToSecret(env.SESSION_SECRET || '0'.repeat(64));

    // RBAC service already created above (Phase 3: reused for both endpoints and token enrichment)

    // Attempt limits for the password provider's POSTs and email codes (AU-2).
    // PasswordUI reads this copy object on every render, so the guard can swap in
    // a "too many attempts" message for this request.
    const passwordCopy: PasswordCopy = { input_code: "Code (check your inbox)" };
    const passwordGuard = await guardPasswordRequest(request, env, url, passwordCopy);

    // Create enterprise issuer with multi-account session support
    // Only pages need the theme; token and API calls skip the lookup
    const siteTheme = (request.headers.get('Accept') ?? '').includes('text/html')
      ? await fetchSiteTheme(env.ADMIN_API_URL)
      : DEFAULT_SITE_THEME;

    const { app } = createMultiTenantIssuer({
      // Pin the issuer: used for the `iss` claim, discovery documents and token
      // verification instead of the request Host / X-Forwarded-* headers.
      issuer: env.OPENAUTH_ISSUER || undefined,
      // Refresh tokens of revoked sign-ins read as missing; old sessions get
      // the current access-token lifetime on their next refresh (#437)
      storage: guardIssuerStorage(storage, { revocations: env.TOKEN_REVOCATIONS, accessTtl }),
      ...(accessTtl ? { ttl: { access: accessTtl } } : {}),
      sessionService,
      tenantService,
      sessionSecret,
      subjects,
      rbacService,
      // QA only: per-PR web previews (see preview-redirects.ts)
      clientDb: withPreviewRedirects(env.AUTH_DB, env, request),
      // Unrecoverable sign-in state (stale tab, bookmark, cookies cleared) shows a
      // friendly en/ar "Start sign-in again" page; this is where it links when the
      // sign-in's app is unknown.
      restart: { fallbackUrl: signInFallbackUrl(env) },
      // Unknown/disabled clients and unregistered redirect_uris (exact match)
      // get a clear error page (enforce) or are only logged (report)
      clientRegistry: clientRegistryMode(env),
      // Device authorization grant (RFC 8628, Epic 9.2) for TV apps: codes live
      // 10 min, polling every 5 s (slow_down on faster), /activate is the en/ar
      // page where the user enters the code. Only clients registered with the
      // device_code grant may use it. Cloudflare sets cf-connecting-ip (the
      // rate-limit key) and clients cannot override it.
      device: {
        expiresIn: 600,
        interval: 5,
        ipHeader: "cf-connecting-ip",
      },
      tenantResolver: {
        customDomains: tenantCustomDomains(env.OPENAUTH_ISSUER),
      },
      providers: {
        password: PasswordProvider({
          ...PasswordUI({
            sendCode: createSendCodeHandler(
              userService,
              { request, env, ctx, requestId, url },
              storage,
            ),
            copy: passwordCopy,
          }),
          // Every submitted email code is counted in D1: 5 tries, 15 minutes, single use
          checkCode: passwordGuard.checkCode,
          // A password reset signs the account out everywhere (#437)
          onPasswordChanged: async (email: string) => {
            await revokeOnPasswordChange(env.AUTH_DB, env.TOKEN_REVOCATIONS, email);
          },
        }),
      },
      // Per request: OpenAuth renders each page with its own request's theme and ?lang=,
      // in the site-wide theme the admins chose (Fawanees by default)
      theme: withSiteTheme(requestTheme(), siteTheme),
      onSuccess: createOnSuccessHandler(userService, rbacService, {
        request,
        env,
        ctx,
        requestId,
      }),
    });

    // Call issuer to handle the request
    // OpenAuth enterprise issuer manages sessions via D1SessionAdapter and sets the __session cookie
    let issuerResponse = applySiteTheme(await passwordGuard.finish(await app.fetch(passwordGuard.request, env, ctx)), siteTheme);

    // Picker "Sign out" of the last account: single sign-out (#219)
    if (request.method === 'POST' && url.pathname === ACCOUNT_PICKER_REMOVE_PATH) {
      issuerResponse = await afterAccountPickerRemove(request, env, issuerResponse);
    }

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
      // Every /session/* response (GET /session/accounts, POST /session/switch,
      // DELETE /session/accounts/:userId, ...) gets credentialed CORS for our apps.
      const origin = request.headers.get('Origin');
      const isAllowed = isAllowedOrigin(origin, env);

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
                // authenticatedAt is epoch milliseconds (seconds in older rows)
                lastUsed: new Date(account.authenticatedAt < 1e12 ? account.authenticatedAt * 1000 : account.authenticatedAt).toISOString(),
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

      if (isAllowed) {
        const corsHeaders = new Headers(finalResponse.headers);
        corsHeaders.set('Access-Control-Allow-Origin', origin);
        corsHeaders.set('Access-Control-Allow-Credentials', 'true');
        corsHeaders.append('Vary', 'Origin');
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
      return addSecurityHeaders(renderErrorPage(error, requestId, request.url, request), isProduction);
    }
}
