// Test setup file - runs before all tests
import { env } from "cloudflare:test";

// Create the database schema for testing
export async function setupDatabase() {
  // Migration 0001: Create user table (without legacy role column)
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS user (
      id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      email TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      password_reset_required BOOLEAN DEFAULT FALSE
    )
  `).run();

  // Migration 0011: Create RBAC tables
  // 1. Roles table
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      parent_role_id TEXT REFERENCES roles(id) ON DELETE SET NULL,
      is_system BOOLEAN DEFAULT FALSE,
      metadata TEXT DEFAULT '{}',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT REFERENCES user(id),
      updated_by TEXT REFERENCES user(id)
    )
  `).run();

  // 2. Permissions table
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS permissions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      name TEXT UNIQUE NOT NULL,
      resource TEXT NOT NULL,
      action TEXT NOT NULL,
      scope TEXT DEFAULT '*',
      description TEXT,
      is_system BOOLEAN DEFAULT FALSE,
      metadata TEXT DEFAULT '{}',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // 3. Role-Permission mapping
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      granted_by TEXT REFERENCES user(id),
      granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(role_id, permission_id)
    )
  `).run();

  // 4. User-Role mapping
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS user_roles (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      granted_by TEXT REFERENCES user(id),
      granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP,
      is_active BOOLEAN DEFAULT TRUE,
      UNIQUE(user_id, role_id)
    )
  `).run();

  // 5. Direct user permissions
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS user_permissions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      is_grant BOOLEAN DEFAULT TRUE,
      granted_by TEXT REFERENCES user(id),
      granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP,
      reason TEXT,
      UNIQUE(user_id, permission_id)
    )
  `).run();

  // Create indexes
  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id, is_active)`).run();
  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id)`).run();
  await env.AUTH_DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_permissions_name ON permissions(name)`).run();
  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions(resource, action, scope)`).run();
  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions(user_id)`).run();

  // Migration 0009: Create audit_events table
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'error', 'critical')),
      user_id TEXT,
      ip_address TEXT,
      user_agent TEXT,
      request_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      success INTEGER NOT NULL CHECK(success IN (0, 1)),
      error_message TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp)`).run();
  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_events_user_id ON audit_events(user_id)`).run();

  // Migration 0015: Create oauth_clients table
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      id TEXT PRIMARY KEY,
      client_id TEXT UNIQUE NOT NULL,
      client_secret_hash TEXT,
      client_type TEXT NOT NULL CHECK(client_type IN ('public', 'confidential')),
      allowed_grants TEXT NOT NULL,
      redirect_uris TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `).run();
  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_oauth_clients_client_id ON oauth_clients(client_id)`).run();

  // Migration 0012: Create refresh_tokens table
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      token_hash TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      issued_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL,
      last_used_at INTEGER,
      ip_address TEXT,
      user_agent TEXT,
      revoked INTEGER DEFAULT 0,
      revoked_at INTEGER,
      revoked_reason TEXT,
      parent_token_id TEXT,
      rotation_count INTEGER DEFAULT 0,
      scope TEXT DEFAULT 'openid email profile',
      token_family_id TEXT
    )
  `).run();
  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id)`).run();
  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash)`).run();

  // Migration 0019: Create token_usage table (updated schema)
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      token_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('generated', 'refreshed', 'revoked', 'reused')),
      client_id TEXT,
      timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
      ip_address TEXT,
      user_agent TEXT,
      metadata TEXT
    )
  `).run();
  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_token_usage_token_id ON token_usage(token_id)`).run();
  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp)`).run();
  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_token_usage_subject ON token_usage(subject)`).run();
  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_token_usage_client_id ON token_usage(client_id)`).run();
  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_token_usage_event_type ON token_usage(event_type)`).run();

  // Seed system roles
  const systemRoles = [
    { id: 'role_super_admin', name: 'super_admin', description: 'Super administrator with full access', is_system: 1 },
    { id: 'role_admin', name: 'admin', description: 'Administrator with elevated privileges', is_system: 1 },
    { id: 'role_moderator', name: 'moderator', description: 'Moderator with content management privileges', is_system: 1 },
    { id: 'role_user', name: 'user', description: 'Standard user with basic access', is_system: 1 },
  ];

  for (const role of systemRoles) {
    await env.AUTH_DB.prepare(`
      INSERT OR IGNORE INTO roles (id, name, description, is_system)
      VALUES (?, ?, ?, ?)
    `).bind(role.id, role.name, role.description, role.is_system).run();
  }

  // Create test users for use in tests (for foreign key references)
  // Using a comprehensive list of all user IDs referenced across test files
  const testUsers = [
    // System user (for bootstrap operations)
    { id: 'system', email: 'system@test.com', rbacRole: 'role_admin' },
    { id: 'super-admin', email: 'super-admin@system.com', rbacRole: 'role_super_admin' },
    { id: 'admin', email: 'admin@system.com', rbacRole: 'role_admin' },

    // Admin users
    { id: 'admin-user', email: 'admin@test.com', rbacRole: 'role_admin' },
    { id: 'admin-user-123', email: 'admin-user-123@test.com', rbacRole: 'role_admin' },
    { id: 'super-admin-user', email: 'super-admin@test.com', rbacRole: 'role_super_admin' },
    { id: 'admin-for-assignment', email: 'admin-for-assignment@test.com', rbacRole: 'role_admin' },
    { id: 'admin-for-removal', email: 'admin-for-removal@test.com', rbacRole: 'role_admin' },
    { id: 'admin-granter', email: 'admin-granter@test.com', rbacRole: 'role_admin' },
    { id: 'bulk-admin', email: 'bulk-admin@test.com', rbacRole: 'role_admin' },
    { id: 'audit-admin', email: 'audit-admin@test.com', rbacRole: 'role_admin' },
    { id: 'remove-admin', email: 'remove-admin@test.com', rbacRole: 'role_admin' },
    { id: 'expiry-admin', email: 'expiry-admin@test.com', rbacRole: 'role_admin' },

    // Regular users
    { id: 'test-user-123', email: 'test-user-123@test.com', rbacRole: 'role_user' },
    { id: 'check-user-123', email: 'check-user-123@test.com', rbacRole: 'role_user' },
    { id: 'regular-user-123', email: 'regular-user-123@test.com', rbacRole: 'role_user' },
    { id: 'regular-user-456', email: 'regular-user-456@test.com', rbacRole: 'role_user' },
    { id: 'regular-user', email: 'regular-user@test.com', rbacRole: 'role_user' },
    { id: 'regular-granter', email: 'regular-granter@test.com', rbacRole: 'role_user' },
    { id: 'target-user', email: 'target-user@test.com', rbacRole: 'role_user' },
    { id: 'test-user', email: 'test-user@test.com', rbacRole: 'role_user' },
    { id: 'expiring-user', email: 'expiring-user@test.com', rbacRole: 'role_user' },
    { id: 'no-duplicate-user', email: 'no-duplicate-user@test.com', rbacRole: 'role_user' },
    { id: 'removal-user', email: 'removal-user@test.com', rbacRole: 'role_user' },
    { id: 'no-role-user', email: 'no-role-user@test.com', rbacRole: null }, // User with no roles
    { id: 'multi-role-user', email: 'multi-role-user@test.com', rbacRole: 'role_user' },
    { id: 'no-roles-user', email: 'no-roles-user@test.com', rbacRole: null }, // User with no roles
    { id: 'metadata-user', email: 'metadata-user@test.com', rbacRole: 'role_user' },
    { id: 'bulk-user', email: 'bulk-user@test.com', rbacRole: 'role_user' },
    { id: 'expiry-user', email: 'expiry-user@test.com', rbacRole: 'role_user' },
    { id: 'user-one', email: 'user-one@test.com', rbacRole: 'role_user' },
    { id: 'user-two', email: 'user-two@test.com', rbacRole: 'role_user' },
    { id: 'user-three', email: 'user-three@test.com', rbacRole: 'role_user' },
    { id: 'cache-test-user', email: 'cache-test-user@test.com', rbacRole: 'role_user' },
    { id: 'super-admin-for-tests', email: 'super-admin-for-tests@test.com', rbacRole: 'role_super_admin' },
    { id: 'super-admin-perm-tests', email: 'super-admin-perm-tests@test.com', rbacRole: 'role_super_admin' },
    { id: 'user-123', email: 'user-123@test.com', rbacRole: 'role_user' },
    { id: 'user-456', email: 'user-456@test.com', rbacRole: 'role_user' },
  ];

  // Insert all test users and assign RBAC roles
  for (const user of testUsers) {
    await env.AUTH_DB.prepare(`
      INSERT OR IGNORE INTO user (id, email, password_reset_required)
      VALUES (?, ?, FALSE)
    `).bind(user.id, user.email).run();

    // Assign RBAC role if specified
    if (user.rbacRole) {
      await env.AUTH_DB.prepare(`
        INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_by, is_active)
        VALUES (?, ?, 'system', 1)
      `).bind(user.id, user.rbacRole).run();
    }
  }
}

// Run setup automatically when this module is imported
await setupDatabase();
