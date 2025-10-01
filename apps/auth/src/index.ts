import { issuer } from "@openauthjs/openauth";
import { CloudflareStorage } from "@openauthjs/openauth/storage/cloudflare";
import { PasswordProvider } from "@openauthjs/openauth/provider/password";
import { PasswordUI } from "@openauthjs/openauth/ui/password";
import { createSubjects } from "@openauthjs/openauth/subject";
import * as v from 'valibot';
import SendEmail from "./email";
import { getOrCreateUser, checkPasswordResetRequired, clearPasswordResetRequired } from "./users";
import { logger } from "./logger";

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
    
    // Serve default landing page
    if (url.pathname === '/' || url.pathname === '') {
      logger.debug('Serving landing page');
      const landingHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Al Ummah Now - Authentication Portal</title>
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
        
        .nav-link {
            padding: 10px 20px;
            border-radius: 8px;
            text-decoration: none;
            font-weight: 600;
            transition: all 0.3s ease;
            cursor: pointer;
            border: none;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .nav-link.primary {
            background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%);
            color: white;
            box-shadow: 0 2px 8px rgba(14, 165, 233, 0.3);
        }
        
        .nav-link.primary:hover {
            background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%);
            transform: translateY(-2px);
            box-shadow: 0 4px 16px rgba(14, 165, 233, 0.4);
        }
        
        .nav-link.secondary {
            background: rgba(255, 255, 255, 0.1);
            color: #e2e8f0;
            border: 1px solid rgba(255, 255, 255, 0.2);
        }
        
        .nav-link.secondary:hover {
            background: rgba(255, 255, 255, 0.2);
            color: white;
            transform: translateY(-1px);
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 3rem 2rem;
            flex: 1;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            text-align: center;
        }
        
        .hero {
            margin-bottom: 3rem;
        }
        
        .hero h1 {
            font-size: 3.5rem;
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
            margin: 0 auto 2rem;
            line-height: 1.6;
        }
        
        .features {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 2rem;
            margin-top: 3rem;
            width: 100%;
        }
        
        .feature-card {
            background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
            padding: 2rem;
            border-radius: 12px;
            border: 1px solid rgba(148, 163, 184, 0.2);
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
            transition: all 0.3s ease;
        }
        
        .feature-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
            border-color: rgba(14, 165, 233, 0.3);
        }
        
        .feature-icon {
            font-size: 3rem;
            margin-bottom: 1rem;
            display: block;
        }
        
        .feature-card h3 {
            font-size: 1.5rem;
            font-weight: 600;
            margin-bottom: 1rem;
            color: #0ea5e9;
        }
        
        .feature-card p {
            color: #cbd5e1;
            line-height: 1.6;
        }
        
        .cta-buttons {
            display: flex;
            gap: 1rem;
            justify-content: center;
            flex-wrap: wrap;
        }
        
        .cta-button {
            padding: 1rem 2rem;
            font-size: 1.1rem;
            font-weight: 600;
            border-radius: 12px;
            text-decoration: none;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            gap: 10px;
            cursor: pointer;
            border: none;
        }
        
        .cta-button.primary {
            background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%);
            color: white;
            box-shadow: 0 4px 20px rgba(14, 165, 233, 0.4);
        }
        
        .cta-button.primary:hover {
            background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%);
            transform: translateY(-3px);
            box-shadow: 0 6px 25px rgba(14, 165, 233, 0.5);
        }
        
        .cta-button.secondary {
            background: rgba(255, 255, 255, 0.1);
            color: #e2e8f0;
            border: 2px solid rgba(255, 255, 255, 0.2);
        }
        
        .cta-button.secondary:hover {
            background: rgba(255, 255, 255, 0.2);
            color: white;
            transform: translateY(-2px);
        }
        
        .footer {
            background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
            padding: 2rem;
            border-top: 1px solid rgba(148, 163, 184, 0.2);
            text-align: center;
            color: #94a3b8;
        }
        
        .user-info {
            background: linear-gradient(135deg, rgba(5, 150, 105, 0.15) 0%, rgba(16, 185, 129, 0.08) 100%);
            border: 1px solid #059669;
            padding: 1rem 1.5rem;
            border-radius: 12px;
            margin-bottom: 2rem;
            display: none;
        }
        
        .user-info.show {
            display: block;
        }
        
        .user-info h3 {
            color: #10b981;
            margin-bottom: 0.5rem;
            font-weight: 600;
        }
        
        .user-info p {
            color: #f8fafc;
            margin-bottom: 1rem;
        }
        
        @media (max-width: 768px) {
            .navbar-content {
                flex-direction: column;
                gap: 1rem;
            }
            
            .nav-menu {
                flex-wrap: wrap;
                justify-content: center;
            }
            
            .hero h1 {
                font-size: 2.5rem;
            }
            
            .cta-buttons {
                flex-direction: column;
                align-items: center;
            }
            
            .features {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <nav class="navbar">
        <div class="navbar-content">
            <div class="logo">
                <img src="https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png" alt="Al Ummah Now">
                <span>Al Ummah Now</span>
            </div>
            <div class="nav-menu">
                <button onclick="handleLogin()" class="nav-link primary">
                    🔐 Login
                </button>
                <a href="/docs" class="nav-link secondary">📚 Documentation</a>
            </div>
        </div>
    </nav>

    <div class="container">
        <div class="user-info" id="userInfo">
            <h3>Welcome back!</h3>
            <p id="userEmail">You are logged in as: user@example.com</p>
            <div style="display: flex; gap: 1rem; justify-content: center;">
                <button onclick="handleLogout()" class="cta-button secondary">
                    🚪 Logout
                </button>
            </div>
        </div>

        <div class="hero">
            <h1>Al Ummah Now</h1>
            <p>Secure authentication and user management system for the Muslim community. Connect, authenticate, and manage your digital identity with confidence.</p>
            
            <div class="cta-buttons">
                <button onclick="handleLogin()" class="cta-button primary" id="loginCta">
                    🚀 Get Started
                </button>
                <a href="/docs" class="cta-button secondary">
                    📖 Learn More
                </a>
            </div>
        </div>
    </div>

    <footer class="footer">
        <p>&copy; 2025 Al Ummah Now. Built with OpenAuth and Cloudflare Workers.</p>
    </footer>

    <script>
        let currentUser = null;

        // Check if user is already authenticated
        async function checkAuthStatus() {
            try {
                // Check for auth token in localStorage or cookie
                const token = localStorage.getItem('auth_token');
                if (token) {
                    // In a real implementation, verify the token with the server
                    // For now, we'll simulate user data
                    const userData = JSON.parse(localStorage.getItem('user_data') || '{}');
                    if (userData.email) {
                        currentUser = userData;
                        updateUIForLoggedInUser();
                    }
                }
            } catch (error) {
                console.error('Auth check failed:', error);
            }
        }

        function updateUIForLoggedInUser() {
            if (currentUser) {
                document.getElementById('userInfo').classList.add('show');
                document.getElementById('userEmail').textContent = \`You are logged in as: \${currentUser.email}\`;
                document.getElementById('loginCta').style.display = 'none';
            }
        }

        function updateUIForLoggedOutUser() {
            document.getElementById('userInfo').classList.remove('show');
            document.getElementById('loginCta').style.display = 'flex';
        }

        function handleLogin() {
            // Redirect to OpenAuth login flow
            const currentUrl = window.location.origin;
            const loginUrl = \`/authorize?response_type=code&client_id=web-app&redirect_uri=\${encodeURIComponent(currentUrl + '/callback')}\`;
            window.location.href = loginUrl;
        }

        function handleLogout() {
            // Clear auth data
            localStorage.removeItem('auth_token');
            localStorage.removeItem('user_data');
            currentUser = null;
            updateUIForLoggedOutUser();
        }

        // Check for OAuth callback
        function handleOAuthCallback() {
            const urlParams = new URLSearchParams(window.location.search);
            const code = urlParams.get('code');
            const error = urlParams.get('error');
            
            if (error) {
                alert('Authentication failed: ' + error);
                return;
            }
            
            if (code) {
                // Exchange code for user info (simplified for demo)
                const email = prompt('Enter your email to complete login:');
                
                if (email) {
                    currentUser = { email, role: 'user' };
                    localStorage.setItem('auth_token', code);
                    localStorage.setItem('user_data', JSON.stringify(currentUser));
                    
                    // Clean up URL
                    window.history.replaceState({}, document.title, window.location.pathname);
                    
                    updateUIForLoggedInUser();
                }
            }
        }

        // Initialize on page load
        window.addEventListener('DOMContentLoaded', function() {
            checkAuthStatus();
            handleOAuthCallback();
        });
    </script>
</body>
</html>`;
      
      return new Response(landingHtml, {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    // Serve documentation page
    if (url.pathname === '/docs') {
      logger.debug('Serving documentation page');
      const docsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Al Ummah Now - API Documentation</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            max-width: 1000px;
            margin: 0 auto;
            padding: 20px;
            background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
            color: #f8fafc;
            min-height: 100vh;
            line-height: 1.6;
        }
        
        .header {
            background: linear-gradient(135deg, #093041 0%, #0f4d66 100%);
            padding: 2rem;
            border-radius: 12px;
            margin-bottom: 2rem;
            text-align: center;
        }
        
        .header h1 {
            margin: 0 0 10px 0;
            font-size: 2.5em;
            color: white;
        }
        
        .header p {
            margin: 0;
            opacity: 0.9;
            font-size: 1.1em;
        }
        
        .nav-back {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 10px 20px;
            background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%);
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-weight: 600;
            margin-bottom: 2rem;
            transition: all 0.3s ease;
        }
        
        .nav-back:hover {
            background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%);
            transform: translateY(-2px);
        }
        
        .section {
            background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
            border-radius: 12px;
            padding: 2rem;
            margin-bottom: 2rem;
            border: 1px solid rgba(148, 163, 184, 0.2);
        }
        
        .section h2 {
            color: #0ea5e9;
            margin-top: 0;
            border-bottom: 2px solid #0ea5e9;
            padding-bottom: 10px;
        }
        
        .endpoint {
            background: rgba(15, 23, 42, 0.6);
            border: 1px solid rgba(148, 163, 184, 0.2);
            border-radius: 8px;
            padding: 1rem;
            margin: 1rem 0;
        }
        
        .method {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 4px;
            font-weight: bold;
            font-size: 0.9em;
            margin-right: 10px;
        }
        
        .method.get { background: #059669; color: white; }
        .method.post { background: #dc2626; color: white; }
        .method.put { background: #d97706; color: white; }
        .method.delete { background: #7c2d12; color: white; }
        
        .url {
            font-family: 'Courier New', monospace;
            background: rgba(9, 48, 65, 0.3);
            padding: 4px 8px;
            border-radius: 4px;
            color: #7dd3fc;
        }
        
        code {
            background: rgba(15, 23, 42, 0.8);
            padding: 2px 6px;
            border-radius: 4px;
            font-family: 'Courier New', monospace;
            color: #7dd3fc;
        }
        
        pre {
            background: rgba(15, 23, 42, 0.8);
            padding: 1rem;
            border-radius: 8px;
            overflow-x: auto;
            border: 1px solid rgba(148, 163, 184, 0.2);
        }
        
        ul {
            padding-left: 20px;
        }
        
        li {
            margin-bottom: 8px;
        }
    </style>
</head>
<body>
    <a href="/" class="nav-back">← Back to Home</a>
    
    <div class="header">
        <h1>Al Ummah Now API Documentation</h1>
        <p>OpenAuth Authentication Server with User Management</p>
    </div>

    <div class="section">
        <h2>🔐 Authentication Endpoints</h2>
        
        <div class="endpoint">
            <div>
                <span class="method get">GET</span>
                <span class="url">/authorize</span>
            </div>
            <p><strong>Description:</strong> Initiates OAuth authorization flow</p>
            <p><strong>Parameters:</strong></p>
            <ul>
                <li><code>response_type</code> - Set to "code"</li>
                <li><code>client_id</code> - Your client identifier</li>
                <li><code>redirect_uri</code> - Where to redirect after auth</li>
            </ul>
            <p><strong>Example:</strong></p>
            <pre>/authorize?response_type=code&client_id=web-app&redirect_uri=https://yourapp.com/callback</pre>
        </div>
    </div>

    <div class="section">
        <h2>🚀 Getting Started</h2>
        <ol>
            <li>Visit the <a href="/" style="color: #0ea5e9;">homepage</a> and click "Login"</li>
            <li>Complete the email authentication flow</li>
            <li>Access your authenticated session</li>
            <li>Enjoy secure authentication with Al Ummah Now</li>
        </ol>
    </div>

    <div class="section">
        <h2>📧 Support</h2>
        <p>For support and questions about the Al Ummah Now authentication system, please contact the development team.</p>
    </div>
</body>
</html>`;
      
      return new Response(docsHtml, {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    // Handle OAuth callback for main app
    if (url.pathname === '/callback') {
      logger.debug('Handling OAuth callback');
      // Extract the authorization code and redirect back to homepage with code as parameter
      const code = url.searchParams.get('code');
      if (code) {
        logger.info('OAuth callback successful', { hasCode: true });
        return Response.redirect(`${url.origin}/?code=${encodeURIComponent(code)}`, 302);
      } else {
        logger.warn('OAuth callback failed', { reason: 'missing_code' });
        return Response.redirect(`${url.origin}/?error=auth_failed`, 302);
      }
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


