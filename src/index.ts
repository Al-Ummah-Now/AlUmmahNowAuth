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
            background: linear-gradient(135deg, #1a365d 0%, #0891b2 100%);
            color: white;
            padding: 30px;
            border-radius: 12px;
            margin-bottom: 25px;
            box-shadow: 0 8px 32px rgba(8, 145, 178, 0.3);
            border: 1px solid rgba(56, 189, 248, 0.2);
        }
        .header h1 {
            margin: 0 0 10px 0;
            font-size: 2.2em;
            text-shadow: 0 2px 4px rgba(0,0,0,0.3);
        }
        .header p {
            margin: 0;
            opacity: 0.9;
            font-size: 1.1em;
        }
        .card {
            background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
            border-radius: 12px;
            padding: 25px;
            margin-bottom: 25px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4);
            border: 1px solid rgba(56, 189, 248, 0.1);
            backdrop-filter: blur(10px);
        }
        .card h2 {
            color: #38bdf8;
            margin-top: 0;
            font-size: 1.5em;
            border-bottom: 2px solid #f59e0b;
            padding-bottom: 10px;
            margin-bottom: 20px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            color: #e2e8f0;
            font-size: 0.95em;
        }
        input, select, button {
            padding: 12px 16px;
            border: 2px solid #475569;
            border-radius: 8px;
            font-size: 14px;
            transition: all 0.3s ease;
            background: rgba(15, 23, 42, 0.8);
            color: #f8fafc;
        }
        input, select {
            width: 240px;
            background: rgba(15, 23, 42, 0.9);
        }
        input:focus, select:focus {
            outline: none;
            border-color: #38bdf8;
            box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.1);
            background: rgba(15, 23, 42, 1);
        }
        button {
            background: linear-gradient(135deg, #0891b2 0%, #38bdf8 100%);
            color: white;
            border: none;
            cursor: pointer;
            margin-right: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            font-size: 13px;
            min-width: 120px;
        }
        button:hover {
            background: linear-gradient(135deg, #0e7490 0%, #0284c7 100%);
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(8, 145, 178, 0.4);
        }
        .danger {
            background: linear-gradient(135deg, #dc2626 0%, #ef4444 100%);
        }
        .danger:hover {
            background: linear-gradient(135deg, #b91c1c 0%, #dc2626 100%);
            box-shadow: 0 4px 12px rgba(220, 38, 38, 0.4);
        }
        .users-table {
            width: 100%;
            border-collapse: separate;
            border-spacing: 0;
            background: rgba(15, 23, 42, 0.8);
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 8px 32px rgba(0,0,0,0.3);
            border: 1px solid rgba(56, 189, 248, 0.1);
        }
        .users-table thead {
            position: sticky;
            top: 0;
            z-index: 10;
        }
        .users-table th {
            background: #0891b2;
            padding: 20px 16px;
            text-align: left;
            font-weight: 700;
            color: white;
            text-transform: uppercase;
            letter-spacing: 1px;
            font-size: 0.8em;
            border: none;
            position: relative;
            box-shadow: 0 4px 20px rgba(8, 145, 178, 0.3);
            text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
            transition: all 0.3s ease;
            cursor: pointer;
        }
        .users-table th:hover {
            background: #38bdf8;
            box-shadow: 0 6px 25px rgba(8, 145, 178, 0.5);
            transform: translateY(-1px);
        }
        .users-table th:first-child {
            border-top-left-radius: 12px;
            position: relative;
        }
        .users-table th:first-child::before {
            background: rgba(255, 255, 255, 0.08);
        }
        .users-table th:last-child {
            border-top-right-radius: 12px;
            position: relative;
        }
        .users-table th:last-child::before {
            background: rgba(255, 255, 255, 0.08);
        }
        .users-table th::after {
            content: '';
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: #f59e0b;
            z-index: 3;
        }
        .users-table th::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(255, 255, 255, 0.05);
            opacity: 0.7;
            z-index: 1;
        }
        .users-table tbody {
            background: rgba(30, 41, 59, 0.6);
        }
        .users-table td {
            padding: 20px 16px;
            border: none;
            border-bottom: 1px solid rgba(56, 189, 248, 0.08);
            color: #e2e8f0;
            vertical-align: middle;
            transition: all 0.3s ease;
        }
        .users-table tr {
            transition: all 0.3s ease;
        }
        .users-table tbody tr:hover {
            background: rgba(56, 189, 248, 0.1);
            transform: scale(1.01);
            box-shadow: 0 4px 20px rgba(56, 189, 248, 0.15);
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
            background: rgba(56, 189, 248, 0.1);
            padding: 6px 10px;
            border-radius: 6px;
            font-size: 0.85em;
            color: #38bdf8;
            border: 1px solid rgba(56, 189, 248, 0.2);
            display: inline-block;
            min-width: 80px;
            text-align: center;
        }
        
        /* Email styling */
        .user-email {
            font-weight: 600;
            color: #f8fafc;
            font-size: 0.95em;
        }
        .user-email::before {
            content: '✉️';
            margin-right: 8px;
            opacity: 0.7;
        }
        
        /* Role badge styling */
        .role-badge {
            display: inline-block;
            padding: 8px 16px;
            border-radius: 20px;
            font-weight: 700;
            font-size: 0.8em;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            border: 2px solid;
            min-width: 80px;
            text-align: center;
            transition: all 0.3s ease;
        }
        .role-admin {
            background: linear-gradient(135deg, #dc2626 0%, #ef4444 100%);
            border-color: #dc2626;
            color: white;
            box-shadow: 0 4px 12px rgba(220, 38, 38, 0.3);
        }
        .role-user {
            background: linear-gradient(135deg, #0891b2 0%, #38bdf8 100%);
            border-color: #0891b2;
            color: white;
            box-shadow: 0 4px 12px rgba(8, 145, 178, 0.3);
        }
        
        /* Date styling */
        .user-date {
            color: #94a3b8;
            font-size: 0.9em;
            font-style: italic;
        }
        .user-date::before {
            content: '📅';
            margin-right: 6px;
        }
        
        /* Status badge enhanced styling */
        .status-badge {
            display: inline-block;
            padding: 8px 16px;
            border-radius: 25px;
            font-weight: 700;
            font-size: 0.8em;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            border: 2px solid;
            min-width: 140px;
            text-align: center;
            transition: all 0.3s ease;
            position: relative;
            overflow: hidden;
        }
        .status-badge::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
            transition: left 0.5s;
        }
        .status-badge:hover::before {
            left: 100%;
        }
        .status-reset {
            background: linear-gradient(135deg, #dc2626 0%, #ef4444 100%);
            border-color: #dc2626;
            color: white;
            box-shadow: 0 4px 15px rgba(220, 38, 38, 0.4);
            animation: pulse-red 2s infinite;
        }
        .status-active {
            background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
            border-color: #22c55e;
            color: white;
            box-shadow: 0 4px 15px rgba(34, 197, 94, 0.4);
        }
        
        /* Action buttons container */
        .action-buttons {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            align-items: center;
        }
        .action-buttons button {
            min-width: 90px;
            padding: 10px 14px;
            font-size: 0.8em;
            border-radius: 8px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.3px;
            transition: all 0.3s ease;
            border: none;
            cursor: pointer;
            position: relative;
            overflow: hidden;
        }
        .action-buttons button::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
            transition: left 0.3s;
        }
        .action-buttons button:hover::before {
            left: 100%;
        }
        .action-buttons button:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(0,0,0,0.3);
        }
        
        /* Animations */
        @keyframes pulse-red {
            0%, 100% { box-shadow: 0 4px 15px rgba(220, 38, 38, 0.4); }
            50% { box-shadow: 0 4px 25px rgba(220, 38, 38, 0.7); }
        }
        
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        
        /* Empty state styling */
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: #64748b;
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
            color: #64748b;
            font-style: italic;
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
            background: linear-gradient(135deg, rgba(220, 38, 38, 0.2) 0%, rgba(239, 68, 68, 0.1) 100%);
            border: 1px solid #dc2626;
            padding: 12px 16px;
            border-radius: 8px;
            margin-bottom: 20px;
            backdrop-filter: blur(10px);
        }
        .success {
            color: #bbf7d0;
            background: linear-gradient(135deg, rgba(34, 197, 94, 0.2) 0%, rgba(74, 222, 128, 0.1) 100%);
            border: 1px solid #22c55e;
            padding: 12px 16px;
            border-radius: 8px;
            margin-bottom: 20px;
            backdrop-filter: blur(10px);
        }
        .auth-section {
            background: linear-gradient(135deg, rgba(245, 158, 11, 0.2) 0%, rgba(251, 191, 36, 0.1) 100%);
            border: 1px solid #f59e0b;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 25px;
            backdrop-filter: blur(10px);
        }
        .auth-section h3, .auth-section h4 {
            color: #fbbf24;
            margin-top: 0;
        }
        .auth-section p {
            color: #fde68a;
            margin-bottom: 15px;
        }
        .auth-section button {
            background: linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%);
            color: #0f172a;
            font-weight: 700;
        }
        .auth-section button:hover {
            background: linear-gradient(135deg, #d97706 0%, #f59e0b 100%);
            box-shadow: 0 4px 12px rgba(245, 158, 11, 0.4);
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
            <label for="adminEmail">Admin Email:</label>
            <input type="email" id="adminEmail" placeholder="Enter admin email for authorization">
            <button onclick="setAuth()">Set Auth</button>
        </div>
        <p><strong>Note:</strong> Enter your admin email to authorize API requests.</p>
        
        <div class="form-group" style="margin-top: 20px; padding-top: 15px; border-top: 1px solid #ffeaa7;">
            <h4>First Time Setup</h4>
            <p>If no admin users exist, create the first admin user:</p>
            <input type="email" id="bootstrapEmail" placeholder="Enter admin email">
            <button onclick="bootstrapAdmin()" style="background-color: #28a745;">Create First Admin</button>
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
                    background: linear-gradient(135deg, #0891b2 0%, #38bdf8 100%);
                    color: white;
                    padding: 4px 12px;
                    border-radius: 12px;
                    font-size: 0.8em;
                    font-weight: 700;
                    min-width: 20px;
                    text-align: center;
                ">0</span>
            </h2>
            <div style="display: flex; gap: 12px;">
                <button onclick="loadUsers()" style="
                    background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
                    color: white;
                    border: none;
                    padding: 10px 20px;
                    border-radius: 8px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.3s ease;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                " onmouseover="this.style.transform='translateY(-2px)'" 
                   onmouseout="this.style.transform='translateY(0)'">
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

        function setAuth() {
            authEmail = document.getElementById('adminEmail').value;
            if (authEmail) {
                showMessage('createMessage', 'Authentication set for: ' + authEmail, 'success');
                loadUsers();
            } else {
                showMessage('createMessage', 'Please enter an admin email', 'error');
            }
        }

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
                showMessage('usersMessage', 'Please set authentication first', 'error');
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
                                    style="background: linear-gradient(135deg, #0891b2 0%, #38bdf8 100%); color: white;">
                                \${user.role === 'admin' ? '👤 Make User' : '👑 Make Admin'}
                            </button>
                            <button onclick="resetPassword('\${user.id}')" 
                                    style="background: linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%); color: #0f172a;">
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


