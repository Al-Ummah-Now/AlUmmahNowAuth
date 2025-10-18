// Test setup file - runs before all tests
import { env } from "cloudflare:test";

// Create the database schema for testing
export async function setupDatabase() {
  // Migration 0001: Create user table
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS user (
      id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      email TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      role TEXT DEFAULT 'user',
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

  // Create test users for use in tests (for foreign key references)
  // Using a comprehensive list of all user IDs referenced across test files
  const testUsers = [
    // System user (for bootstrap operations)
    { id: 'system', email: 'system@test.com', role: 'admin' },
    { id: 'super-admin', email: 'super-admin@system.com', role: 'admin' },
    { id: 'admin', email: 'admin@system.com', role: 'admin' },

    // Admin users
    { id: 'admin-user', email: 'admin@test.com', role: 'admin' },
    { id: 'admin-user-123', email: 'admin-user-123@test.com', role: 'admin' },
    { id: 'super-admin-user', email: 'super-admin@test.com', role: 'admin' },
    { id: 'admin-for-assignment', email: 'admin-for-assignment@test.com', role: 'admin' },
    { id: 'admin-for-removal', email: 'admin-for-removal@test.com', role: 'admin' },
    { id: 'admin-granter', email: 'admin-granter@test.com', role: 'admin' },
    { id: 'bulk-admin', email: 'bulk-admin@test.com', role: 'admin' },
    { id: 'audit-admin', email: 'audit-admin@test.com', role: 'admin' },
    { id: 'remove-admin', email: 'remove-admin@test.com', role: 'admin' },
    { id: 'expiry-admin', email: 'expiry-admin@test.com', role: 'admin' },

    // Regular users
    { id: 'test-user-123', email: 'test-user-123@test.com', role: 'user' },
    { id: 'check-user-123', email: 'check-user-123@test.com', role: 'user' },
    { id: 'regular-user-123', email: 'regular-user-123@test.com', role: 'user' },
    { id: 'regular-user-456', email: 'regular-user-456@test.com', role: 'user' },
    { id: 'regular-user', email: 'regular-user@test.com', role: 'user' },
    { id: 'regular-granter', email: 'regular-granter@test.com', role: 'user' },
    { id: 'target-user', email: 'target-user@test.com', role: 'user' },
    { id: 'test-user', email: 'test-user@test.com', role: 'user' },
    { id: 'expiring-user', email: 'expiring-user@test.com', role: 'user' },
    { id: 'no-duplicate-user', email: 'no-duplicate-user@test.com', role: 'user' },
    { id: 'removal-user', email: 'removal-user@test.com', role: 'user' },
    { id: 'no-role-user', email: 'no-role-user@test.com', role: 'user' },
    { id: 'multi-role-user', email: 'multi-role-user@test.com', role: 'user' },
    { id: 'no-roles-user', email: 'no-roles-user@test.com', role: 'user' },
    { id: 'metadata-user', email: 'metadata-user@test.com', role: 'user' },
    { id: 'bulk-user', email: 'bulk-user@test.com', role: 'user' },
    { id: 'expiry-user', email: 'expiry-user@test.com', role: 'user' },
    { id: 'user-one', email: 'user-one@test.com', role: 'user' },
    { id: 'user-two', email: 'user-two@test.com', role: 'user' },
    { id: 'user-three', email: 'user-three@test.com', role: 'user' },
    { id: 'cache-test-user', email: 'cache-test-user@test.com', role: 'user' },
    { id: 'super-admin-for-tests', email: 'super-admin-for-tests@test.com', role: 'admin' },
    { id: 'super-admin-perm-tests', email: 'super-admin-perm-tests@test.com', role: 'admin' },
    { id: 'user-123', email: 'user-123@test.com', role: 'user' },
    { id: 'user-456', email: 'user-456@test.com', role: 'user' },
  ];

  // Insert all test users
  for (const user of testUsers) {
    await env.AUTH_DB.prepare(`
      INSERT OR IGNORE INTO user (id, email, role, password_reset_required)
      VALUES (?, ?, ?, FALSE)
    `).bind(user.id, user.email, user.role).run();
  }
}

// Run setup automatically when this module is imported
await setupDatabase();
