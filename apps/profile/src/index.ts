import { createClient } from "@meywd/openauth/client";
import { createSubjects } from "@meywd/openauth/subject";
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
  AUTH_DB: D1Database;
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
    clientID: "profile-app",
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
            client_id: 'profile-app',
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

    // Handle OAuth callback
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
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
        console.error('OAuth callback error:', error);
        return Response.redirect(`${url.origin}/?error=auth_failed`, 302);
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

        function updateUI() {
            const navMenu = document.getElementById('navMenu');

            if (isLoggedIn && currentUser) {
                // Show logged in view
                document.getElementById('loggedInView').style.display = 'block';
                document.getElementById('loggedOutView').style.display = 'none';

                // Populate profile data
                document.getElementById('userId').textContent = currentUser.id;
                document.getElementById('userEmail').textContent = currentUser.email;

                const roleDiv = document.getElementById('userRole');
                roleDiv.innerHTML = '';
                const roles = currentUser.roles || [];
                roles.forEach(role => {
                    const roleBadge = document.createElement('span');
                    roleBadge.className = role === 'admin' || role === 'super_admin' ? 'badge badge-admin' : 'badge badge-user';
                    roleBadge.textContent = role.toUpperCase();
                    roleBadge.style.marginRight = '8px';
                    roleDiv.appendChild(roleBadge);
                });
                if (roles.length === 0) {
                    roleDiv.textContent = 'No roles assigned';
                }

                // Update nav menu - show admin link for admin users
                const isAdmin = roles.some(r => r === 'admin' || r === 'super_admin');
                navMenu.innerHTML = \`
                    \${isAdmin && adminUrl ? \`<a href="\${adminUrl}" class="btn btn-primary" style="margin-right: 10px;">⚙️ Admin Dashboard</a>\` : ''}
                    <button onclick="handleLogout()" class="btn btn-secondary">
                        🚪 Sign Out
                    </button>
                \`;
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
            const loginUrl = \`\${authServerUrl}/authorize?response_type=code&client_id=profile-app&redirect_uri=\${redirectUri}\`;
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
