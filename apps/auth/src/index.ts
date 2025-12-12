// DEBUG: Force reload trigger - 2025-12-03T12:15:00
import { createMultiTenantIssuer } from "@al-ummah-now/openauth";
import { RBACAdapter, RBACServiceImpl } from "@al-ummah-now/openauth/rbac/index";
import { CloudflarePatchedStorage } from "./storage/cloudflare-patched";
import { D1SessionAdapter } from "./adapters/session-adapter";
import { D1TenantAdapter } from "./adapters/tenant-adapter";

/**
 * Convert hex string to Uint8Array (32 bytes for session secret)
 */
function hexToSecret(hex: string): Uint8Array {
  if (hex.length !== 64) {
    throw new Error("Hex string must be exactly 64 characters (32 bytes)");
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
import { PasswordProvider } from "@al-ummah-now/openauth/provider/password";
import { PasswordUI } from "@al-ummah-now/openauth/ui/password";
import { createSubjects } from "@al-ummah-now/openauth/subject";
import { AuditService } from "@al-ummah-now/openauth/services/audit";
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
import { getEndpointRateLimit } from "./services/rate-limit-config";
import { AdminRBACRoutes } from "./admin-rbac-routes";
import { RBACRoutes } from "./rbac-routes";
import { AdminEnterpriseRoutes } from "./admin-enterprise-routes";
import { AdminUserRoutes } from "./admin-user-routes";
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
import { requireSecret } from "./utils/secrets";
import { trackEvent, trackRequestTiming as _trackRequestTiming } from "./utils/analytics";
import adminSessionRoutes from "./routes/admin-session-routes";
// Note: Session routes (/session/*) are now handled by OpenAuth enterprise issuer
// which provides: /session/accounts, /session/switch, /session/accounts/:userId, /session/all, /session/check
import { handleSelectAccountGet, handleSelectAccountPost } from "./routes/select-account";
import { AdminTenantRoutes } from "./admin-tenant-routes";
import { renderAccountSwitcher } from "./ui/account-switcher";
import { renderSessionList } from "./ui/session-list";
import { renderAdminSessionsDashboard } from "./ui/admin-sessions";
import { BrowserSessionService } from "./services/browser-session.service";
import { AccountSessionService } from "./services/account-session.service";
import { parseSessionCookie } from "./utils/session-cookie";

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
/**
 * Render a user-friendly error page for server errors
 *
 * @param error - The error that occurred
 * @param requestId - Request ID for support reference
 * @returns HTML response with error page
 */
function renderErrorPage(error: unknown, requestId: string, originalUrl?: string): Response {
  const isD1Error = error instanceof Error && (
    error.message.includes('D1_ERROR') ||
    error.message.includes('D1Database') ||
    error.message.includes('error code: 1031')
  );

  const title = isD1Error ? 'Service Temporarily Unavailable' : 'Something Went Wrong';
  const message = isD1Error
    ? 'We are experiencing database connectivity issues. Our team has been notified and is working to resolve this.'
    : 'An unexpected error occurred. Please try again in a few moments.';

  const timestamp = new Date().toISOString();
  const urlDisplay = originalUrl || 'Unknown';
  const reportSubject = encodeURIComponent(`Error Report: ${requestId}`);
  const reportBody = encodeURIComponent(`
Error Reference ID: ${requestId}
Timestamp: ${timestamp}
Error Type: ${isD1Error ? 'Database Connectivity' : 'Server Error'}
URL: ${urlDisplay}

Please describe what you were trying to do:
[Your description here]

---
Technical Details (for support team):
The error occurred while accessing the URL above.
`);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2d 0%, #16213e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: #e2e8f0;
    }
    .container {
      background: rgba(30, 41, 59, 0.9);
      border-radius: 16px;
      padding: 40px;
      max-width: 500px;
      width: 100%;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.1);
    }
    .icon {
      width: 80px;
      height: 80px;
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      font-size: 40px;
    }
    h1 {
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 16px;
      color: #f8fafc;
    }
    p {
      color: #94a3b8;
      font-size: 16px;
      line-height: 1.6;
      margin-bottom: 24px;
    }
    .actions {
      display: flex;
      gap: 12px;
      justify-content: center;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .btn {
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .btn-primary {
      background: #0891b2;
      color: white;
      border: none;
    }
    .btn-primary:hover {
      background: #0e7490;
    }
    .btn-secondary {
      background: transparent;
      color: #94a3b8;
      border: 1px solid #475569;
    }
    .btn-secondary:hover {
      background: rgba(255,255,255,0.05);
      color: #e2e8f0;
    }
    .btn-report {
      background: transparent;
      color: #f59e0b;
      border: 1px solid #f59e0b;
    }
    .btn-report:hover {
      background: rgba(245, 158, 11, 0.1);
    }
    .ref {
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid rgba(255,255,255,0.1);
    }
    .ref-id {
      font-size: 12px;
      color: #64748b;
      margin-bottom: 8px;
    }
    .ref-id code {
      background: rgba(0,0,0,0.3);
      padding: 4px 8px;
      border-radius: 4px;
      font-family: monospace;
      color: #94a3b8;
      user-select: all;
    }
    .copy-btn {
      background: none;
      border: none;
      color: #64748b;
      cursor: pointer;
      padding: 4px 8px;
      font-size: 12px;
      border-radius: 4px;
      margin-left: 8px;
    }
    .copy-btn:hover {
      background: rgba(255,255,255,0.1);
      color: #94a3b8;
    }
    .timestamp {
      font-size: 11px;
      color: #475569;
      margin-top: 8px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">${isD1Error ? '&#9888;' : '&#128679;'}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <div class="actions">
      ${originalUrl
        ? `<a href="${originalUrl.replace(/"/g, '&quot;')}" class="btn btn-primary">Try Again</a>`
        : `<button class="btn btn-primary" onclick="window.location.reload()">Try Again</button>`
      }
      <a href="/" class="btn btn-secondary">Go Home</a>
    </div>
    <a href="mailto:support@alummahnow.net?subject=${reportSubject}&body=${reportBody}" class="btn btn-report">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
        <polyline points="22,6 12,13 2,6"></polyline>
      </svg>
      Report this Issue
    </a>
    <div class="ref">
      <div class="ref-id">
        Reference ID: <code id="refId">${requestId}</code>
        <button class="copy-btn" onclick="copyRefId()">Copy</button>
      </div>
      <div class="timestamp">${timestamp}</div>
    </div>
  </div>
  <script>
    function copyRefId() {
      const refId = document.getElementById('refId').textContent;
      navigator.clipboard.writeText(refId).then(() => {
        const btn = document.querySelector('.copy-btn');
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy', 2000);
      });
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    status: isD1Error ? 503 : 500,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Retry-After': '30',
    },
  });
}

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
  // - style-src: Allow inline styles, Tailwind preflight, and Google Fonts CSS for OpenAuth UI
  // - img-src 'self' data: https: Allow images from same origin, data URIs, and HTTPS
  // - font-src 'self' https://fonts.gstatic.com: Allow fonts from same origin and Google Fonts
  // - connect-src 'self': Only make network requests to same origin
  // - frame-ancestors 'none': Prevent embedding (same as X-Frame-Options: DENY)
  headers.set(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; " +
    "img-src 'self' data: https:; " +
    "font-src 'self' https://fonts.gstatic.com; " +
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

    // Determine if running in production (test endpoints disabled in production)
    // Use ENVIRONMENT env var if set, otherwise fall back to hostname check
    const isProduction = env.ENVIRONMENT
      ? env.ENVIRONMENT === 'production'
      : (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1');

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

    // Wrap entire request handling in try-catch for graceful error handling
    try {
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
    const adminUserRoutes = new AdminUserRoutes(env.AUTH_DB, env.AUTH_STORAGE);

    // Handle admin RBAC routes
    if (url.pathname.startsWith('/admin/roles')) {
      const response = await adminRBACRoutes.handle(request, env, ctx);
      if (response.status !== 404) {
        return addSecurityHeaders(response, isProduction);
      }
    }

    // Handle admin user CRUD routes (separate from token management)
    // Token-related paths go to adminEnterpriseRoutes, user CRUD goes to adminUserRoutes
    const isTokenManagementPath = url.pathname === '/admin/users/tokens/revoke' ||
                                   url.pathname.match(/^\/admin\/users\/[^/]+\/tokens$/);
    if (url.pathname.startsWith('/admin/users') && !isTokenManagementPath) {
      const response = await adminUserRoutes.handle(request, env, ctx);
      if (response.status !== 404) {
        return addSecurityHeaders(response, isProduction);
      }
    }

    // Handle admin enterprise routes (audit logs, client management, token management, health)
    if (url.pathname === '/admin/audit' ||
        url.pathname.startsWith('/admin/audit-logs') ||
        url.pathname.startsWith('/admin/clients') ||
        isTokenManagementPath ||
        url.pathname === '/admin/health' ||
        url.pathname === '/admin/metrics') {
      const response = await adminEnterpriseRoutes.handle(request, env, ctx);
      if (response.status !== 404) {
        return addSecurityHeaders(response, isProduction);
      }
    }

    // Handle admin session management routes (API)
    // Let OpenAuth handle /admin/sessions/revoke and /admin/sessions/revoke-user
    // App handles: GET /admin/sessions, GET /admin/sessions/stats, GET /admin/sessions/suspicious,
    //              POST /admin/sessions/bulk-terminate, and /admin/users/*/sessions/* routes
    const isOpenAuthSessionRoute = url.pathname === '/admin/sessions/revoke' ||
                                    url.pathname === '/admin/sessions/revoke-user';
    if (!isOpenAuthSessionRoute &&
        (url.pathname.startsWith('/admin/sessions') || url.pathname.match(/^\/admin\/users\/[^/]+\/sessions/))) {
      const response = await adminSessionRoutes.fetch(request, env, ctx);
      if (response.status !== 404) {
        return addSecurityHeaders(response, isProduction);
      }
    }

    // Handle admin tenant management routes
    if (url.pathname.startsWith('/admin/tenants')) {
      const adminTenantRoutes = new AdminTenantRoutes(env.AUTH_DB);
      const response = await adminTenantRoutes.handle(request, env, ctx);
      if (response.status !== 404) {
        return addSecurityHeaders(response, isProduction);
      }
    }

    // Session management routes (API: /session/*) are handled by OpenAuth enterprise issuer
    // OpenAuth provides: /session/accounts, /session/switch, /session/accounts/:userId, /session/all, /session/check
    // We only need to handle CORS preflight here - actual requests go to OpenAuth
    if (url.pathname.startsWith('/session/') && request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin');
      const allowedOrigins = getAllowedOrigins(env, origin);
      const isAllowed = origin && matchOrigin(origin, [...allowedOrigins, ...(env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) || [])]);

      const headers: HeadersInit = {
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cookie',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
      };
      if (isAllowed && origin) {
        headers['Access-Control-Allow-Origin'] = origin;
      }
      return new Response(null, { status: 204, headers });
    }

    // Handle session UI pages
    if (url.pathname === '/settings/sessions') {
      // User's session management page
      // Use browser session (multi-account) instead of OpenAuth session
      const sessionToken = parseSessionCookie(request.headers.get('Cookie') || '');
      if (!sessionToken) {
        // Redirect to profile app to login
        return Response.redirect(env.PROFILE_APP_URL || `${url.origin}/`, 302);
      }

      const browserSessionService = new BrowserSessionService(env.AUTH_DB);
      const accountSessionService = new AccountSessionService(env.AUTH_DB);

      // Get browser session
      const browserSession = await browserSessionService.getBrowserSessionByToken(sessionToken);
      if (!browserSession) {
        return Response.redirect(env.PROFILE_APP_URL || `${url.origin}/`, 302);
      }

      // Get active account from browser session
      const activeAccount = await accountSessionService.getActiveAccount(browserSession.id);
      if (!activeAccount) {
        return Response.redirect(env.PROFILE_APP_URL || `${url.origin}/`, 302);
      }

      // Get user's sessions across devices
      const userSessions = await accountSessionService.getUserSessions(activeAccount.userId);

      // Transform to UI format (DeviceSession interface)
      const sessions = await Promise.all(userSessions.map(async (s) => {
        const browser = await browserSessionService.getBrowserSessionById(s.browserSessionId);
        return {
          id: s.id,
          browserSessionId: s.browserSessionId,
          deviceType: (browser?.deviceType || 'unknown') as 'desktop' | 'mobile' | 'tablet' | 'unknown',
          deviceName: browser?.deviceName || 'Unknown Device',
          ipAddress: browser?.ipAddress || null,
          lastActivity: s.lastUsed,
          createdAt: s.authenticatedAt,
          isCurrentSession: s.browserSessionId === browserSession.id,
        };
      }));

      const html = renderSessionList({
        sessions,
        actionBaseUrl: '/session/devices',
        showRevokeAll: true,
      });

      return addSecurityHeaders(new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }), isProduction);
    }

    // Handle account switcher component (for embedding)
    if (url.pathname === '/ui/account-switcher') {
      // Use browser session (multi-account) instead of OpenAuth session
      const sessionToken = parseSessionCookie(request.headers.get('Cookie') || '');
      if (!sessionToken) {
        return addSecurityHeaders(new Response('', { status: 204 }), isProduction);
      }

      const browserSessionService = new BrowserSessionService(env.AUTH_DB);
      // First get the session by token to get the ID
      const session = await browserSessionService.getBrowserSessionByToken(sessionToken);
      if (!session) {
        return addSecurityHeaders(new Response('', { status: 204 }), isProduction);
      }

      // Then get the session with accounts using the ID
      const browserSession = await browserSessionService.getBrowserSessionWithAccounts(session.id);

      if (!browserSession) {
        return addSecurityHeaders(new Response('', { status: 204 }), isProduction);
      }

      // Transform to AccountSwitcherAccount interface
      const accounts = browserSession.accounts.map(a => ({
        userId: a.userId,
        email: a.user.email,
        name: a.user.name,
        avatarUrl: a.user.avatarUrl,
        lastUsed: a.lastUsed,
        isActive: a.isActive,
      }));

      const html = renderAccountSwitcher({
        accounts,
        actionBaseUrl: '/session',
        showAccountCount: true,
      });

      return addSecurityHeaders(new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }), isProduction);
    }

    // Handle admin sessions dashboard UI
    if (url.pathname === '/admin/sessions/dashboard') {
      // Verify admin access
      const session = await getUserSession(request, env.AUTH_STORAGE);
      if (!session?.user) {
        return Response.redirect(`${url.origin}/`, 302);
      }

      // TODO: Check admin role properly
      // For now, render the dashboard with empty data (API endpoint populates real data)
      const html = renderAdminSessionsDashboard({
        stats: {
          totalSessions: 0,
          activeSessions: 0,
          loginsLast24h: 0,
          deviceBreakdown: { desktop: 0, mobile: 0, tablet: 0, unknown: 0 },
        },
        suspicious: { multipleIPsInShortTime: [], failedThenSuccessfulLogins: [] },
        sessions: [],
        filters: {},
        userBaseUrl: '/admin/users',
        actionBaseUrl: '/admin/sessions',
      });

      return addSecurityHeaders(new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }), isProduction);
    }

    // Handle account selection page (OIDC flow)
    if (url.pathname === '/select-account') {
      // Get browser session for multi-account support
      const sessionToken = parseSessionCookie(request.headers.get('Cookie') || '');
      let browserSession = null;

      if (sessionToken) {
        const browserSessionService = new BrowserSessionService(env.AUTH_DB);
        browserSession = await browserSessionService.getBrowserSessionByToken(sessionToken);
      }

      if (request.method === 'GET') {
        const response = await handleSelectAccountGet(request, env, browserSession);
        return addSecurityHeaders(response, isProduction);
      } else if (request.method === 'POST') {
        const response = await handleSelectAccountPost(request, env, browserSession);
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

        // Track logout in analytics
        trackEvent(env, {
          event: 'logout',
          userId,
          ipAddress: clientIP,
          userAgent: request.headers.get('User-Agent') ?? undefined,
          success: true,
        });
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

        // Assign admin role via RBAC (using OpenAuth's rbac_user_roles directly for upsert)
        await env.AUTH_DB.prepare(
          `INSERT INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by)
           VALUES (?, 'role_admin_default', 'default', ?, 'system')
           ON CONFLICT(user_id, role_id, tenant_id) DO UPDATE SET assigned_by = 'system'`
        ).bind(user.id, Date.now()).run();

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

    // Handle direct auth access without OAuth callback - redirect to profile's OAuth flow
    // This handles the case where user goes directly to auth server instead of through a client app
    // Only intercept /authorize when missing required params - enterprise issuer handles prompt=select_account etc.
    if (url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const clientId = url.searchParams.get('client_id');

      // If no redirect_uri or client_id, redirect through profile app's OAuth flow
      if (!redirectUri || !clientId) {
        logger.debug('Direct auth access without OAuth params, redirecting to profile OAuth flow');

        const profileUrl = env.PROFILE_APP_URL || 'http://localhost:3302';
        const profileCallback = `${profileUrl}/callback`;
        const profileClientId = env.PROFILE_CLIENT_ID || '109a1087-6626-40f7-8a7f-7f42f83f4f30';
        const oauthUrl = `${url.origin}/authorize?response_type=code&client_id=${profileClientId}&redirect_uri=${encodeURIComponent(profileCallback)}`;

        ctx.waitUntil(logger.finalizeRequest());
        return Response.redirect(oauthUrl, 302);
      }
      // Enterprise issuer handles prompt=select_account, prompt=login, etc. natively
    }

    // Rate limiting for token endpoints
    // Token endpoints are more sensitive and require stricter rate limits
    if (url.pathname === '/token' ||
        url.pathname === '/token/introspect' ||
        url.pathname === '/token/revoke') {

      const clientIP = getClientIP(request);
      const rateLimitKey = `token:${url.pathname}:${clientIP}`;

      // Token endpoints: 10 requests per minute (stricter than general auth endpoints)
      // This helps prevent:
      // - Brute force token generation attempts
      // - Token introspection enumeration attacks
      // - DoS on token endpoints
      const rateLimit = await checkRateLimit(
        env.AUTH_STORAGE,
        rateLimitKey,
        10,  // 10 requests per window
        60   // 60 seconds (1 minute)
      );

      if (!rateLimit.allowed) {
        const retryAfter = rateLimit.resetAt - Math.floor(Date.now() / 1000);
        logger.warn('Rate limit exceeded for token endpoint', {
          clientIP,
          endpoint: url.pathname,
          retryAfter,
        });

        // Emit rate limit exceeded audit event
        const auditEvent = createRateLimitExceededEvent(
          url.pathname,
          10,
          60,
          retryAfter,
          {
            ipAddress: clientIP,
            userAgent: request.headers.get('User-Agent') ?? undefined,
            requestId,
          }
        );
        ctx.waitUntil(getAuditEmitter().emit(auditEvent));

        // Track rate limit in analytics
        trackEvent(env, {
          event: 'rate_limit_hit',
          ipAddress: clientIP,
          userAgent: request.headers.get('User-Agent') ?? undefined,
        });

        ctx.waitUntil(logger.finalizeRequest());
        const response = new Response(
          JSON.stringify({
            error: 'rate_limit_exceeded',
            error_description: `Too many requests. Please try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': String(retryAfter),
              'X-RateLimit-Limit': '10',
              'X-RateLimit-Remaining': String(rateLimit.remaining),
              'X-RateLimit-Reset': String(rateLimit.resetAt),
            },
          }
        );
        return addSecurityHeaders(response, isProduction);
      }

      logger.debug('Rate limit check passed for token endpoint', {
        clientIP,
        endpoint: url.pathname,
        remaining: rateLimit.remaining,
      });
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

    // Create storage and services for enterprise issuer
    const storage = CloudflarePatchedStorage({ namespace: env.AUTH_STORAGE });
    const sessionService = new D1SessionAdapter(env.AUTH_DB);
    const tenantService = new D1TenantAdapter(env.AUTH_DB);
    const sessionSecret = hexToSecret(env.SESSION_SECRET || '0'.repeat(64));

    // Create RBAC service for JWT token enrichment
    const rbacAdapter = new RBACAdapter(env.AUTH_DB);
    const rbacService = new RBACServiceImpl(rbacAdapter, storage);

    // Create enterprise issuer with multi-account session support
    const { app } = createMultiTenantIssuer({
      storage,
      sessionService,
      tenantService,
      sessionSecret,
      subjects,
      rbacService,
      clientDb: env.AUTH_DB,
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
            sendCode: async (email, code) => {
              // https://resend.com/docs/send-with-cloudflare-workers
              logger.info('Sending login code', { email, codeLength: code.length });

              // Rate limiting: configurable via KV, with environment-specific defaults
              const clientIP = getClientIP(request);
              const rateLimitKey = `login:${clientIP}`;
              const rateLimitConfig = await getEndpointRateLimit(env.AUTH_STORAGE, 'login', env.ENVIRONMENT);

              // Allow higher limits for localhost development
              const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
              const limit = isLocalhost ? 100 : rateLimitConfig.limit;

              const rateLimit = await checkRateLimit(
                env.AUTH_STORAGE,
                rateLimitKey,
                limit,
                rateLimitConfig.windowSeconds
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

                // Track rate limit in analytics
                trackEvent(env, {
                  event: 'rate_limit_hit',
                  email,
                  ipAddress: clientIP,
                  userAgent: request.headers.get('User-Agent') ?? undefined,
                });

                throw new Error(`Too many login attempts. Please try again in ${Math.ceil(retryAfter / 60)} minutes.`);
              }

              logger.debug('Rate limit check passed', {
                clientIP,
                email,
                remaining: rateLimit.remaining,
              });

              // Track login attempt in analytics
              trackEvent(env, {
                event: 'login_attempt',
                email,
                ipAddress: clientIP,
                userAgent: request.headers.get('User-Agent') ?? undefined,
              });

              try {
                const apiKey = await requireSecret(env.RESEND_API_KEY, 'RESEND_API_KEY', env as unknown as Record<string, unknown>);

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
        background: {
          light: "#444444",
          dark: "#1a1a2d",
        },
        favicon: "https://al-ummah-now-images.b-cdn.net/favicon_io/favicon.ico",
        logo: {
          dark: "https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png",
          light:
            "https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png",
        },
      },
      onSuccess: async (authCtx, value, _tenant) => {
        // Enterprise issuer: password provider gives email in claims
        const email = String(value.email || '');
        logger.info('Authentication successful', { email, provider: value.provider });

        // DEBUG: Log the full value object and tenant
        logger.info('[DEBUG] onSuccess called', {
          valueKeys: Object.keys(value),
          value: JSON.stringify(value).slice(0, 500),
          tenant: _tenant?.id,
          hasAuthCtx: !!authCtx,
          hasSubjectMethod: typeof authCtx?.subject === 'function',
        });

        try {
          const user = await getOrCreateUser(env, email, true);
          const isNewUser = user.isNew; // Track if this is a new account

          // Debug: Log the roles being returned
          logger.info('User roles from RBAC', {
            userId: user.id,
            email,
            roles: user.roles,
            rolesCount: user.roles.length
          });

          // Emit login success audit event (use outer ctx for waitUntil)
          const clientIP = getClientIP(request);
          const loginEvent = createLoginSuccessEvent(
            email,
            user.id,
            {
              ipAddress: clientIP,
              userAgent: request.headers.get('User-Agent') ?? undefined,
              requestId,
            }
          );
          ctx.waitUntil(getAuditEmitter().emit(loginEvent));

          // Track login success in analytics
          trackEvent(env, {
            event: 'login_success',
            userId: user.id,
            email,
            ipAddress: clientIP,
            userAgent: request.headers.get('User-Agent') ?? undefined,
            success: true,
          });

          // If new user, emit account created event
          // Note: In rare race conditions with concurrent logins for the same new user,
          // duplicate ACCOUNT_CREATED events may be emitted. This is acceptable as the
          // events will have different requestIds for correlation.
          if (isNewUser) {
            const accountEvent = createAccountCreatedEvent(
              user.id,
              email,
              user.roles.join(','),
              {
                ipAddress: clientIP,
                userAgent: request.headers.get('User-Agent') ?? undefined,
                requestId,
              }
            );
            ctx.waitUntil(getAuditEmitter().emit(accountEvent));

            // Track new registration in analytics
            trackEvent(env, {
              event: 'register',
              userId: user.id,
              email,
              ipAddress: clientIP,
              userAgent: request.headers.get('User-Agent') ?? undefined,
              success: true,
            });
          }

          // DEBUG: Log before calling subject
          // Note: userID is required by OpenAuth enterprise issuer for RBAC enrichment
          logger.info('[DEBUG] Calling authCtx.subject', {
            type: 'user',
            properties: { id: user.id, email, roles: user.roles },
          });

          const subjectResponse = await authCtx.subject("user", {
            id: user.id,
            email,
            roles: user.roles,
          });

          // DEBUG: Log the response from subject
          logger.info('[DEBUG] authCtx.subject returned', {
            responseType: typeof subjectResponse,
            isResponse: subjectResponse instanceof Response,
            status: subjectResponse instanceof Response ? subjectResponse.status : 'N/A',
            headers: subjectResponse instanceof Response
              ? Object.fromEntries(subjectResponse.headers.entries())
              : 'N/A',
          });

          // DEBUG: If not a Response, log what it actually is and return error
          if (!(subjectResponse instanceof Response)) {
            const unknownResponse = subjectResponse as unknown;
            logger.error('[DEBUG] subjectResponse is NOT a Response!', {
              actualValue: JSON.stringify(unknownResponse).slice(0, 500),
              constructorName: (unknownResponse as { constructor?: { name?: string } })?.constructor?.name,
            });
            // Return a clear error so we can see what's happening
            return new Response(JSON.stringify({
              error: 'subject_not_response',
              debug: {
                type: typeof unknownResponse,
                value: unknownResponse,
              }
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            });
          }

          // DEBUG: Check if it's a redirect or has unexpected content
          const isRedirect = subjectResponse.status >= 300 && subjectResponse.status < 400;
          if (!isRedirect) {
            const cloned = subjectResponse.clone();
            const body = await cloned.text();
            logger.error('[DEBUG] subjectResponse is NOT a redirect!', {
              status: subjectResponse.status,
              contentType: subjectResponse.headers.get('Content-Type'),
              body: body.slice(0, 1000),
            });
          }

          return subjectResponse;
        } catch (error) {
          // Emit login failed audit event (use outer ctx for waitUntil)
          const clientIP = getClientIP(request);
          const failedEvent = createLoginFailedEvent(
            email,
            error instanceof Error ? error.message : String(error),
            {
              ipAddress: clientIP,
              userAgent: request.headers.get('User-Agent') ?? undefined,
              requestId,
            }
          );
          ctx.waitUntil(getAuditEmitter().emit(failedEvent));

          // Track login failed in analytics
          trackEvent(env, {
            event: 'login_failed',
            email,
            ipAddress: clientIP,
            userAgent: request.headers.get('User-Agent') ?? undefined,
            errorCode: error instanceof Error ? error.message : 'unknown',
            success: false,
          });

          throw error;
        }
      },
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
              .prepare(`SELECT id, email, name, avatar_url FROM user WHERE id IN (${placeholders})`)
              .bind(...userIds)
              .all();

            const usersMap = new Map<string, { email: string; name: string | null; avatarUrl: string | null }>();
            for (const row of usersResult.results || []) {
              usersMap.set(row.id as string, {
                email: row.email as string,
                name: row.name as string | null,
                avatarUrl: row.avatar_url as string | null,
              });
            }

            // Enrich accounts with user data
            const enrichedAccounts = data.accounts.map(account => {
              const user = usersMap.get(account.userId);
              return {
                ...account,
                email: user?.email || '',
                name: user?.name || null,
                avatarUrl: user?.avatarUrl || null,
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


