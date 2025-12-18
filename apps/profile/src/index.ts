import { createClient } from "@al-ummah-now/openauth/client";
import { createSubjects } from "@al-ummah-now/openauth/subject";
import * as v from "valibot";

// Define subjects matching the auth server
const subjects = createSubjects({
  user: v.object({
    id: v.string(),
    email: v.pipe(v.string(), v.email()),
    roles: v.array(v.string()),
  }),
});

interface Env {
  AUTH_STORAGE: KVNamespace;
  AUTH_SERVER_URL?: string;
  APP_URL?: string;
  ADMIN_URL?: string;
  CF_WEB_ANALYTICS_TOKEN?: string;
}

// Session management helpers
async function getSession(request: Request, storage: KVNamespace) {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;

  const cookies = Object.fromEntries(
    cookieHeader.split("; ").map(c => {
      const [key, ...v] = c.split("=");
      return [key, v.join("=")];
    })
  );

  const sessionToken = cookies["profile_session"];
  if (!sessionToken) return null;

  try {
    const sessionData = await storage.get(`session:${sessionToken}`);
    if (!sessionData) return null;

    // Parse session data with error handling
    let session: {
      expiresAt?: string;
      user?: { id: string; email: string; roles: string[] };
      tokens?: { access: string; refresh: string };
    };
    try {
      session = JSON.parse(sessionData);
    } catch (parseError) {
      console.error("Failed to parse session data, deleting corrupted session:", parseError);
      await storage.delete(`session:${sessionToken}`);
      return null;
    }

    // Check if session is expired
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
      await storage.delete(`session:${sessionToken}`);
      return null;
    }

    return session;
  } catch (error) {
    console.error("Error retrieving session:", error);
    return null;
  }
}

async function createSession(storage: KVNamespace, sessionData: {
  user: { id: string; email: string; roles: string[] };
  tokens: { access: string; refresh: string };
  expiresAt: string;
}) {
  const sessionToken = crypto.randomUUID();

  await storage.put(
    `session:${sessionToken}`,
    JSON.stringify(sessionData),
    { expirationTtl: 7 * 24 * 60 * 60 } // 7 days
  );

  return sessionToken;
}

function createSessionCookie(sessionToken: string, isLocalhost: boolean) {
  const secure = isLocalhost ? "" : "Secure; ";
  return `profile_session=${sessionToken}; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`;
}

function clearSessionCookie(isLocalhost: boolean) {
  const secure = isLocalhost ? "" : "Secure; ";
  return `profile_session=; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=0`;
}

// Get OpenAuth client
function getAuthClient(authServerUrl: string) {
  return createClient({
    clientID: "109a1087-6626-40f7-8a7f-7f42f83f4f30",
    issuer: authServerUrl,
  });
}

// Get auth server URL
function getAuthServerUrl(request: Request, env: Env): string {
  // Use environment variable (configured in wrangler.json or .dev.vars)
  if (env.AUTH_SERVER_URL) {
    return env.AUTH_SERVER_URL;
  }

  // Fallback: not recommended for production
  console.warn('AUTH_SERVER_URL not configured, using fallback');
  return 'https://auth.alummahnow.net';
}

// Get the current app URL (for OAuth redirect_uri)
function getAppUrl(request: Request, env: Env): string {
  // Use environment variable (configured in wrangler.json or .dev.vars)
  if (env.APP_URL) {
    return env.APP_URL;
  }

  // Fallback: derive from request (not recommended for production)
  const url = new URL(request.url);
  console.warn('APP_URL not configured, using request origin:', url.origin);
  return url.origin;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const authServerUrl = getAuthServerUrl(request, env);

    // Handle logout
    if (url.pathname === '/logout') {
      const session = await getSession(request, env.AUTH_STORAGE);
      if (session) {
        const sessionToken = request.headers.get("Cookie")?.match(/profile_session=([^;]+)/)?.[1];
        if (sessionToken) {
          await env.AUTH_STORAGE.delete(`session:${sessionToken}`);
        }
      }

      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/",
          "Set-Cookie": clearSessionCookie(isLocalhost),
        },
      });
    }

    // Handle token revocation (E2E testing endpoint)
    // Gets refresh token from session and calls auth server's revoke endpoint
    if (url.pathname === '/revoke' && request.method === 'POST') {
      const session = await getSession(request, env.AUTH_STORAGE);

      if (!session || !session.tokens?.refresh) {
        return new Response(JSON.stringify({ error: 'No session or refresh token found' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      try {
        // Call auth server's revoke endpoint
        const revokeResponse = await fetch(`${authServerUrl}/token/revoke`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            token: session.tokens.refresh,
            token_type_hint: 'refresh_token',
            client_id: '109a1087-6626-40f7-8a7f-7f42f83f4f30',
          }),
        });

        // Clear the local session after revocation
        const sessionToken = request.headers.get("Cookie")?.match(/profile_session=([^;]+)/)?.[1];
        if (sessionToken) {
          await env.AUTH_STORAGE.delete(`session:${sessionToken}`);
        }

        return new Response(JSON.stringify({
          success: true,
          revoked: true,
          authServerStatus: revokeResponse.status
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': clearSessionCookie(isLocalhost),
          },
        });
      } catch (error) {
        console.error('Token revocation error:', error);
        return new Response(JSON.stringify({ error: 'Failed to revoke token' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // API endpoint to get user info from session (roles come from JWT)
    if (url.pathname === '/api/me') {
      const session = await getSession(request, env.AUTH_STORAGE);

      if (!session || !session.user?.id) {
        return new Response(JSON.stringify({ error: 'Not authenticated' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Return user info from session (roles are from JWT, refreshed on token refresh)
      return new Response(JSON.stringify({
        id: session.user.id,
        email: session.user.email,
        roles: session.user.roles || [],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Handle OAuth callback
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        // Handle login_required from prompt=none - retry with normal auth flow
        if (error === 'login_required') {
          const appUrl = getAppUrl(request, env);
          const redirectUri = encodeURIComponent(`${appUrl}/callback`);
          return Response.redirect(`${authServerUrl}/authorize?response_type=code&client_id=109a1087-6626-40f7-8a7f-7f42f83f4f30&redirect_uri=${redirectUri}`, 302);
        }
        return Response.redirect(`${url.origin}/?error=${encodeURIComponent(error)}`, 302);
      }

      if (!code) {
        return Response.redirect(`${url.origin}/?error=missing_code`, 302);
      }

      try {
        // Exchange code for tokens
        const client = getAuthClient(authServerUrl);
        const appUrl = getAppUrl(request, env);
        const redirectUri = `${appUrl}/callback`;

        console.info('Exchanging code for tokens', { authServerUrl, appUrl, redirectUri });
        const result = await client.exchange(code, redirectUri);

        if (result.err !== false) {
          throw new Error(`Token exchange failed: ${result.err}`);
        }

        // Verify the token and get user info
        const verified = await client.verify(subjects, result.tokens.access, {
          refresh: result.tokens.refresh,
        });

        if ('err' in verified) {
          throw new Error(`Token verification failed: ${verified.err}`);
        }

        if (!verified.subject) {
          throw new Error("Failed to verify token - no subject returned");
        }

        const userInfo = verified.subject;

        // Create session
        const sessionData = {
          user: {
            id: userInfo.properties.id,
            email: userInfo.properties.email,
            roles: userInfo.properties.roles,
          },
          tokens: {
            access: result.tokens.access,
            refresh: result.tokens.refresh,
          },
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        };

        const sessionToken = await createSession(env.AUTH_STORAGE, sessionData);

        // Redirect to homepage with session cookie
        return new Response(null, {
          status: 302,
          headers: {
            "Location": "/",
            "Set-Cookie": createSessionCookie(sessionToken, isLocalhost),
          },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('OAuth callback error:', errorMessage);
        return Response.redirect(`${url.origin}/?error=${encodeURIComponent(errorMessage)}`, 302);
      }
    }

    // Serve homepage
    if (url.pathname === '/' || url.pathname === '') {
      const session = await getSession(request, env.AUTH_STORAGE);
      const isLoggedIn = session !== null;
      const userData = session ? JSON.stringify(session.user) : 'null';
      const appUrl = getAppUrl(request, env);
      const adminUrl = env.ADMIN_URL || '';

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Al Ummah Now - User Profile</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
            color: #f8fafc;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
        }

        .navbar {
            background: linear-gradient(135deg, #093041 0%, #0f4d66 100%);
            padding: 1rem 2rem;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
            border-bottom: 1px solid rgba(15, 77, 102, 0.2);
        }

        .navbar-content {
            max-width: 1200px;
            margin: 0 auto;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .logo {
            display: flex;
            align-items: center;
            gap: 12px;
            font-size: 1.5rem;
            font-weight: 700;
            color: white;
        }

        .logo img {
            width: 40px;
            height: 40px;
            border-radius: 8px;
        }

        .nav-menu {
            display: flex;
            gap: 1rem;
            align-items: center;
        }

        /* Account Switcher Dropdown */
        .account-switcher {
            position: relative;
            display: inline-block;
        }

        .account-trigger {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 6px 12px;
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 9999px;
            cursor: pointer;
            transition: all 0.2s ease;
            color: #e2e8f0;
            font-size: 14px;
        }

        .account-trigger:hover {
            background: rgba(255, 255, 255, 0.2);
            border-color: rgba(255, 255, 255, 0.3);
        }

        .account-trigger .avatar {
            width: 28px;
            height: 28px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: 600;
            font-size: 12px;
            flex-shrink: 0;
        }

        .account-trigger .chevron {
            transition: transform 0.2s ease;
        }

        .account-trigger .chevron.open {
            transform: rotate(180deg);
        }

        .account-dropdown {
            position: absolute;
            top: calc(100% + 8px);
            right: 0;
            min-width: 280px;
            background: #1e293b;
            border: 1px solid rgba(148, 163, 184, 0.2);
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
            z-index: 1000;
            overflow: hidden;
        }

        .dropdown-header {
            padding: 12px 16px;
            border-bottom: 1px solid rgba(148, 163, 184, 0.2);
            font-size: 12px;
            color: #94a3b8;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        .accounts-list {
            padding: 8px;
        }

        .account-item {
            display: flex;
            align-items: center;
            padding: 10px 12px;
            border-radius: 8px;
            cursor: pointer;
            transition: background 0.2s ease;
        }

        .account-item:hover {
            background: rgba(255, 255, 255, 0.1);
        }

        .account-item.active {
            background: rgba(14, 165, 233, 0.15);
        }

        .account-item .avatar {
            width: 36px;
            height: 36px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: 600;
            font-size: 14px;
            margin-right: 12px;
            flex-shrink: 0;
        }

        .account-item .account-details {
            flex: 1;
            min-width: 0;
        }

        .account-item .email {
            display: block;
            font-size: 14px;
            color: #f8fafc;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .account-item .status {
            display: block;
            font-size: 12px;
            color: #94a3b8;
        }

        .account-item .active-check {
            color: #10b981;
            margin-left: 8px;
        }

        .account-item .sign-out-btn {
            padding: 6px;
            background: none;
            border: none;
            color: #94a3b8;
            cursor: pointer;
            border-radius: 4px;
            margin-left: 8px;
            opacity: 0;
            transition: all 0.2s ease;
        }

        .account-item:hover .sign-out-btn {
            opacity: 1;
        }

        .account-item .sign-out-btn:hover {
            background: rgba(239, 68, 68, 0.2);
            color: #ef4444;
        }

        .dropdown-divider {
            height: 1px;
            background: rgba(148, 163, 184, 0.2);
            margin: 8px 0;
        }

        .dropdown-action {
            display: flex;
            align-items: center;
            gap: 10px;
            width: 100%;
            padding: 12px 16px;
            background: none;
            border: none;
            color: #94a3b8;
            cursor: pointer;
            font-size: 14px;
            text-align: left;
            transition: all 0.2s ease;
        }

        .dropdown-action:hover {
            background: rgba(255, 255, 255, 0.1);
            color: #f8fafc;
        }

        .dropdown-action.danger:hover {
            background: rgba(239, 68, 68, 0.15);
            color: #ef4444;
        }

        .btn {
            padding: 10px 20px;
            border-radius: 8px;
            text-decoration: none;
            font-weight: 600;
            transition: all 0.3s ease;
            cursor: pointer;
            border: none;
            font-size: 14px;
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }

        .btn-primary {
            background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%);
            color: white;
            box-shadow: 0 2px 8px rgba(14, 165, 233, 0.3);
        }

        .btn-primary:hover {
            background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%);
            transform: translateY(-2px);
            box-shadow: 0 4px 16px rgba(14, 165, 233, 0.4);
        }

        .btn-secondary {
            background: rgba(255, 255, 255, 0.1);
            color: #e2e8f0;
            border: 1px solid rgba(255, 255, 255, 0.2);
        }

        .btn-secondary:hover {
            background: rgba(255, 255, 255, 0.2);
            color: white;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 3rem 2rem;
            flex: 1;
        }

        .hero {
            text-align: center;
            margin-bottom: 3rem;
        }

        .hero h1 {
            font-size: 3rem;
            font-weight: 800;
            margin-bottom: 1rem;
            background: linear-gradient(135deg, #0ea5e9 0%, #06b6d4 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .hero p {
            font-size: 1.25rem;
            color: #cbd5e1;
            max-width: 600px;
            margin: 0 auto;
            line-height: 1.6;
        }

        .profile-card {
            background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
            padding: 2rem;
            border-radius: 12px;
            border: 1px solid rgba(148, 163, 184, 0.2);
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
            max-width: 600px;
            margin: 0 auto;
        }

        .profile-card h2 {
            color: #0ea5e9;
            margin-bottom: 1.5rem;
            font-size: 1.75rem;
        }

        .profile-field {
            margin-bottom: 1rem;
            padding: 1rem;
            background: rgba(15, 23, 42, 0.6);
            border-radius: 8px;
        }

        .profile-field label {
            display: block;
            color: #94a3b8;
            font-size: 0.875rem;
            margin-bottom: 0.5rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        .profile-field .value {
            color: #f8fafc;
            font-size: 1.125rem;
            font-weight: 500;
        }

        .badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 6px;
            font-size: 0.875rem;
            font-weight: 600;
        }

        .badge-admin {
            background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%);
            color: white;
        }

        .badge-user {
            background: linear-gradient(135deg, #059669 0%, #047857 100%);
            color: white;
        }

        .welcome-message {
            background: linear-gradient(135deg, rgba(5, 150, 105, 0.15) 0%, rgba(16, 185, 129, 0.08) 100%);
            border: 1px solid #059669;
            padding: 1.5rem;
            border-radius: 12px;
            margin-bottom: 2rem;
            text-align: center;
        }

        .welcome-message h3 {
            color: #10b981;
            margin-bottom: 0.5rem;
            font-size: 1.5rem;
        }

        .error-message {
            background: rgba(220, 38, 38, 0.1);
            border: 1px solid #dc2626;
            padding: 1rem;
            border-radius: 8px;
            margin-bottom: 1rem;
            color: #fca5a5;
        }

        .footer {
            background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
            padding: 2rem;
            border-top: 1px solid rgba(148, 163, 184, 0.2);
            text-align: center;
            color: #94a3b8;
        }

        @media (max-width: 768px) {
            .navbar-content {
                flex-direction: column;
                gap: 1rem;
            }

            .hero h1 {
                font-size: 2rem;
            }
        }
    </style>
</head>
<body>
    <nav class="navbar">
        <div class="navbar-content">
            <div class="logo">
                <img src="https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png" alt="Al Ummah Now">
                <span>Al Ummah Now Profile</span>
            </div>
            <div class="nav-menu" id="navMenu">
                <!-- Dynamic content based on login state -->
            </div>
            <!-- Account Switcher (shown when logged in with multiple accounts) -->
            <div class="account-switcher" id="accountSwitcher" style="display: none;">
                <button class="account-trigger" id="accountTrigger" onclick="toggleAccountDropdown()">
                    <div class="avatar" id="activeAvatar" style="background-color: #1976d2;">?</div>
                    <span id="activeEmail">Loading...</span>
                    <svg class="chevron" id="chevronIcon" width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </button>
                <div class="account-dropdown" id="accountDropdown" style="display: none;">
                    <div class="dropdown-header">Signed in accounts</div>
                    <div class="accounts-list" id="accountsList">
                        <!-- Accounts populated by JS -->
                    </div>
                    <div class="dropdown-divider"></div>
                    <button class="dropdown-action" id="addAccountBtn" onclick="handleAddAccount()">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z"/>
                        </svg>
                        Add another account
                    </button>
                    <button class="dropdown-action" onclick="handleManageSessions()">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M1.5 3A1.5 1.5 0 013 1.5h10A1.5 1.5 0 0114.5 3v10a1.5 1.5 0 01-1.5 1.5H3A1.5 1.5 0 011.5 13V3zM3 2.5a.5.5 0 00-.5.5v10a.5.5 0 00.5.5h10a.5.5 0 00.5-.5V3a.5.5 0 00-.5-.5H3z"/>
                        </svg>
                        Manage sessions
                    </button>
                    <button class="dropdown-action danger" onclick="handleSignOutAll()">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M2 2.75A.75.75 0 012.75 2h10.5a.75.75 0 010 1.5H2.75A.75.75 0 012 2.75zm0 10.5a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75zM2.75 7a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z"/>
                        </svg>
                        Sign out of all accounts
                    </button>
                </div>
            </div>
        </div>
    </nav>

    <div class="container">
        <div id="errorContainer"></div>

        <div id="loggedOutView" style="display: none;">
            <div class="hero">
                <h1>Welcome to Your Profile</h1>
                <p>Sign in to view and manage your Al Ummah Now profile, preferences, and account settings.</p>
            </div>
            <div style="text-align: center;">
                <button onclick="handleLogin()" class="btn btn-primary" style="font-size: 1.1rem; padding: 1rem 2rem;">
                    🔐 Sign In
                </button>
            </div>
        </div>

        <div id="loggedInView" style="display: none;">
            <div class="welcome-message">
                <h3>Welcome back!</h3>
                <p>You are successfully logged in to your Al Ummah Now profile.</p>
            </div>

            <div class="profile-card">
                <h2>👤 Your Profile</h2>

                <div class="profile-field">
                    <label>User ID</label>
                    <div class="value" id="userId">-</div>
                </div>

                <div class="profile-field">
                    <label>Email Address</label>
                    <div class="value" id="userEmail">-</div>
                </div>

                <div class="profile-field">
                    <label>Role</label>
                    <div class="value" id="userRole">-</div>
                </div>

                <div style="margin-top: 2rem; text-align: center;">
                    <button onclick="handleLogout()" class="btn btn-secondary">
                        🚪 Sign Out
                    </button>
                </div>
            </div>
        </div>
    </div>

    <footer class="footer">
        <p>&copy; 2025 Al Ummah Now. Built with OpenAuth and Cloudflare Workers.</p>
    </footer>

    <script>
        const currentUser = ${userData};
        const isLoggedIn = ${isLoggedIn};
        const authServerUrl = '${authServerUrl}';
        const appUrl = '${appUrl}';
        const adminUrl = '${adminUrl}';

        // Account switcher state
        let accounts = [];
        let dropdownOpen = false;
        const MAX_ACCOUNTS = 3;
        const avatarColors = ['#1976d2', '#388e3c', '#d32f2f', '#7b1fa2', '#f57c00', '#0097a7'];

        function getAvatarColor(email) {
            return avatarColors[email.charCodeAt(0) % avatarColors.length];
        }

        function formatRelativeTime(dateString) {
            const date = new Date(dateString);
            const now = new Date();
            const diffMs = now.getTime() - date.getTime();
            const diffMins = Math.floor(diffMs / 60000);
            if (diffMins < 1) return 'just now';
            if (diffMins < 60) return diffMins + 'm ago';
            if (diffMins < 1440) return Math.floor(diffMins / 60) + 'h ago';
            return Math.floor(diffMins / 1440) + 'd ago';
        }

        function toggleAccountDropdown() {
            dropdownOpen = !dropdownOpen;
            document.getElementById('accountDropdown').style.display = dropdownOpen ? 'block' : 'none';
            document.getElementById('chevronIcon').classList.toggle('open', dropdownOpen);
        }

        // Close dropdown when clicking outside
        document.addEventListener('click', function(e) {
            const switcher = document.getElementById('accountSwitcher');
            if (switcher && !switcher.contains(e.target) && dropdownOpen) {
                dropdownOpen = false;
                document.getElementById('accountDropdown').style.display = 'none';
                document.getElementById('chevronIcon').classList.remove('open');
            }
        });

        async function loadAccounts() {
            // Always start with current user from profile session as fallback
            if (isLoggedIn && currentUser) {
                accounts = [{
                    userId: currentUser.id,
                    email: currentUser.email,
                    isActive: true,
                    lastUsed: new Date().toISOString(),
                }];
                renderAccountSwitcher();
            }

            // Try to fetch multi-account data from auth server
            try {
                const response = await fetch(authServerUrl + '/session/accounts', {
                    credentials: 'include',
                });
                if (response.ok) {
                    const data = await response.json();
                    if (data.accounts && data.accounts.length > 0) {
                        accounts = data.accounts;
                        renderAccountSwitcher();
                    }
                }
            } catch (error) {
                console.error('Failed to load multi-account data from auth server:', error);
                // Keep using the fallback single-account data
            }
        }

        function renderAccountSwitcher() {
            const switcher = document.getElementById('accountSwitcher');
            const activeAccount = accounts.find(a => a.isActive);

            if (!isLoggedIn || !currentUser) {
                switcher.style.display = 'none';
                return;
            }

            switcher.style.display = 'inline-block';

            // Update active account display (fallback to currentUser if no activeAccount)
            const displayAccount = activeAccount || (currentUser ? { email: currentUser.email } : null);
            if (displayAccount) {
                document.getElementById('activeAvatar').style.backgroundColor = getAvatarColor(displayAccount.email);
                document.getElementById('activeAvatar').textContent = displayAccount.email.charAt(0).toUpperCase();
                document.getElementById('activeEmail').textContent = displayAccount.email;
            }

            // Render accounts list
            const listEl = document.getElementById('accountsList');
            listEl.innerHTML = accounts.map(account => \`
                <div class="account-item \${account.isActive ? 'active' : ''}" onclick="\${account.isActive ? '' : 'handleSwitchAccount(\\'' + account.userId + '\\')'}">
                    <div class="avatar" style="background-color: \${getAvatarColor(account.email)}">\${account.email.charAt(0).toUpperCase()}</div>
                    <div class="account-details">
                        <span class="email">\${account.email}</span>
                        <span class="status">\${account.isActive ? 'Active' : 'Last used ' + formatRelativeTime(account.lastUsed)}</span>
                    </div>
                    \${account.isActive ? '<span class="active-check">✓</span>' : ''}
                    <button class="sign-out-btn" onclick="event.stopPropagation(); handleSignOutAccount('\${account.userId}')" title="Sign out">×</button>
                </div>
            \`).join('');

            // Show/hide add account button based on limit
            document.getElementById('addAccountBtn').style.display = accounts.length < MAX_ACCOUNTS ? 'flex' : 'none';
        }

        async function handleSwitchAccount(userId) {
            try {
                const response = await fetch(authServerUrl + '/session/switch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ userId }),
                });

                if (response.ok) {
                    // After switching the active account on the auth server,
                    // we need to get new tokens for the profile app.
                    // Use prompt=none for silent auth since session was just switched.
                    const redirectUri = encodeURIComponent(appUrl + '/callback');
                    window.location.href = authServerUrl + '/authorize?response_type=code&client_id=109a1087-6626-40f7-8a7f-7f42f83f4f30&redirect_uri=' + redirectUri + '&prompt=none';
                } else {
                    console.error('Failed to switch account:', await response.text());
                }
            } catch (error) {
                console.error('Failed to switch account:', error);
            }
        }

        async function handleSignOutAccount(userId) {
            try {
                const response = await fetch(authServerUrl + '/session/accounts/' + userId, {
                    method: 'DELETE',
                    credentials: 'include',
                });
                const result = await response.json();
                if (result.remainingAccounts === 0) {
                    window.location.href = '/logout';
                } else {
                    await loadAccounts();
                    if (result.wasActive) {
                        window.location.reload();
                    }
                }
            } catch (error) {
                console.error('Failed to sign out:', error);
            }
        }

        function handleAddAccount() {
            const redirectUri = encodeURIComponent(appUrl + '/callback');
            // Use prompt=select_account to show account picker with existing accounts + "Use another account" option
            window.location.href = authServerUrl + '/authorize?response_type=code&client_id=109a1087-6626-40f7-8a7f-7f42f83f4f30&redirect_uri=' + redirectUri + '&prompt=select_account';
        }

        function handleManageSessions() {
            window.location.href = authServerUrl + '/settings/sessions';
        }

        async function handleSignOutAll() {
            try {
                await fetch(authServerUrl + '/session/all', {
                    method: 'DELETE',
                    credentials: 'include',
                });
                window.location.href = '/logout';
            } catch (error) {
                console.error('Failed to sign out all:', error);
            }
        }

        function renderUserUI(user) {
            const navMenu = document.getElementById('navMenu');
            document.getElementById('loggedInView').style.display = 'block';
            document.getElementById('loggedOutView').style.display = 'none';

            // Populate profile data
            document.getElementById('userId').textContent = user.id;
            document.getElementById('userEmail').textContent = user.email;

            const roleDiv = document.getElementById('userRole');
            roleDiv.innerHTML = '';
            const roles = user.roles || [];
            roles.forEach(role => {
                const roleBadge = document.createElement('span');
                const roleLower = role.toLowerCase();
                roleBadge.className = roleLower === 'admin' || roleLower === 'super admin' ? 'badge badge-admin' : 'badge badge-user';
                roleBadge.textContent = role.toUpperCase();
                roleBadge.style.marginRight = '8px';
                roleDiv.appendChild(roleBadge);
            });
            if (roles.length === 0) {
                roleDiv.textContent = 'No roles assigned';
            }

            // Update nav menu - show admin link for admin users
            const isAdmin = roles.some(r => r.toLowerCase() === 'admin' || r.toLowerCase() === 'super admin');
            navMenu.innerHTML = \`
                \${isAdmin && adminUrl ? \`<a href="\${adminUrl}" class="btn btn-primary">⚙️ Admin</a>\` : ''}
            \`;

            // Load accounts for the account switcher
            loadAccounts();
        }

        async function updateUI() {
            const navMenu = document.getElementById('navMenu');

            if (isLoggedIn && currentUser) {
                // First render with cached data
                renderUserUI(currentUser);

                // Then fetch fresh user data with current roles
                try {
                    const response = await fetch('/api/me', { credentials: 'include' });
                    if (response.ok) {
                        const freshUser = await response.json();
                        // Update with fresh data
                        renderUserUI(freshUser);
                    }
                } catch (err) {
                    console.error('Failed to fetch fresh user data:', err);
                }
            } else {
                // Show logged out view
                document.getElementById('loggedInView').style.display = 'none';
                document.getElementById('loggedOutView').style.display = 'block';

                // Update nav menu
                navMenu.innerHTML = \`
                    <button onclick="handleLogin()" class="btn btn-primary">
                        🔐 Sign In
                    </button>
                \`;
            }
        }

        function handleLogin() {
            // Use appUrl from server (respects APP_URL env var)
            const redirectUri = encodeURIComponent(appUrl + '/callback');
            const loginUrl = \`\${authServerUrl}/authorize?response_type=code&client_id=109a1087-6626-40f7-8a7f-7f42f83f4f30&redirect_uri=\${redirectUri}\`;
            window.location.href = loginUrl;
        }

        function handleLogout() {
            window.location.href = '/logout';
        }

        function checkForErrors() {
            const urlParams = new URLSearchParams(window.location.search);
            const error = urlParams.get('error');

            if (error) {
                const errorContainer = document.getElementById('errorContainer');
                errorContainer.innerHTML = \`
                    <div class="error-message">
                        <strong>Authentication Error:</strong> \${error}
                    </div>
                \`;

                // Clean up URL
                window.history.replaceState({}, document.title, window.location.pathname);
            }
        }

        // Initialize on page load
        window.addEventListener('DOMContentLoaded', function() {
            updateUI();
            checkForErrors();
        });
    </script>
    ${env.CF_WEB_ANALYTICS_TOKEN ? `<script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "${env.CF_WEB_ANALYTICS_TOKEN}"}'></script>` : ''}
</body>
</html>`;

      return new Response(html, {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    // 404 for other routes
    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
