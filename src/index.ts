import { issuer } from "@openauthjs/openauth";
import { CloudflareStorage } from "@openauthjs/openauth/storage/cloudflare";
import { PasswordProvider } from "@openauthjs/openauth/provider/password";
import { PasswordUI } from "@openauthjs/openauth/ui/password";
import { createSubjects } from "@openauthjs/openauth/subject";
import * as v from 'valibot';
import SendEmail from "./email";
import { getOrCreateUser } from "./users";
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
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    
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
            font-family: Arial, sans-serif;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .header {
            background-color: #0051c3;
            color: white;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
        }
        .card {
            background: white;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .form-group {
            margin-bottom: 15px;
        }
        label {
            display: block;
            margin-bottom: 5px;
            font-weight: bold;
        }
        input, select, button {
            padding: 8px 12px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 14px;
        }
        input, select {
            width: 200px;
        }
        button {
            background-color: #0051c3;
            color: white;
            border: none;
            cursor: pointer;
            margin-right: 10px;
        }
        button:hover {
            background-color: #003d99;
        }
        .danger {
            background-color: #dc3545;
        }
        .danger:hover {
            background-color: #c82333;
        }
        .users-table {
            width: 100%;
            border-collapse: collapse;
        }
        .users-table th,
        .users-table td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #ddd;
        }
        .users-table th {
            background-color: #f8f9fa;
            font-weight: bold;
        }
        .error {
            color: #dc3545;
            background-color: #f8d7da;
            border: 1px solid #f5c6cb;
            padding: 10px;
            border-radius: 4px;
            margin-bottom: 15px;
        }
        .success {
            color: #155724;
            background-color: #d4edda;
            border: 1px solid #c3e6cb;
            padding: 10px;
            border-radius: 4px;
            margin-bottom: 15px;
        }
        .auth-section {
            background-color: #fff3cd;
            border: 1px solid #ffeaa7;
            padding: 15px;
            border-radius: 4px;
            margin-bottom: 20px;
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
            <label for="adminEmail">Admin Email:</label>
            <input type="email" id="adminEmail" placeholder="Enter admin email for authorization">
            <button onclick="setAuth()">Set Auth</button>
        </div>
        <p><strong>Note:</strong> Enter your admin email to authorize API requests.</p>
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
        <h2>Users</h2>
        <div id="usersMessage"></div>
        <button onclick="loadUsers()">Refresh Users</button>
        <table class="users-table" id="usersTable">
            <thead>
                <tr>
                    <th>ID</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Created At</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody id="usersTableBody">
                <!-- Users will be loaded here -->
            </tbody>
        </table>
    </div>

    <script>
        let authEmail = '';

        function setAuth() {
            authEmail = document.getElementById('adminEmail').value;
            if (authEmail) {
                showMessage('createMessage', 'Authentication set for: ' + authEmail, 'success');
                loadUsers();
            } else {
                showMessage('createMessage', 'Please enter an admin email', 'error');
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
                showMessage('createMessage', 'Please set authentication first', 'error');
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
                    showMessage('createMessage', \`User created successfully: \${data.user.email}\`, 'success');
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
                showMessage('usersMessage', 'Please set authentication first', 'error');
                return;
            }

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
                }
            } catch (error) {
                showMessage('usersMessage', 'Network error: ' + error.message, 'error');
            }
        }

        function renderUsers(users) {
            const tbody = document.getElementById('usersTableBody');
            tbody.innerHTML = '';

            users.forEach(user => {
                const row = document.createElement('tr');
                row.innerHTML = \`
                    <td>\${user.id}</td>
                    <td>\${user.email}</td>
                    <td>\${user.role}</td>
                    <td>\${new Date(user.created_at).toLocaleString()}</td>
                    <td>
                        <button onclick="updateUserRole('\${user.id}', '\${user.role === 'admin' ? 'user' : 'admin'}')">
                            Make \${user.role === 'admin' ? 'User' : 'Admin'}
                        </button>
                        <button onclick="resetPassword('\${user.id}')" style="background-color: #ffc107; color: black;">
                            Reset Password
                        </button>
                        <button onclick="deleteUser('\${user.id}')" class="danger">
                            Delete
                        </button>
                    </td>
                \`;
                tbody.appendChild(row);
            });
        }

        async function updateUserRole(userId, newRole) {
            if (!authEmail) {
                showMessage('usersMessage', 'Please set authentication first', 'error');
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
                showMessage('usersMessage', 'Please set authentication first', 'error');
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
                showMessage('usersMessage', 'Please set authentication first', 'error');
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
        primary: "#0051c3",
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


