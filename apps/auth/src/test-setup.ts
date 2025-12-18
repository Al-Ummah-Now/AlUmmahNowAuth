// Test setup file - runs before all tests
import { env } from "cloudflare:test";

// Create the database schema for testing
export async function setupDatabase() {
  // Drop any existing views OR tables that might conflict
  // (legacy compatibility objects no longer needed)
  const conflictingObjects = ['user_permissions'];
  for (const name of conflictingObjects) {
    await env.AUTH_DB.prepare(`DROP VIEW IF EXISTS ${name}`).run().catch(() => {});
    await env.AUTH_DB.prepare(`DROP TABLE IF EXISTS ${name}`).run().catch(() => {});
  }

  // Drop tables that have schema conflicts between migrations and test setup
  // (migrations have different schema for token_usage than what tests expect)
  await env.AUTH_DB.prepare(`DROP TABLE IF EXISTS token_usage`).run();

  // Users table (matches OpenAuth schema)
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      email TEXT NOT NULL,
      name TEXT,
      metadata TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_login_at INTEGER,
      deleted_at INTEGER,
      password_reset_required INTEGER DEFAULT 0,
      UNIQUE(tenant_id, email)
    )
  `).run();

  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`).run();
  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id)`).run();

  // Note: App uses OpenAuth's rbac_* tables directly (no compatibility views needed)

  // ============================================================================
  // OpenAuth RBAC tables (matching 001_schema.sql)
  // ============================================================================

  // tenants (required for oauth_clients FK)
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      domain TEXT UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      branding TEXT,
      settings TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `).run();

  // Insert default tenant
  await env.AUTH_DB.prepare(`
    INSERT OR IGNORE INTO tenants (id, name, status, branding, settings, created_at, updated_at)
    VALUES ('default', 'Default Tenant', 'active', '{}', '{}', unixepoch() * 1000, unixepoch() * 1000)
  `).run();

  // oauth_clients (OpenAuth schema)
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      client_secret_hash TEXT,
      grant_types TEXT DEFAULT '[]',
      scopes TEXT DEFAULT '[]',
      redirect_uris TEXT DEFAULT '[]',
      metadata TEXT DEFAULT '{}',
      enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      rotated_at INTEGER,
      previous_secret_hash TEXT,
      previous_secret_expires_at INTEGER,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    )
  `).run();
  await env.AUTH_DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_clients_tenant_name ON oauth_clients(tenant_id, name)`).run();
  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_oauth_clients_tenant ON oauth_clients(tenant_id)`).run();
  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_oauth_clients_created ON oauth_clients(created_at)`).run();
  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_oauth_clients_enabled ON oauth_clients(enabled)`).run();

  // rbac_roles
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS rbac_roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      description TEXT,
      is_system_role INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      UNIQUE(name, tenant_id)
    )
  `).run();

  // rbac_permissions (scoped to oauth_clients)
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS rbac_permissions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      client_id TEXT NOT NULL,
      description TEXT,
      resource TEXT NOT NULL,
      action TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      FOREIGN KEY (client_id) REFERENCES oauth_clients(id) ON DELETE CASCADE,
      UNIQUE(name, client_id)
    )
  `).run();

  // rbac_role_permissions
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS rbac_role_permissions (
      role_id TEXT NOT NULL,
      permission_id TEXT NOT NULL,
      granted_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      granted_by TEXT NOT NULL DEFAULT 'system',
      PRIMARY KEY (role_id, permission_id),
      FOREIGN KEY (role_id) REFERENCES rbac_roles(id) ON DELETE CASCADE,
      FOREIGN KEY (permission_id) REFERENCES rbac_permissions(id) ON DELETE CASCADE
    )
  `).run();

  // rbac_user_roles
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS rbac_user_roles (
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      assigned_at INTEGER NOT NULL,
      expires_at INTEGER,
      assigned_by TEXT NOT NULL,
      PRIMARY KEY (user_id, role_id, tenant_id)
    )
  `).run();

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

  // Migration 0012: Create refresh_tokens table (OpenAuth schema)
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      token_hash TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      scope TEXT,
      expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      revoked_at INTEGER,
      revoked_reason TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
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

  // Note: Roles are seeded by OpenAuth migrations (002_seed.sql)
  // Available roles: role_super_admin, role_admin, role_member, role_viewer, etc.

  const now = Date.now();

  // Create test users for use in tests (for foreign key references)
  // Note: No role assignments here - roles are seeded by OpenAuth migrations
  // Tests that need users with roles should set them up in beforeEach/beforeAll
  const testUserIds = [
    // System users
    'system', 'user_system', 'super-admin', 'admin',
    // Admin users for various tests
    'admin-user', 'admin-user-123', 'super-admin-user',
    'admin-for-assignment', 'admin-for-removal', 'admin-granter',
    'bulk-admin', 'audit-admin', 'remove-admin', 'expiry-admin',
    // Regular users
    'test-user-123', 'check-user-123', 'regular-user-123', 'regular-user-456',
    'regular-user', 'regular-granter', 'target-user', 'test-user',
    'expiring-user', 'no-duplicate-user', 'removal-user', 'no-role-user',
    'multi-role-user', 'no-roles-user', 'metadata-user', 'bulk-user',
    'expiry-user', 'user-one', 'user-two', 'user-three', 'cache-test-user',
    'super-admin-for-tests', 'super-admin-perm-tests', 'user-123', 'user-456',
  ];

  // Insert test users (no role assignments - handled by migrations)
  for (const userId of testUserIds) {
    await env.AUTH_DB.prepare(`
      INSERT OR IGNORE INTO users (id, tenant_id, email, status, created_at, updated_at, password_reset_required)
      VALUES (?, 'default', ?, 'active', ?, ?, 0)
    `).bind(userId, `${userId}@test.com`, now, now).run();
  }
}

// Run setup automatically when this module is imported
// (setupDatabase is already exported via the function declaration)
await setupDatabase();
