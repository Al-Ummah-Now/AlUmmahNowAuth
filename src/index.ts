import { issuer } from "@openauthjs/openauth";
import { CloudflareStorage } from "@openauthjs/openauth/storage/cloudflare";
import { PasswordProvider } from "@openauthjs/openauth/provider/password";
import { PasswordUI } from "@openauthjs/openauth/ui/password";
import { createSubjects } from "@openauthjs/openauth/subject";
import * as v from 'valibot';
import SendEmail from "./email";
import { getOrCreateUser, checkPasswordResetRequired, clearPasswordResetRequired } from "./users";
import { 
  handleListUsers, 
  handleCreateUser, 
  handleGetUser, 
  handleUpdateUser, 
  handleDeleteUser, 
  handleResetPassword 
} from "./admin";

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
    const url = new URL(request.url);
    
    // Serve default landing page
    if (url.pathname === '/' || url.pathname === '') {
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
        
        .nav-link.admin {
            background: linear-gradient(135deg, #dc2626 0%, #ef4444 100%);
            color: white;
            box-shadow: 0 2px 8px rgba(220, 38, 38, 0.3);
        }
        
        .nav-link.admin:hover {
            background: linear-gradient(135deg, #b91c1c 0%, #dc2626 100%);
            transform: translateY(-2px);
            box-shadow: 0 4px 16px rgba(220, 38, 38, 0.4);
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
                <button onclick="goToAdmin()" class="nav-link admin" id="adminBtn" style="display: none;">
                    👑 Admin Panel
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
                <button onclick="goToAdmin()" class="cta-button primary" id="adminCta" style="display: none;">
                    👑 Access Admin Panel
                </button>
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
                
                // Show admin options if user is admin
                if (currentUser.role === 'admin') {
                    document.getElementById('adminBtn').style.display = 'flex';
                    document.getElementById('adminCta').style.display = 'flex';
                }
            }
        }

        function updateUIForLoggedOutUser() {
            document.getElementById('userInfo').classList.remove('show');
            document.getElementById('loginCta').style.display = 'flex';
            document.getElementById('adminBtn').style.display = 'none';
            document.getElementById('adminCta').style.display = 'none';
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

        function goToAdmin() {
            window.location.href = '/admin';
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
                const role = prompt('Enter your role (user/admin):') || 'user';
                
                if (email) {
                    currentUser = { email, role };
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
      // Extract the authorization code and redirect back to homepage with code as parameter
      const code = url.searchParams.get('code');
      if (code) {
        return Response.redirect(`${url.origin}/?code=${encodeURIComponent(code)}`, 302);
      } else {
        return Response.redirect(`${url.origin}/?error=auth_failed`, 302);
      }
    }
    
    // Handle admin OAuth callback
    if (url.pathname === '/admin/callback') {
      // Extract the authorization code and redirect back to admin with code as parameter
      const code = url.searchParams.get('code');
      if (code) {
        return Response.redirect(`${url.origin}/admin?code=${encodeURIComponent(code)}`, 302);
      } else {
        return Response.redirect(`${url.origin}/admin?error=auth_failed`, 302);
      }
    }
    
    // Serve admin interface
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      const adminHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Al Ummah Now - Admin Panel</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
            color: #f8fafc;
            min-height: 100vh;
        }
        .header {
            background: linear-gradient(135deg, #093041 0%, #0f4d66 100%);
            color: white;
            padding: 30px;
            border-radius: 12px;
            margin-bottom: 25px;
            box-shadow: 0 4px 20px rgba(9, 48, 65, 0.25);
            border: 1px solid rgba(15, 77, 102, 0.2);
        }
        .header h1 {
            margin: 0 0 10px 0;
            font-size: 2.2em;
            font-weight: 600;
            color: white;
        }
        .header p {
            margin: 0;
            opacity: 0.9;
            font-size: 1.1em;
            color: #e2e8f0;
        }
        .card {
            background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
            border-radius: 12px;
            padding: 25px;
            margin-bottom: 25px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.4);
            border: 1px solid rgba(148, 163, 184, 0.2);
            backdrop-filter: blur(10px);
        }
        .card h2 {
            color: #0ea5e9;
            margin-top: 0;
            font-size: 1.5em;
            font-weight: 600;
            border-bottom: 2px solid #0ea5e9;
            padding-bottom: 10px;
            margin-bottom: 20px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 8px;
            font-weight: 500;
            color: #f1f5f9;
            font-size: 0.95em;
        }
        input, select, button {
            padding: 12px 16px;
            border: 1px solid #64748b;
            border-radius: 8px;
            font-size: 14px;
            transition: all 0.2s ease;
            background: rgba(15, 23, 42, 0.9);
            color: #f8fafc;
        }
        input, select {
            width: 240px;
            background: rgba(15, 23, 42, 0.95);
        }
        input:focus, select:focus {
            outline: none;
            border-color: #0f4d66;
            box-shadow: 0 0 0 3px rgba(15, 77, 102, 0.2);
            background: rgba(26, 32, 44, 1);
        }
        button {
            background: linear-gradient(135deg, #093041 0%, #0f4d66 100%);
            color: white;
            border: none;
            cursor: pointer;
            margin-right: 12px;
            font-weight: 600;
            font-size: 13px;
            min-width: 120px;
            letter-spacing: 0.3px;
            text-transform: uppercase;
            box-shadow: 0 2px 8px rgba(9, 48, 65, 0.2);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        button:hover {
            background: linear-gradient(135deg, #072935 0%, #093041 100%);
            transform: translateY(-2px);
            box-shadow: 0 4px 16px rgba(9, 48, 65, 0.4);
        }
        button:active {
            transform: translateY(0);
            box-shadow: 0 2px 8px rgba(9, 48, 65, 0.3);
        }
        .danger {
            background: linear-gradient(135deg, #dc2626 0%, #ef4444 100%);
            color: white;
            border: 1px solid rgba(239, 68, 68, 0.3);
        }
        .danger:hover {
            background: linear-gradient(135deg, #b91c1c 0%, #dc2626 100%);
            box-shadow: 0 4px 16px rgba(220, 38, 38, 0.4);
            border-color: rgba(239, 68, 68, 0.5);
        }
        .users-table {
            width: 100%;
            border-collapse: separate;
            border-spacing: 0;
            background: rgba(15, 23, 42, 0.9);
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 4px 20px rgba(0,0,0,0.4);
            border: 1px solid rgba(148, 163, 184, 0.2);
        }
        .users-table thead {
            position: sticky;
            top: 0;
            z-index: 10;
        }
        .users-table th {
            background: #093041;
            padding: 20px 16px;
            text-align: left;
            font-weight: 600;
            color: white;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            font-size: 0.8em;
            border: none;
            position: relative;
            transition: all 0.2s ease;
        }
        .users-table th:hover {
            background: #0f4d66;
        }
        .users-table th:first-child {
            border-top-left-radius: 12px;
            position: relative;
        }
        .users-table th:first-child::before {
            background: rgba(255, 255, 255, 0.05);
        }
        .users-table th:last-child {
            border-top-right-radius: 12px;
            position: relative;
        }
        .users-table th:last-child::before {
            background: rgba(255, 255, 255, 0.05);
        }
        .users-table th::after {
            content: '';
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            height: 2px;
            background: #14556b;
            z-index: 3;
        }
        .users-table th::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(255, 255, 255, 0.03);
            opacity: 0.7;
            z-index: 1;
        }
        .users-table tbody {
            background: rgba(30, 41, 59, 0.8);
        }
        .users-table td {
            padding: 18px 16px;
            border: none;
            border-bottom: 1px solid rgba(148, 163, 184, 0.15);
            color: #f1f5f9;
            vertical-align: middle;
            transition: all 0.2s ease;
        }
        .users-table tr {
            transition: all 0.2s ease;
        }
        .users-table tbody tr:hover {
            background: rgba(9, 48, 65, 0.15);
            transform: translateY(-1px);
            box-shadow: 0 2px 10px rgba(9, 48, 65, 0.2);
        }
        .users-table tbody tr:last-child td:first-child {
            border-bottom-left-radius: 12px;
        }
        .users-table tbody tr:last-child td:last-child {
            border-bottom-right-radius: 12px;
        }
        .users-table tbody tr:last-child td {
            border-bottom: none;
        }
        
        /* User ID styling */
        .user-id {
            font-family: 'Courier New', monospace;
            background: rgba(9, 48, 65, 0.2);
            padding: 6px 10px;
            border-radius: 6px;
            font-size: 0.85em;
            color: #7dd3fc;
            border: 1px solid rgba(9, 48, 65, 0.3);
            display: inline-block;
            min-width: 80px;
            text-align: center;
            font-weight: 600;
        }
        
        /* Email styling */
        .user-email {
            font-weight: 500;
            color: #f8fafc;
            font-size: 0.95em;
        }
        .user-email::before {
            content: '✉️';
            margin-right: 8px;
            opacity: 0.6;
        }
        
        /* Role badge styling */
        .role-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border-radius: 16px;
            font-weight: 600;
            font-size: 0.8em;
            text-transform: uppercase;
            letter-spacing: 0.3px;
            border: 1px solid;
            min-width: 85px;
            text-align: center;
            justify-content: center;
            transition: all 0.2s ease;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
        }
        .role-admin {
            background: linear-gradient(135deg, #dc2626 0%, #ef4444 100%);
            border-color: rgba(220, 38, 38, 0.3);
            color: white;
        }
        .role-admin:hover {
            box-shadow: 0 2px 6px rgba(220, 38, 38, 0.3);
        }
        .role-user {
            background: linear-gradient(135deg, #093041 0%, #0f4d66 100%);
            border-color: rgba(9, 48, 65, 0.3);
            color: white;
        }
        .role-user:hover {
            box-shadow: 0 2px 6px rgba(9, 48, 65, 0.3);
        }
        
        /* Date styling */
        .user-date {
            color: #cbd5e1;
            font-size: 0.9em;
            font-style: italic;
            font-weight: 500;
        }
        .user-date::before {
            content: '📅';
            margin-right: 6px;
        }
        
        /* Status badge enhanced styling */
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border-radius: 18px;
            font-weight: 600;
            font-size: 0.8em;
            text-transform: uppercase;
            letter-spacing: 0.3px;
            border: 1px solid;
            min-width: 120px;
            text-align: center;
            justify-content: center;
            transition: all 0.2s ease;
            position: relative;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
        }
        .status-badge:hover {
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
        }
        .status-reset {
            background: linear-gradient(135deg, #dc2626 0%, #ef4444 100%);
            border-color: rgba(220, 38, 38, 0.3);
            color: white;
            animation: pulse-red 3s infinite;
        }
        .status-reset::after {
            content: '';
            position: absolute;
            top: 2px;
            right: 2px;
            width: 6px;
            height: 6px;
            background: #fbbf24;
            border-radius: 50%;
            animation: blink 2s infinite;
        }
        .status-active {
            background: linear-gradient(135deg, #059669 0%, #10b981 100%);
            border-color: rgba(5, 150, 105, 0.3);
            color: white;
        }
        
        /* Action buttons container */
        .action-buttons {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
            align-items: center;
            justify-content: flex-start;
        }
        .action-buttons button {
            min-width: 90px;
            padding: 8px 14px;
            font-size: 0.8em;
            border-radius: 6px;
            font-weight: 500;
            text-transform: none;
            letter-spacing: 0.1px;
            transition: all 0.2s ease;
            border: 1px solid rgba(255, 255, 255, 0.1);
            cursor: pointer;
            position: relative;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
        }
        .action-buttons button:hover {
            transform: none;
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
            border-color: rgba(255, 255, 255, 0.15);
        }
        .action-buttons button:active {
            transform: translateY(0);
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
        }
        
        /* Animations */
        @keyframes pulse-red {
            0%, 100% { 
                box-shadow: 0 1px 3px rgba(220, 38, 38, 0.25);
                border-color: rgba(220, 38, 38, 0.3);
            }
            50% { 
                box-shadow: 0 2px 6px rgba(220, 38, 38, 0.4);
                border-color: rgba(220, 38, 38, 0.5);
            }
        }
        
        @keyframes blink {
            0%, 50% { opacity: 1; }
            51%, 100% { opacity: 0.4; }
        }
        
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        
        /* Empty state styling */
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: #94a3b8;
            font-weight: 500;
        }
        .empty-state::before {
            content: '👥';
            font-size: 4em;
            display: block;
            margin-bottom: 20px;
            opacity: 0.5;
        }
        
        /* Responsive design */
        @media (max-width: 1200px) {
            .users-table th,
            .users-table td {
                padding: 12px 8px;
                font-size: 0.9em;
            }
            .action-buttons {
                flex-direction: column;
                gap: 4px;
            }
            .action-buttons button {
                width: 100%;
                min-width: auto;
            }
        }
        
        @media (max-width: 768px) {
            .users-table {
                font-size: 0.8em;
            }
            .users-table th:nth-child(4),
            .users-table td:nth-child(4) {
                display: none;
            }
            .user-id {
                min-width: 60px;
                font-size: 0.75em;
            }
            .role-badge,
            .status-badge {
                font-size: 0.7em;
                padding: 6px 10px;
            }
        }
        
        /* Loading state */
        .loading-row {
            text-align: center;
            padding: 40px 20px;
            color: #94a3b8;
            font-style: italic;
            font-weight: 500;
        }
        .loading-row::before {
            content: '⏳';
            margin-right: 8px;
            animation: spin 2s linear infinite;
        }
        
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        .error {
            color: #fecaca;
            background: linear-gradient(135deg, rgba(229, 62, 62, 0.25) 0%, rgba(252, 129, 129, 0.15) 100%);
            border: 1px solid #ef4444;
            padding: 12px 16px;
            border-radius: 8px;
            margin-bottom: 20px;
            backdrop-filter: blur(10px);
            font-weight: 500;
        }
        .success {
            color: #dcfce7;
            background: linear-gradient(135deg, rgba(9, 48, 65, 0.25) 0%, rgba(15, 77, 102, 0.15) 100%);
            border: 1px solid #0ea5e9;
            padding: 12px 16px;
            border-radius: 8px;
            margin-bottom: 20px;
            backdrop-filter: blur(10px);
            font-weight: 500;
        }
        .auth-section {
            background: linear-gradient(135deg, rgba(214, 158, 46, 0.15) 0%, rgba(236, 201, 75, 0.08) 100%);
            border: 1px solid #d69e2e;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 25px;
            backdrop-filter: blur(10px);
        }
        .auth-section h3, .auth-section h4 {
            color: #ecc94b;
            margin-top: 0;
            font-weight: 600;
        }
        .auth-section p {
            color: #f8fafc;
            margin-bottom: 15px;
            font-weight: 500;
        }
        .auth-section button {
            background: linear-gradient(135deg, #d97706 0%, #f59e0b 100%);
            color: white;
            font-weight: 600;
            border: 1px solid rgba(217, 119, 6, 0.3);
            letter-spacing: 0.3px;
            text-transform: uppercase;
            box-shadow: 0 2px 8px rgba(217, 119, 6, 0.2);
        }
        .auth-section button:hover {
            background: linear-gradient(135deg, #b45309 0%, #d97706 100%);
            box-shadow: 0 4px 16px rgba(217, 119, 6, 0.35);
            border-color: rgba(217, 119, 6, 0.5);
        }
        /* Custom scrollbar */
        ::-webkit-scrollbar {
            width: 8px;
        }
        ::-webkit-scrollbar-track {
            background: #1e293b;
        }
        ::-webkit-scrollbar-thumb {
            background: #38bdf8;
            border-radius: 4px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: #0891b2;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Al Ummah Now - Admin Panel</h1>
        <p>User Management System</p>
    </div>

    <div class="auth-section">
        <h3>Authentication</h3>
        <div class="form-group">
            <label for="adminEmail">Admin Access:</label>
            <button onclick="redirectToLogin()" style="
                background: linear-gradient(135deg, #093041 0%, #0f4d66 100%);
                color: white;
                border: 1px solid rgba(9, 48, 65, 0.3);
                font-weight: 600;
                letter-spacing: 0.3px;
                text-transform: uppercase;
                box-shadow: 0 2px 8px rgba(9, 48, 65, 0.2);
                padding: 12px 24px;
                border-radius: 8px;
                cursor: pointer;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            ">🔐 Login with Al Ummah Now</button>
        </div>
        <p><strong>Note:</strong> Click the button above to authenticate through the Al Ummah Now login system.</p>
        
        <div class="form-group" style="margin-top: 20px; padding-top: 15px; border-top: 1px solid #ffeaa7;">
            <h4>First Time Setup</h4>
            <p>If no admin users exist, create the first admin user:</p>
            <input type="email" id="bootstrapEmail" placeholder="Enter admin email">
            <button onclick="bootstrapAdmin()" style="
                background: linear-gradient(135deg, #059669 0%, #10b981 100%);
                color: white;
                border: 1px solid rgba(5, 150, 105, 0.3);
                font-weight: 600;
                letter-spacing: 0.3px;
                text-transform: uppercase;
                box-shadow: 0 2px 8px rgba(5, 150, 105, 0.2);
            ">Create First Admin</button>
        </div>
    </div>

    <div class="card">
        <h2>Create New User</h2>
        <div id="createMessage"></div>
        <div class="form-group">
            <label for="newEmail">Email:</label>
            <input type="email" id="newEmail" placeholder="user@example.com">
        </div>
        <div class="form-group">
            <label for="newRole">Role:</label>
            <select id="newRole">
                <option value="user">User</option>
                <option value="admin">Admin</option>
            </select>
        </div>
        <button onclick="createUser()">Create User</button>
    </div>

    <div class="card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
            <h2 style="margin: 0; display: flex; align-items: center; gap: 12px;">
                <span style="font-size: 1.5em;">👥</span>
                Users Management
                <span id="userCount" style="
                    background: linear-gradient(135deg, #093041 0%, #0f4d66 100%);
                    color: white;
                    padding: 4px 12px;
                    border-radius: 12px;
                    font-size: 0.8em;
                    font-weight: 600;
                    min-width: 20px;
                    text-align: center;
                ">0</span>
            </h2>
            <div style="display: flex; gap: 12px;">
                <button onclick="loadUsers()" style="
                    background: linear-gradient(135deg, #093041 0%, #0f4d66 100%);
                    color: white;
                    border: 1px solid rgba(9, 48, 65, 0.3);
                    padding: 12px 24px;
                    border-radius: 8px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    text-transform: uppercase;
                    letter-spacing: 0.3px;
                    font-size: 0.75em;
                    box-shadow: 0 2px 8px rgba(9, 48, 65, 0.2);
                " onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 16px rgba(9, 48, 65, 0.4)'" 
                   onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 8px rgba(9, 48, 65, 0.2)'">
                    🔄 Refresh
                </button>
            </div>
        </div>
        <div id="usersMessage"></div>
        <div style="
            overflow-x: auto;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.3);
            border: 1px solid rgba(56, 189, 248, 0.1);
            max-height: 600px;
            overflow-y: auto;
        ">
            <table class="users-table" id="usersTable">
                <thead>
                    <tr>
                        <th>User ID</th>
                        <th>Email Address</th>
                        <th>Role</th>
                        <th>Created Date</th>
                        <th>Password Status</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody id="usersTableBody">
                    <tr class="empty-state">
                        <td colspan="6">No users found. Create the first user to get started.</td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>

    <script>
        let authEmail = '';
        let authToken = '';

        function redirectToLogin() {
            // Redirect to OpenAuth login flow with admin panel as callback
            const currentUrl = window.location.origin;
            const loginUrl = \`/authorize?response_type=code&client_id=admin-panel&redirect_uri=\${encodeURIComponent(currentUrl + '/admin/callback')}\`;
            window.location.href = loginUrl;
        }

        // Check for auth token from URL parameters (after OAuth callback)
        function checkAuthFromUrl() {
            const urlParams = new URLSearchParams(window.location.search);
            const code = urlParams.get('code');
            
            if (code) {
                // Exchange code for token and get user info
                exchangeCodeForAuth(code);
                // Clean up URL
                window.history.replaceState({}, document.title, window.location.pathname);
            }
        }

        async function exchangeCodeForAuth(code) {
            try {
                // In a real implementation, you'd exchange the code for an access token
                // For now, we'll simulate getting user info
                showMessage('createMessage', 'Successfully authenticated! Loading user data...', 'success');
                
                // Simulate getting user email from the auth flow
                // In production, this would involve token exchange and user info retrieval
                const userEmail = prompt('Enter your admin email to complete setup:');
                if (userEmail) {
                    authEmail = userEmail;
                    authToken = code; // Using code as temporary token
                    showMessage('createMessage', \`Successfully logged in as: \${userEmail}\`, 'success');
                    loadUsers();
                }
            } catch (error) {
                showMessage('createMessage', 'Authentication failed: ' + error.message, 'error');
            }
        }

        function setAuth() {
            authEmail = document.getElementById('adminEmail').value;
            if (authEmail) {
                showMessage('createMessage', 'Successfully logged in as: ' + authEmail, 'success');
                loadUsers();
            } else {
                showMessage('createMessage', 'Please enter an admin email', 'error');
            }
        }

        // Initialize auth check on page load
        window.addEventListener('DOMContentLoaded', function() {
            checkAuthFromUrl();
        });

        async function bootstrapAdmin() {
            const email = document.getElementById('bootstrapEmail').value;
            
            if (!email) {
                showMessage('createMessage', 'Please enter an email for the admin user', 'error');
                return;
            }

            try {
                const response = await fetch('/admin/bootstrap', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ email })
                });

                const data = await response.json();

                if (response.ok) {
                    showMessage('createMessage', \`Bootstrap admin created: \${data.user.email}\`, 'success');
                    document.getElementById('bootstrapEmail').value = '';
                    document.getElementById('adminEmail').value = email;
                    authEmail = email;
                    loadUsers();
                } else {
                    showMessage('createMessage', data.error || 'Failed to create bootstrap admin', 'error');
                }
            } catch (error) {
                showMessage('createMessage', 'Network error: ' + error.message, 'error');
            }
        }

        function showMessage(elementId, message, type) {
            const element = document.getElementById(elementId);
            element.innerHTML = \`<div class="\${type}">\${message}</div>\`;
            setTimeout(() => {
                element.innerHTML = '';
            }, 5000);
        }

        async function createUser() {
            const email = document.getElementById('newEmail').value;
            const role = document.getElementById('newRole').value;

            if (!authEmail) {
                showMessage('createMessage', 'Please login first', 'error');
                return;
            }

            if (!email) {
                showMessage('createMessage', 'Please enter an email', 'error');
                return;
            }

            try {
                const response = await fetch('/admin/users', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': \`Bearer \${authEmail}\`
                    },
                    body: JSON.stringify({ email, role })
                });

                const data = await response.json();

                if (response.ok) {
                    showMessage('createMessage', \`User created successfully: \${data.user.email}. Welcome email sent with temporary password.\`, 'success');
                    document.getElementById('newEmail').value = '';
                    loadUsers();
                } else {
                    showMessage('createMessage', data.error || 'Failed to create user', 'error');
                }
            } catch (error) {
                showMessage('createMessage', 'Network error: ' + error.message, 'error');
            }
        }

        async function loadUsers() {
            if (!authEmail) {
                showMessage('usersMessage', 'Please login first', 'error');
                return;
            }

            // Show loading state
            const tbody = document.getElementById('usersTableBody');
            const loadingRow = document.createElement('tr');
            loadingRow.className = 'loading-row';
            loadingRow.innerHTML = \`<td colspan="6">Loading users...</td>\`;
            tbody.innerHTML = '';
            tbody.appendChild(loadingRow);

            try {
                const response = await fetch('/admin/users', {
                    headers: {
                        'Authorization': \`Bearer \${authEmail}\`
                    }
                });

                const data = await response.json();

                if (response.ok) {
                    renderUsers(data.users);
                    showMessage('usersMessage', 'Users loaded successfully', 'success');
                } else {
                    showMessage('usersMessage', data.error || 'Failed to load users', 'error');
                    // Show error state in table
                    tbody.innerHTML = '';
                    const errorRow = document.createElement('tr');
                    errorRow.className = 'empty-state';
                    errorRow.innerHTML = \`<td colspan="6">❌ Failed to load users: \${data.error || 'Unknown error'}</td>\`;
                    tbody.appendChild(errorRow);
                }
            } catch (error) {
                showMessage('usersMessage', 'Network error: ' + error.message, 'error');
                // Show network error state in table
                tbody.innerHTML = '';
                const errorRow = document.createElement('tr');
                errorRow.className = 'empty-state';
                errorRow.innerHTML = \`<td colspan="6">🌐 Network error: \${error.message}</td>\`;
                tbody.appendChild(errorRow);
            }
        }

        function renderUsers(users) {
            const tbody = document.getElementById('usersTableBody');
            const userCount = document.getElementById('userCount');
            tbody.innerHTML = '';
            
            // Update user count
            userCount.textContent = users.length;

            if (users.length === 0) {
                const row = document.createElement('tr');
                row.className = 'empty-state';
                row.innerHTML = \`<td colspan="6">No users found. Create the first user to get started.</td>\`;
                tbody.appendChild(row);
                return;
            }

            users.forEach(user => {
                const row = document.createElement('tr');
                row.innerHTML = \`
                    <td>
                        <span class="user-id">#\${user.id}</span>
                    </td>
                    <td>
                        <span class="user-email">\${user.email}</span>
                    </td>
                    <td>
                        <span class="role-badge role-\${user.role}">
                            \${user.role === 'admin' ? '👑 Admin' : '👤 User'}
                        </span>
                    </td>
                    <td>
                        <span class="user-date">\${new Date(user.created_at).toLocaleDateString()}</span>
                    </td>
                    <td>
                        <span class="status-badge \${user.password_reset_required ? 'status-reset' : 'status-active'}">
                            \${user.password_reset_required ? '🔄 Reset Required' : '✅ Active'}
                        </span>
                    </td>
                    <td>
                        <div class="action-buttons">
                            <button onclick="updateUserRole('\${user.id}', '\${user.role === 'admin' ? 'user' : 'admin'}')" 
                                    style="
                                        background: linear-gradient(135deg, #093041 0%, #0f4d66 100%); 
                                        color: white;
                                        border: 1px solid rgba(255, 255, 255, 0.1);
                                        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
                                    ">
                                \${user.role === 'admin' ? '👤 Make User' : '👑 Make Admin'}
                            </button>
                            <button onclick="resetPassword('\${user.id}')" 
                                    style="
                                        background: linear-gradient(135deg, #d97706 0%, #f59e0b 100%); 
                                        color: white;
                                        border: 1px solid rgba(255, 255, 255, 0.1);
                                        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
                                    ">
                                🔑 Reset Pwd
                            </button>
                            <button onclick="deleteUser('\${user.id}')" 
                                    class="danger">
                                🗑️ Delete
                            </button>
                        </div>
                    </td>
                \`;
                tbody.appendChild(row);
            });
        }

        async function updateUserRole(userId, newRole) {
            if (!authEmail) {
                showMessage('usersMessage', 'Please login first', 'error');
                return;
            }

            try {
                const response = await fetch(\`/admin/users/\${userId}\`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': \`Bearer \${authEmail}\`
                    },
                    body: JSON.stringify({ role: newRole })
                });

                const data = await response.json();

                if (response.ok) {
                    showMessage('usersMessage', \`User role updated to \${newRole}\`, 'success');
                    loadUsers();
                } else {
                    showMessage('usersMessage', data.error || 'Failed to update user', 'error');
                }
            } catch (error) {
                showMessage('usersMessage', 'Network error: ' + error.message, 'error');
            }
        }

        async function resetPassword(userId) {
            if (!authEmail) {
                showMessage('usersMessage', 'Please login first', 'error');
                return;
            }

            if (!confirm('Are you sure you want to reset this user\\'s password?')) {
                return;
            }

            try {
                const response = await fetch(\`/admin/users/\${userId}/reset-password\`, {
                    method: 'POST',
                    headers: {
                        'Authorization': \`Bearer \${authEmail}\`
                    }
                });

                const data = await response.json();

                if (response.ok) {
                    showMessage('usersMessage', 'Password reset email sent successfully', 'success');
                } else {
                    showMessage('usersMessage', data.error || 'Failed to reset password', 'error');
                }
            } catch (error) {
                showMessage('usersMessage', 'Network error: ' + error.message, 'error');
            }
        }

        async function deleteUser(userId) {
            if (!authEmail) {
                showMessage('usersMessage', 'Please login first', 'error');
                return;
            }

            if (!confirm('Are you sure you want to delete this user? This action cannot be undone.')) {
                return;
            }

            try {
                const response = await fetch(\`/admin/users/\${userId}\`, {
                    method: 'DELETE',
                    headers: {
                        'Authorization': \`Bearer \${authEmail}\`
                    }
                });

                const data = await response.json();

                if (response.ok) {
                    showMessage('usersMessage', 'User deleted successfully', 'success');
                    loadUsers();
                } else {
                    showMessage('usersMessage', data.error || 'Failed to delete user', 'error');
                }
            } catch (error) {
                showMessage('usersMessage', 'Network error: ' + error.message, 'error');
            }
        }
    </script>
</body>
</html>`;
      
      return new Response(adminHtml, {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    // Handle admin routes
    if (url.pathname.startsWith('/admin/')) {
      const pathParts = url.pathname.split('/');
      
      // Special bootstrap endpoint to create first admin user
      if (pathParts[2] === 'bootstrap' && request.method === 'POST') {
        try {
          const body = await request.json() as { email: string };
          const { email } = body;
          
          if (!email) {
            return new Response(JSON.stringify({ error: 'Email is required' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          
          // Check if any admin users exist
          const existingAdmins = await env.AUTH_DB.prepare(
            `SELECT COUNT(*) as count FROM user WHERE role = 'admin'`
          ).first<{ count: number }>();
          
          if (existingAdmins && existingAdmins.count > 0) {
            return new Response(JSON.stringify({ error: 'Admin user already exists' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          
          // Create the first admin user
          const user = await env.AUTH_DB.prepare(
            `INSERT INTO user (email, role) VALUES (?, 'admin') RETURNING id, email, role`
          ).bind(email).first<{ id: string; email: string; role: string }>();
          
          return new Response(JSON.stringify({ 
            message: 'Bootstrap admin user created successfully',
            user: user 
          }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' }
          });
          
        } catch (error) {
          console.error('Bootstrap error:', error);
          return new Response(JSON.stringify({ error: 'Failed to create bootstrap admin' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      if (pathParts[2] === 'users') {
        if (request.method === 'GET' && pathParts.length === 3) {
          // GET /admin/users - List all users
          return handleListUsers(env, request);
        }
        
        if (request.method === 'POST' && pathParts.length === 3) {
          // POST /admin/users - Create new user
          return handleCreateUser(env, request);
        }
        
        if (pathParts.length === 4) {
          const userId = pathParts[3];
          
          if (request.method === 'GET') {
            // GET /admin/users/:id - Get specific user
            return handleGetUser(env, request, userId);
          }
          
          if (request.method === 'PUT') {
            // PUT /admin/users/:id - Update user
            return handleUpdateUser(env, request, userId);
          }
          
          if (request.method === 'DELETE') {
            // DELETE /admin/users/:id - Delete user
            return handleDeleteUser(env, request, userId);
          }
        }
        
        if (pathParts.length === 5 && pathParts[4] === 'reset-password' && request.method === 'POST') {
          // POST /admin/users/:id/reset-password - Reset user password
          const userId = pathParts[3];
          return handleResetPassword(env, request, userId);
        }
      }
      
      // If no admin route matched, return 404
      return new Response(JSON.stringify({ error: 'Admin endpoint not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // The real OpenAuth server code starts here:
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
              console.log('env', env);
              const key = await env.RESEND_API_KEY.get();
              console.log("Sending email to", email, "with code", code, "and key", key);
              await SendEmail(key, "login@alummahnow.net", email, "Your login code", `Your login code is ${code}`);
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
        const user = await getOrCreateUser(env, value.email);
        return ctx.subject("user", {
          id: user.id,
          email: value.email,
          role: user.role,
        });
      },
    }).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;


