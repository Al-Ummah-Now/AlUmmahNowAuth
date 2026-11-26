import { ageBandClaims, ageBandClaimsSupported } from './birth-date/band';
import { Hono } from "hono";
import { roleAdminRoutes } from './custom/role-admin-routes';
import { isWellKnownRequest, serveWellKnown } from './well-known-cache';
import { createMultiTenantIssuer } from "@al-ummah-now/openauth";
import { RBACAdapter, RBACServiceImpl, rbacEndpoints, rbacAdminEndpoints } from "@al-ummah-now/openauth/rbac/index";
import { authStorage } from "./storage/auth-storage";
import { D1UserService } from "./services/d1-user-service";
import { PKCE_REQUIRED_CLIENTS } from "./pkce-clients";
import { CONFIDENTIAL_CLIENTS } from "./confidential-clients";
import { D1SessionAdapter } from "./adapters/session-adapter";
import { D1TenantAdapter } from "./adapters/tenant-adapter";
import { hexToSecret } from "./utils/crypto";
import { isAllowedOrigin } from "./utils/cors";
import { addSecurityHeaders } from "./utils/security-headers";
import { protectAccountAnswer } from "./utils/account-answers";
import { renderErrorPage } from "./ui/error-page";
import { reportAuthError } from "./errors/report";
import { flagSystemAccountAttempt } from './security/system-accounts';
import { markCreatedRunUser } from './custom/run-user-marker';
import { systemAccountGuard } from './custom/system-account-guard';
import { signInFallbackUrl, clientRegistryMode } from "./utils/sign-in-restart";
import { withAddedRedirect, withPreviewRedirects } from "./utils/preview-redirects";
import { allowedSiteRedirect } from "./utils/site-redirects";
import { sessionSecretUsable } from "./utils/session-secret";
import { createOnSuccessHandler, createSendCodeHandler } from "./handlers/auth-handlers";
import { createRefreshCheck } from "./handlers/refresh-check";
import { PasswordProvider } from "@al-ummah-now/openauth/provider/password";
import { PasswordUI } from "@al-ummah-now/openauth/ui/password";
import { PasskeyProvider } from "@al-ummah-now/openauth/provider/passkey";
import { getCredential, touchCredential } from "./passkeys/store";
import { passkeyDeadline } from "./passkeys/policy";
import { rpId, rpOrigins } from "./passkeys/rp";
import { nativePasskeyOptions, routeNativePasskeys } from "./passkeys/native";
import { getLocaleFromRequest } from "@al-ummah-now/openauth/ui/i18n";
import { createSubjects } from "@al-ummah-now/openauth/subject";
import * as v from 'valibot';
import { logger } from "./logger";
import { AdminEnterpriseRoutes } from "./admin-enterprise-routes";
import { ensureAuditEmitter, flushAuditEvents } from "./audit-emitter";
import { recordPasswordSignInFailure, recordTokenRejection, type PasswordSignInFailure } from './security/bounded-audit';
import { getClientIP } from './rate-limit';
import { readTokenRequestFields, tokenRateLimitBuckets } from './utils/token-rate-limit-subject';
import { resolveRequestId, withRequestId } from "./utils/request-id";
import { RequestTimer, instrumentCtx, instrumentEnv, shouldLogTiming } from "./utils/request-timing";
import {
  userApiRoutes,
  D1UserAdapter,
  clientAdminRoutes,
} from "@al-ummah-now/openauth";
import { userRoleRoutes } from "./custom/user-role-routes";
import { userListRoutes } from "./custom/user-list-routes";
import { adminContextMiddleware, methodCompatMiddleware, clientResponseCompatMiddleware } from "./custom/admin-context-middleware";
import { requireAdmin } from "./middleware/admin-auth";
import { handleTokenCron } from "./cron/token-cron";
import { hideDeleted, refuseDeletedRoleAssignment, softDeleteRoute } from "./deletions/routes";
import { routeRequest, type RouterContext } from "./router";
import { ACCOUNT_PICKER_REMOVE_PATH, afterAccountPickerRemove } from "./handlers/account-picker-signout";
import { deepHealth } from "./health";
import { applyLogLevel } from "../../../packages/ui/src/log-level.ts";
import { noIndexWorker } from '../../../packages/ui/src/crawlers.ts';
import { releaseCheckedWorker } from '../../../packages/ui/src/release-check.ts';
import { resolveUserDisplayName } from "../../../packages/ui/src/display-name.ts";
import { tenantCustomDomains } from "./utils/tenant-domains";
import { guardIssuerStorage, handleTokenRevoke, parseAccessTtl, parseRefreshTtl } from "./revocation/token-gate";
import { revokeOnAdminUserAction, revokeOnPasswordChange } from "./revocation/lifecycle";
import { guardPasswordRequest, routedPath, type PasswordCopy } from "./security/password-guard";
import { isEmailAvailable, isEmailOnlyPasswordRoute, withoutEmailLinks } from "./utils/email-availability";
import { ADMIN_NATIVE_CLIENT_IDS } from "./admin-native-clients";
import { safePasswordChangeRequest } from "./security/password-change-redirect";
import { injectTurnstile, widgetScriptUrl } from "./security/turnstile";
import { addNoPasswordOptions, addSetupHeading } from "./sign-in-link/page";
import { csrfFor as signInCsrfFor, hasPassword } from "./sign-in-link/routes";
import { handleModerationBatch, type ModerationQueueMessage } from './moderation/queue';
import { handleRotationMessages } from './signing-keys/rotation';
import { handleAccountEventBatch, isAccountEventQueue } from './account-events/deliver';
import { createActionRunner } from './moderation/actions';
import { openauthThemeFor } from '../../../packages/ui/src/auth-theme/compile.ts';
import { compileBuiltin } from '../../../packages/ui/src/auth-theme/builtin.ts';
import { BUILTIN_DEFAULT_THEME } from '../../../packages/ui/src/auth-theme/resolve.ts';
import { serveIcon, signInFavicon } from './themes/favicon';
import { PASSWORD_COPY, sendCodeRateLimitMessage } from "./ui/copy";
import { ThemeStore } from "./themes/store";
import { assetBaseOf, resolveRequestTheme } from "./themes/runtime";
import { finishThemedResponse, requestedTheme, signInHeaderFor, wantsPage } from "./themes/pages";

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
    // Never sampled in production, whatever the config says.
    sample: env.ENVIRONMENT === 'production' ? undefined : env.AUDIT_SAMPLE,
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

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    applyLogLevel(env.LOG_LEVEL);
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

    // Tab and app icons: public, before any issuer work
    const icon = serveIcon(pathname, request.method);
    if (icon) return withRequestId(icon, requestId);

    // The audit emitter is shared by the isolate's requests: it gets the plain bindings
    setupAuditEmitter(env, ctx);
    // Per-request timings of the bindings and stages: Server-Timing + an auth.timing log line (#804)
    const timer = new RequestTimer();
    const timedCtx = instrumentCtx(ctx, timer);
    let response: Response | undefined;
    try {
      const timedEnv = instrumentEnv(env, timer);
      // jwks / openid-configuration: edge-cached, last good copy when the issuer fails (well-known-cache.ts)
      const handled = isWellKnownRequest(request.method, new URL(request.url))
        ? await serveWellKnown(request, ctx, () =>
            handleFetch(request.method === 'HEAD' ? new Request(request, { method: 'GET' }) : request, timedEnv, timedCtx, requestId, timer)
          )
        : await handleFetch(request, timedEnv, timedCtx, requestId, timer);
      response = withRequestId(reportUnreported5xx(protectAccountAnswer(pathname, handled, isProductionRequest(env, new URL(request.url).hostname)), request, env, ctx, requestId), requestId);
      return withServerTiming(response, timer);
    } finally {
      // Deliver any audit events buffered during this request
      timedCtx.waitUntil(flushAuditEvents());
      logTiming(ctx, timer, request.method, pathname, response?.status ?? 500, requestId);
    }
  },

  /**
   * Scheduled handler for cron triggers.
   * Cron expressions are configured in `triggers.crons` (wrangler.json production env
   * and wrangler.qa.json) and mapped to jobs in cron/token-cron.ts.
   */
  /**
   * moderation-actions[-env] and its DLQ, the worker's job queue: approved
   * moderation requests' actions (moderation/queue.ts) and signing-key rotation
   * steps (signing-keys/rotation.ts), retried with backoff; failures are flagged.
   * account-events[-env] and its DLQ: account events to subscribed clients (account-events/deliver.ts).
   */
  async queue(batch: MessageBatch<ModerationQueueMessage>, env: Env, ctx: ExecutionContext) {
    applyLogLevel(env.LOG_LEVEL);
    logger.setDatabase(env.AUTH_DB, false);
    logger.setContext(ctx);
    setupAuditEmitter(env, ctx);
    try {
      if (isAccountEventQueue(batch.queue)) {
        await handleAccountEventBatch(batch as MessageBatch<unknown>, env);
        return;
      }
      // Signing-key rotation steps share the queue (signing-keys/rotation.ts)
      await handleRotationMessages(batch as MessageBatch<unknown>, env);
      await handleModerationBatch(batch, env, createActionRunner(env));
    } finally {
      ctx.waitUntil(flushAuditEvents());
      ctx.waitUntil(logger.finalizeRequest());
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    applyLogLevel(env.LOG_LEVEL);
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

/** ENVIRONMENT when it is set; otherwise any host but this machine */
function isProductionRequest(env: Env, hostname: string): boolean {
  return env.ENVIRONMENT ? env.ENVIRONMENT === 'production' : hostname !== 'localhost' && hostname !== '127.0.0.1';
}

/** Nothing on this host is for search engines: robots.txt Disallow: / and X-Robots-Tag: noindex (packages/ui/src/crawlers.ts) */
// releaseCheckedWorker: outermost, proves to the release which version answered (packages/ui/src/release-check.ts)
export default releaseCheckedWorker(noIndexWorker(worker));

/**
 * A 5xx answered without a report (a route that returned 500/503 itself, not by throwing):
 * reported as an http error so it shows on the Errors page too (AlUmmahNowAuth#341).
 */
function reportUnreported5xx(res: Response, request: Request, env: Env, ctx: ExecutionContext, requestId: string): Response {
  if (res.status < 500 || res.headers.has('X-Error-Ref')) return res;
  const ref = reportAuthError(env, ctx, null, { kind: 'http', status: res.status, route: new URL(request.url).pathname, method: request.method, requestId, request });
  try {
    res.headers.set('X-Error-Ref', ref);
    return res;
  } catch {
    const copy = new Response(res.body, res);
    copy.headers.set('X-Error-Ref', ref);
    return copy;
  }
}

function withServerTiming(response: Response, timer: RequestTimer): Response {
  if (response.status === 101) return response;
  try {
    response.headers.append('Server-Timing', timer.serverTiming());
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.append('Server-Timing', timer.serverTiming());
    return copy;
  }
}

/**
 * One `auth.timing` line per sign-in chain request (and per slow request):
 * path without the query string, stages, binding totals and the slowest calls.
 * `auth.timing.background` follows once the request's waitUntil work settled.
 */
function logTiming(ctx: ExecutionContext, timer: RequestTimer, method: string, path: string, status: number, requestId: string) {
  const elapsed = timer.elapsed();
  if (!shouldLogTiming(path, elapsed)) return;
  console.info(JSON.stringify({ msg: 'auth.timing', requestId, method, path, status, ...timer.summary() }));
  ctx.waitUntil(
    timer.backgroundDurations().then((ms) => {
      if (ms.length) console.info(JSON.stringify({ msg: 'auth.timing.background', requestId, method, path, waitUntilMs: ms }));
    })
  );
}

async function handleFetch(request: Request, env: Env, ctx: ExecutionContext, requestId: string, timer: RequestTimer): Promise<Response> {
    // Forgot-password redirect_uri: only same-origin paths or a client's registered URI (#206)
    request = await safePasswordChangeRequest(request, env);
    const url = new URL(request.url);

    // Determine if running in production (test endpoints disabled in production)
    // Use ENVIRONMENT env var if set, otherwise fall back to hostname check
    const isProduction = isProductionRequest(env, url.hostname);

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
    const storage = authStorage(env, { waitUntil: (promise) => ctx.waitUntil(promise) });

    // Create RBAC service (Phase 3: OpenAuth migration)
    const rbacAdapter = new RBACAdapter(env.AUTH_DB);
    const rbacService = new RBACServiceImpl(rbacAdapter, storage);

    // Create UserService and admin user app (Phase 2: OpenAuth migration)
    const userAdapter = new D1UserAdapter({ db: env.AUTH_DB, usersTable: 'users' });
    // D1 is the source of truth for users (AU-3); KV is read only for accounts D1 lacks
    const userService = new D1UserService({ db: env.AUTH_DB, adapter: userAdapter, legacy: storage });
    const adminUserApp = new Hono();
    adminUserApp.use('*', requireAdmin());  // M2M auth required
    adminUserApp.use('*', adminContextMiddleware);
    adminUserApp.use('*', methodCompatMiddleware);
    // System accounts: hidden by id, never changed, never granted a role (custom/system-account-guard.ts)
    adminUserApp.use('*', systemAccountGuard({ users: true }));
    // Suspend/delete/session wipe/forced reset sign the user out everywhere (#437)
    adminUserApp.use('*', revokeOnAdminUserAction(env.TOKEN_REVOCATIONS, env.AUTH_DB));
    // A deleted role can't be assigned; DELETE /:id is a soft delete (deletions/), ahead of OpenAuth's
    adminUserApp.use('*', refuseDeletedRoleAssignment());
    // E2E run accounts made in the admin get the run marker (QA and stage only)
    adminUserApp.use('/', markCreatedRunUser(env as unknown as Parameters<typeof markCreatedRunUser>[0]));
    adminUserApp.delete('/:id', softDeleteRoute('user', 'id'));
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
    adminRbacApp.use('*', systemAccountGuard());
    // Deleted roles: hidden from OpenAuth's role routes, not assignable; DELETE is a soft delete
    adminRbacApp.use('*', hideDeleted('role', { prefix: 'roles', listKey: 'roles' }));
    adminRbacApp.use('*', refuseDeletedRoleAssignment());
    adminRbacApp.delete('/roles/:roleId', softDeleteRoute('role', 'roleId'));
    // The accounts admin's role page: a role's users and every permission (custom/role-admin-routes.ts)
    adminRbacApp.route('/', roleAdminRoutes(env.AUTH_DB));
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
    // Deleted clients: hidden from OpenAuth's client routes; DELETE is a soft delete
    adminClientApp.use('*', hideDeleted('client', { prefix: 'clients', listKey: 'clients' }));
    adminClientApp.delete('/clients/:clientId', softDeleteRoute('client', 'clientId'));
    adminClientApp.route('/', clientAdminRoutes(env.AUTH_DB));

    // Route request through extracted router
    // Router handles: admin routes, session routes, API routes, redirects, test endpoints
    // Whether Auth can send email (the Resend key resolves), once per request.
    // Every feature that needs an emailed code is hidden without it: the
    // sign-in page's "Create account" / "Forgot password?" links, the
    // /password/register and /password/change routes, and a staff member's
    // first passkey (utils/email-availability.ts). Read by the router
    // (passkeys), the password routes below and the after-sign-in card.
    const emailAvailable = await isEmailAvailable(env);
    const { pathname } = url;
    const path = routedPath(pathname);
    const tokenBuckets = pathname === '/token' || pathname === '/token/introspect' || pathname === '/token/revoke'
      ? tokenRateLimitBuckets(request, pathname, getClientIP(request), await readTokenRequestFields(request))
      : [];

    const routerContext: RouterContext = {
      request,
      emailAvailable,
      tokenBuckets,
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

    const routedResponse = await timer.stage('router', () => routeRequest(routerContext));
    if (routedResponse) {
      return routedResponse;
    }

    // Native apps add a passkey with their access token (AUTH-PASSKEYS "Native apps");
    // native sign-in itself is the issuer's /native/passkey/options and /verify below
    const nativeRegistration = routeNativePasskeys({ request, env: env as never, ctx, requestId, storage, emailAvailable });
    if (nativeRegistration) {
      return addSecurityHeaders(await nativeRegistration, isProduction);
    }

    // Token endpoints (/token, /token/introspect) are handled by the OpenAuth
    // issuer with consistent JWKS keys. /token/revoke is ours (#437): the
    // issuer's needs client authentication our public clients don't have.
    if (request.method === 'POST' && url.pathname === '/token/revoke') {
      return await handleTokenRevoke(request, storage);
    }
    const accessTtl = parseAccessTtl(env.ACCESS_TOKEN_TTL);
    // Refresh tokens live 30 days from their last use (#419), not openauth's one year
    const refreshTtl = parseRefreshTtl(env.REFRESH_TOKEN_TTL);

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
    // fallback is a public key: anyone could mint a session for any account. Only a
    // local development worker may use it; every deployed env (QA, stage, production)
    // refuses to run without the secret.
    if (!sessionSecretUsable(env)) {
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
    // In the page's own language: copy overrides openauth's translation in every locale.
    const locale = getLocaleFromRequest(request);
    const passwordCopy: PasswordCopy = { ...PASSWORD_COPY[locale] };
    // Register and forgot password only work by emailing a code: without email they are not there
    if (!emailAvailable && isEmailOnlyPasswordRoute(routedPath(url.pathname))) {
      return addSecurityHeaders(new Response('Not found', { status: 404 }), isProduction);
    }
    // The password sign-in POST's email, read before the guard and the issuer take the body:
    // an email with no password gets the two options (sign-in-link/) instead of "wrong password"
    const signInPath = path === '/password/authorize';
    const passwordSignIn = signInPath && request.method === 'POST';
    const postedEmail = passwordSignIn
      ? await request.clone().formData().then((f) => f.get('email'), () => null)
      : null;
    const onPasswordSignInFailure = passwordSignIn
      ? (outcome: PasswordSignInFailure) => recordPasswordSignInFailure(routerContext, outcome)
      : undefined;
    const passwordGuard = await timer.stage('guard', () => guardPasswordRequest(
      request, env, url, passwordCopy, (promise) => ctx.waitUntil(promise), onPasswordSignInFailure,
    ));

    // The page's theme, from Auth's own themes (Auth admin): the per-call ?theme=
    // if it is published, else the client's default (known at /authorize), else
    // Auth's default. Token and API calls skip the lookup.
    const issuerOrigin = assetBaseOf(env, url);
    const isPage = wantsPage(request);
    const theme = isPage
      ? (await timer.stage('theme', () => resolveRequestTheme(new ThemeStore(env.AUTH_DB, env.AUTH_THEMES), {
          requested: requestedTheme(url),
          clientId: url.pathname === '/authorize' ? url.searchParams.get('client_id') : null,
          assetBase: issuerOrigin,
        }))).compiled
      : compileBuiltin(BUILTIN_DEFAULT_THEME, issuerOrigin)!;

    const openauthTheme = { ...openauthThemeFor(theme), favicon: signInFavicon(theme, env.ENVIRONMENT) };
    // Scholar sites: the one exact callback of a live site's primary host (site-redirects.ts)
    const siteRedirect = await allowedSiteRedirect(env, request);
    let sendCodeRetryAfter: number | undefined;
    const passwordUI = PasswordUI({
      sendCode: createSendCodeHandler(
        userService,
        {
          request, env, ctx, requestId, url, emailTheme: theme.email, timer,
          onRateLimit(retryAfterSeconds) {
            sendCodeRetryAfter = retryAfterSeconds;
            passwordCopy.error_code_send_failed = sendCodeRateLimitMessage(locale, retryAfterSeconds);
          },
        },
        storage,
      ),
      copy: passwordCopy,
      // "Sign in with a passkey" and passkeys in the email autofill (AUTH-PASSKEYS)
      passkey: true,
    });
    const { app } = createMultiTenantIssuer({
      // Pin the issuer: used for the `iss` claim, discovery documents and token
      // verification instead of the request Host / X-Forwarded-* headers.
      issuer: env.OPENAUTH_ISSUER || undefined,
      // Refresh tokens of revoked sign-ins read as missing; old sessions get
      // the current access-token lifetime on their next refresh (#437), and the
      // current refresh lifetime; one-year tokens unused for 30 days are refused (#419)
      // Codes and device grants of suspended/deleted accounts (D1) are refused (#662)
      storage: guardIssuerStorage(storage, { revocations: env.TOKEN_REVOCATIONS, revocationsDb: env.AUTH_DB, accessTtl, refreshTtl, db: env.AUTH_DB }),
      // Codes live 10 minutes (RFC 6749 maximum): the after-sign-in passkey card
      // (AUTH-PASSKEYS) shows before the redirect that carries the code
      // Refresh tokens: REFRESH_TOKEN_TTL (30 days) sliding: each refresh rotates
      // the token and the next one lives that long again (#419)
      ttl: { ...(accessTtl ? { access: accessTtl } : {}), refresh: refreshTtl, code: 600 },
      // Public clients (no secret) must send PKCE S256 on /authorize (#211), and
      // codes of these clients are redeemed only with PKCE (OA-1, see pkce-clients.ts)
      pkce: { requireForPublicClients: true, requireForCodeExchange: PKCE_REQUIRED_CLIENTS },
      // These confidential clients always authenticate with their secret on the
      // code exchange and refresh (#211, see confidential-clients.ts)
      requireClientAuthentication: CONFIDENTIAL_CLIENTS,
      sessionService,
      tenantService,
      sessionSecret,
      subjects,
      rbacService,
      // QA only: per-PR web previews (see preview-redirects.ts); every env: scholar sites (site-redirects.ts)
      clientDb: siteRedirect
        ? withAddedRedirect(env.AUTH_DB, siteRedirect.clientId, siteRedirect.redirectUri)
        : withPreviewRedirects(env.AUTH_DB, env, request),
      // Unrecoverable sign-in state (stale tab, bookmark, cookies cleared) shows a
      // friendly en/ar "Start sign-in again" page; this is where it links when the
      // sign-in's app is unknown.
      restart: { fallbackUrl: signInFallbackUrl(env) },
      // Unexpected issuer errors (storage, a dependency, a bug) go to the videos admin Errors page
      // with their stack; the browser gets the en/ar "Something went wrong / Try again" page with the
      // reference (AlUmmahNowAuth#341), never raw JSON
      onServerError: (error, req) =>
        reportAuthError(env, ctx, error, { route: new URL(req.url).pathname, method: req.method, requestId, request: req }),
      // Unknown/disabled clients and unregistered redirect_uris (exact match)
      // get a clear error page (enforce) or are only logged (report)
      clientRegistry: clientRegistryMode(env),
      // service_documentation in both discovery documents: how to use the sign-in (AUTH-R4)
      documentation: "https://alummahnow.dev/en/auth/",
      // age_band on first-party access tokens, and in claims_supported, while the birth_date setting is on (wiki E20 §5.1)
      accessTokenClaims: (token) => ageBandClaims(env as never, token),
      extraClaimsSupported: () => ageBandClaimsSupported(env as never),
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
      // Native passkey sign-in for the Studio and Admin apps: platform passkey API, then a
      // code for /token with PKCE (AUTH-PASSKEYS "Native apps", passkeys/native.ts)
      nativePasskey: nativePasskeyOptions(env as never, ctx, requestId),
      providers: {
        password: PasswordProvider({
          ...passwordUI,
          login: (req, form, error, render) => {
            if (error?.type === 'invalid_password') passwordGuard.invalidCredentials();
            return passwordUI.login(req, form, error, render);
          },
          // Every submitted email code is counted in D1: 5 tries, 15 minutes, single use
          checkCode: passwordGuard.checkCode,
          // A password reset signs the account out everywhere (#437)
          onPasswordChanged: async (email: string) => {
            await revokeOnPasswordChange(env.AUTH_DB, env.TOKEN_REVOCATIONS, email);
          },
        }),
        // Passkey sign-in (AUTH-PASSKEYS): started from the password page; every
        // lookup is by credential id. RP id = the issuer host without "auth."
        passkey: PasskeyProvider({
          rpID: (req) => rpId(env, req),
          origins: (req) => rpOrigins(env, req),
          store: {
            get: (id) => getCredential(env.AUTH_DB, id),
            touch: (id, counter) => touchCredential(env.AUTH_DB, id, counter),
          },
          onFailure: (reason) => logger.warn('[passkeys] Sign-in refused', { reason }),
        }),
      },
      // Per request: OpenAuth renders each page with this request's theme and ?lang=
      theme: openauthTheme,
      // Every refresh: a deleted or suspended user is refused; the issuer then
      // re-reads the roles from RBAC, so refreshed tokens carry current roles
      // and the staff passkey deadline follows the admin setting (AUTH-PASSKEYS)
      // A system account's refresh is refused, audited and flagged (security/system-accounts.ts)
      onRefresh: createRefreshCheck(
        userService,
        (userId, roles) => passkeyDeadline(env.AUTH_DB, userId, roles, env),
        (userId, clientId) => flagSystemAccountAttempt(env, ctx, { userId, attempt: 'token_refresh', detail: clientId, request, requestId }),
        // The native Admin apps need a staff role at every refresh (#363)
        {
          clientIds: ADMIN_NATIVE_CLIENT_IDS,
          currentRoles: async (tenantId, userId) => (await rbacService.getUserRoles(userId, tenantId)).map((r) => r.name),
        },
      ),
      // Suspended/deleted accounts (D1) are refused with an en/ar page (#662)
      onSuccess: createOnSuccessHandler(userService, rbacService, {
        request,
        env,
        ctx,
        requestId,
        db: env.AUTH_DB,
        homeUrl: signInFallbackUrl(env),
        theme: openauthTheme,
        timer,
        emailAvailable,
        onPasswordSignInFailure,
      }),
    });

    // Call issuer to handle the request
    // OpenAuth enterprise issuer manages sessions via D1SessionAdapter and sets the __session cookie
    const issued = await timer.stage('issuer', () => app.fetch(passwordGuard.request, env, ctx));
    if (pathname === '/token' && request.method === 'POST' && issued.status >= 400 && issued.status < 500) {
      const [bucket] = tokenBuckets;
      if (bucket) recordTokenRejection(routerContext, pathname, bucket.key, issued.status);
    }
    let issuerResponse = await timer.stage('guard.finish', () => passwordGuard.finish(issued));
    if (sendCodeRetryAfter !== undefined) {
      issuerResponse = new Response(issuerResponse.body, {
        status: 429,
        statusText: 'Too Many Requests',
        headers: issuerResponse.headers,
      });
      issuerResponse.headers.set('Retry-After', String(sendCodeRetryAfter));
    }
    // Theme and page names, header graphic, and the theme kept on in-flow links and redirects
    // and the shared site header on top (AlUmmahNow docs/design/NAV.md "Header")
    if (isPage) issuerResponse = await timer.stage('themed', () => finishThemedResponse(issuerResponse, theme, url, issuerOrigin, signInHeaderFor(url, getLocaleFromRequest(request), env)));
    // No email: the sign-in page leaves out "Create account" and "Forgot password?"
    if (isPage && !emailAvailable && (issuerResponse.headers.get('Content-Type') ?? '').includes('text/html')) {
      issuerResponse = withoutEmailLinks(issuerResponse);
    }
    // Turnstile on sign-up, reset and (after failures) sign-in pages (security/turnstile.ts)
    if (isPage && passwordGuard.widget && (issuerResponse.headers.get('Content-Type') ?? '').includes('text/html') && env.TURNSTILE_SITE_KEY) {
      const widget = passwordGuard.widget;
      const html = injectTurnstile(await issuerResponse.text(), {
        siteKey: env.TURNSTILE_SITE_KEY,
        scriptUrl: widgetScriptUrl(env),
        action: widget.action,
        lang: getLocaleFromRequest(request) === 'ar' ? 'ar' : 'en',
      });
      const headers = new Headers(issuerResponse.headers);
      headers.delete('Content-Length');
      issuerResponse = new Response(html, { status: issuerResponse.status, statusText: issuerResponse.statusText, headers });
    }

    // Accounts with no sign-in method yet (sign-in-link/): the sign-in page offers "Email me a
    // sign-in link" and "Add a password" once the email has no password; register with setup=1
    // is "Add a password"
    if (isPage && emailAvailable && (issuerResponse.headers.get('Content-Type') ?? '').includes('text/html')) {
      const lang = getLocaleFromRequest(request) === 'ar' ? 'ar' : 'en';
      if (signInPath && (issuerResponse.status === 200 || issuerResponse.status === 401)) {
        const email = typeof postedEmail === 'string' ? postedEmail.trim().toLowerCase() : '';
        // A failed sign-in POST for an email without a password: show the options at once (works without JS)
        const noPassword = issuerResponse.status === 401 && !!email && !(await hasPassword(storage, email));
        const csrf = signInCsrfFor(request);
        const html = addNoPasswordOptions(await issuerResponse.text(), { lang, csrf: csrf.token, back: url.pathname + url.search, noPassword, email: noPassword ? email : undefined });
        const headers = new Headers(issuerResponse.headers);
        headers.delete('Content-Length');
        if (csrf.cookie) headers.append('Set-Cookie', csrf.cookie);
        // The status stays the issuer's (401: this POST did not sign in), only the page changes
        issuerResponse = new Response(html, { status: issuerResponse.status, statusText: issuerResponse.statusText, headers });
      } else if (routedPath(url.pathname) === '/password/register' && url.searchParams.get('setup') === '1') {
        const html = addSetupHeading(await issuerResponse.text(), lang);
        const headers = new Headers(issuerResponse.headers);
        headers.delete('Content-Length');
        issuerResponse = new Response(html, { status: issuerResponse.status, statusText: issuerResponse.statusText, headers });
      }
    }

    // Picker "Sign out" of the last account: single sign-out (#219)
    if (request.method === 'POST' && url.pathname === ACCOUNT_PICKER_REMOVE_PATH) {
      issuerResponse = await afterAccountPickerRemove(request, env, issuerResponse);
    }

    // Status and type only: Location holds the authorization code, bodies hold user details (#313)
    const contentType = issuerResponse.headers.get('Content-Type') || '';
    if (contentType.includes('application/json') && url.pathname.includes('/password')) {
      logger.warn('Unexpected JSON from password flow', { status: issuerResponse.status, pathname: url.pathname });
    }

    // Handle session API responses - add CORS and enrich /session/accounts with user data
    if (url.pathname.startsWith('/session/')) {
      // Every /session/* response (GET /session/accounts, POST /session/switch,
      // DELETE /session/accounts/:userId, ...) gets credentialed CORS for our apps.
      const origin = request.headers.get('Origin');
      const isAllowed = isAllowedOrigin(origin, env);

      let finalResponse = issuerResponse;

      // Anonymous probe: every app asks GET /session/accounts on page load to
      // see whether this browser is signed in. "Not signed in" is a normal
      // answer, not an error: 200 with an empty list instead of the issuer's
      // 401, so signed-out visitors get no failed request in the console.
      // It says nothing a 401 did not (and nothing about other sessions);
      // switch/remove (POST/DELETE) still answer 401 without a session.
      if (request.method === 'GET' && url.pathname === '/session/accounts' && issuerResponse.status === 401) {
        // The issuer's headers, so any cookie it cleared (stale __session) is kept
        const headers = new Headers(issuerResponse.headers);
        headers.delete('Content-Length');
        headers.set('Content-Type', 'application/json');
        headers.set('Cache-Control', 'no-store');
        finalResponse = new Response(JSON.stringify({ accounts: [] }), { status: 200, headers });
      }

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
              .prepare(`SELECT id, email, name, metadata FROM users WHERE id IN (${placeholders})`)
              .bind(...userIds)
              .all();

            const usersMap = new Map<string, { email: string; name: string | null }>();
            for (const row of usersResult.results || []) {
              usersMap.set(row.id as string, {
                email: row.email as string,
                name: resolveUserDisplayName({ name: row.name as string | null, metadata: row.metadata }) || null,
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

      // To the admin Errors page; the page shows the reference to quote (AlUmmahNowAuth#341)
      const ref = reportAuthError(env, ctx, error, { route: url.pathname, method: request.method, requestId, request });
      const page = addSecurityHeaders(renderErrorPage(error, ref, request.url, request), isProduction);
      page.headers.set('X-Error-Ref', ref);
      return page;
    }
}
