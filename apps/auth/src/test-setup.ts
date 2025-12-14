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

  // Note: Legacy RBAC tables (roles, permissions, role_permissions) removed.
  // App now uses VIEWs over OpenAuth's rbac_* tables (created after rbac_* tables below).

  // User-Role mapping table (app code inserts here, but production uses VIEW over rbac_user_roles)
  // Note: Production uses a VIEW pointing to rbac_user_roles
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS user_roles (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      granted_by TEXT,
      granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP,
      is_active BOOLEAN DEFAULT TRUE,
      tenant_id TEXT DEFAULT 'default',
      UNIQUE(user_id, role_id)
    )
  `).run();

  // 5. Direct user permissions (no FK to permissions since it's a VIEW)
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS user_permissions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT NOT NULL,
      permission_id TEXT NOT NULL,
      is_grant BOOLEAN DEFAULT TRUE,
      granted_by TEXT,
      granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP,
      reason TEXT,
      UNIQUE(user_id, permission_id)
    )
  `).run();

  // Create indexes for tables (not views - views are created later after rbac_* tables)
  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id, is_active)`).run();
  await env.AUTH_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions(user_id)`).run();

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

  // ============================================================================
  // RBAC Compatibility Views (matching 0003_app_extensions.sql)
  // ============================================================================

  // View: roles -> rbac_roles (includes extra columns for app compatibility)
  await env.AUTH_DB.prepare(`
    CREATE VIEW IF NOT EXISTS roles AS
    SELECT
      id,
      name,
      description,
      NULL AS parent_role_id,
      is_system_role AS is_system,
      '{}' AS metadata,
      created_at,
      updated_at,
      NULL AS created_by,
      NULL AS updated_by,
      tenant_id
    FROM rbac_roles
  `).run();

  // View: permissions -> rbac_permissions (includes extra columns for app compatibility)
  await env.AUTH_DB.prepare(`
    CREATE VIEW IF NOT EXISTS permissions AS
    SELECT
      id,
      name,
      description,
      resource,
      action,
      client_id,
      created_at
    FROM rbac_permissions
  `).run();

  // View: role_permissions -> rbac_role_permissions (includes extra columns for app compatibility)
  await env.AUTH_DB.prepare(`
    CREATE VIEW IF NOT EXISTS role_permissions AS
    SELECT
      role_id || '_' || permission_id AS id,
      role_id,
      permission_id,
      granted_by,
      granted_at,
      granted_at AS created_at
    FROM rbac_role_permissions
  `).run();

  // ============================================================================
  // INSTEAD OF Triggers for views (to handle INSERT/UPDATE/DELETE)
  // ============================================================================

  // Trigger: INSERT into roles -> rbac_roles
  await env.AUTH_DB.prepare(`
    CREATE TRIGGER IF NOT EXISTS roles_insert
    INSTEAD OF INSERT ON roles
    BEGIN
      INSERT INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
      VALUES (
        NEW.id,
        NEW.name,
        COALESCE(NEW.tenant_id, 'default'),
        NEW.description,
        COALESCE(NEW.is_system, 0),
        COALESCE(NEW.created_at, unixepoch() * 1000),
        COALESCE(NEW.updated_at, unixepoch() * 1000)
      );
    END
  `).run();

  // Trigger: UPDATE roles -> rbac_roles
  await env.AUTH_DB.prepare(`
    CREATE TRIGGER IF NOT EXISTS roles_update
    INSTEAD OF UPDATE ON roles
    BEGIN
      UPDATE rbac_roles
      SET name = NEW.name,
          description = NEW.description,
          is_system_role = NEW.is_system,
          updated_at = COALESCE(NEW.updated_at, unixepoch() * 1000)
      WHERE id = OLD.id;
    END
  `).run();

  // Trigger: DELETE from roles -> rbac_roles
  await env.AUTH_DB.prepare(`
    CREATE TRIGGER IF NOT EXISTS roles_delete
    INSTEAD OF DELETE ON roles
    BEGIN
      DELETE FROM rbac_roles WHERE id = OLD.id;
    END
  `).run();

  // Trigger: INSERT into permissions -> rbac_permissions
  await env.AUTH_DB.prepare(`
    CREATE TRIGGER IF NOT EXISTS permissions_insert
    INSTEAD OF INSERT ON permissions
    BEGIN
      INSERT INTO rbac_permissions (id, name, client_id, description, resource, action, created_at)
      VALUES (
        NEW.id,
        NEW.name,
        COALESCE(NEW.client_id, 'test-client'),
        NEW.description,
        COALESCE(NEW.resource, '*'),
        COALESCE(NEW.action, '*'),
        COALESCE(NEW.created_at, unixepoch() * 1000)
      );
    END
  `).run();

  // Trigger: UPDATE permissions -> rbac_permissions
  await env.AUTH_DB.prepare(`
    CREATE TRIGGER IF NOT EXISTS permissions_update
    INSTEAD OF UPDATE ON permissions
    BEGIN
      UPDATE rbac_permissions
      SET name = NEW.name,
          description = NEW.description,
          resource = NEW.resource,
          action = NEW.action
      WHERE id = OLD.id;
    END
  `).run();

  // Trigger: DELETE from permissions -> rbac_permissions
  await env.AUTH_DB.prepare(`
    CREATE TRIGGER IF NOT EXISTS permissions_delete
    INSTEAD OF DELETE ON permissions
    BEGIN
      DELETE FROM rbac_permissions WHERE id = OLD.id;
    END
  `).run();

  // Trigger: INSERT into role_permissions -> rbac_role_permissions
  await env.AUTH_DB.prepare(`
    CREATE TRIGGER IF NOT EXISTS role_permissions_insert
    INSTEAD OF INSERT ON role_permissions
    BEGIN
      INSERT INTO rbac_role_permissions (role_id, permission_id, granted_at, granted_by)
      VALUES (
        NEW.role_id,
        NEW.permission_id,
        COALESCE(NEW.granted_at, NEW.created_at, unixepoch() * 1000),
        COALESCE(NEW.granted_by, 'system')
      );
    END
  `).run();

  // Trigger: DELETE from role_permissions -> rbac_role_permissions
  await env.AUTH_DB.prepare(`
    CREATE TRIGGER IF NOT EXISTS role_permissions_delete
    INSTEAD OF DELETE ON role_permissions
    BEGIN
      DELETE FROM rbac_role_permissions WHERE role_id = OLD.role_id AND permission_id = OLD.permission_id;
    END
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
  // Create system roles using OpenAuth's rbac_roles table directly
  // Using OpenAuth naming convention: role_{name}_default
  const systemRoles = [
    { id: 'role_super_admin_default', name: 'super_admin', description: 'Super administrator with full access', is_system: 1 },
    { id: 'role_admin_default', name: 'admin', description: 'Administrator with elevated privileges', is_system: 1 },
    { id: 'role_moderator_default', name: 'moderator', description: 'Moderator with content management privileges', is_system: 1 },
    { id: 'role_member_default', name: 'member', description: 'Standard user with basic access', is_system: 1 },
    // Keep legacy IDs for backward compatibility in tests
    { id: 'role_super_admin', name: 'super_admin_legacy', description: 'Super administrator (legacy)', is_system: 1 },
    { id: 'role_admin', name: 'admin_legacy', description: 'Administrator (legacy)', is_system: 1 },
    { id: 'role_user', name: 'user_legacy', description: 'Standard user (legacy)', is_system: 1 },
  ];

  const now = Date.now();
  for (const role of systemRoles) {
    await env.AUTH_DB.prepare(`
      INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at)
      VALUES (?, ?, 'default', ?, ?, ?, ?)
    `).bind(role.id, role.name, role.description, role.is_system, now, now).run();
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

    // Assign RBAC role if specified (using rbac_user_roles directly)
    if (user.rbacRole) {
      await env.AUTH_DB.prepare(`
        INSERT OR IGNORE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by)
        VALUES (?, ?, 'default', ?, 'system')
      `).bind(user.id, user.rbacRole, now).run();
    }
  }
}

// Run setup automatically when this module is imported
await setupDatabase();
