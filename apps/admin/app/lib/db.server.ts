// Server-side database utilities for connecting to the shared D1 database

export interface User {
  id: string;
  email: string;
  created_at: string;
  password_reset_required?: boolean;
}

export async function getAllUsers(db: D1Database): Promise<User[]> {
  const result = await db.prepare(
    `SELECT id, email, created_at, password_reset_required FROM user ORDER BY created_at DESC`
  ).all<User>();

  return result.results || [];
}

export async function getUserById(db: D1Database, id: string): Promise<User | null> {
  const result = await db.prepare(
    `SELECT id, email, created_at, password_reset_required FROM user WHERE id = ?`
  )
    .bind(id)
    .first<User>();

  return result || null;
}

export async function createUser(
  db: D1Database,
  email: string,
  initialRole: string = 'user'
): Promise<User> {
  const result = await db.prepare(
    `INSERT INTO user (email, password_reset_required) VALUES (?, TRUE) RETURNING id, email, created_at`
  )
    .bind(email)
    .first<User>();

  if (!result) {
    throw new Error(`Unable to create user: ${email}`);
  }

  // Assign RBAC role based on initialRole parameter
  const roleId = initialRole === 'admin' ? 'role_admin' : 'role_user';
  await db.prepare(
    `INSERT INTO user_roles (user_id, role_id, granted_by, is_active) VALUES (?, ?, 'system', 1)`
  ).bind(result.id, roleId).run();

  return result;
}

export async function updateUser(
  db: D1Database,
  id: string,
  updates: { email?: string }
): Promise<User | null> {
  if (updates.email === undefined) {
    throw new Error('No updates provided');
  }

  const result = await db.prepare(
    `UPDATE user SET email = ? WHERE id = ? RETURNING id, email, created_at`
  )
    .bind(updates.email, id)
    .first<User>();

  return result || null;
}

export async function deleteUser(db: D1Database, id: string): Promise<boolean> {
  // First delete user_roles entries
  await db.prepare(`DELETE FROM user_roles WHERE user_id = ?`).bind(id).run();

  // Then delete the user
  const result = await db.prepare(
    `DELETE FROM user WHERE id = ?`
  )
    .bind(id)
    .run();

  return (result.meta?.changes || 0) > 0;
}

export interface RoleStats {
  totalRoles: number;
  systemRoles: number;
  customRoles: number;
}

export interface UsersByRole {
  name: string;
  user_count: number;
}

export async function getUserStats(db: D1Database) {
  const totalUsers = await db.prepare(`SELECT COUNT(*) as count FROM user`).first<{ count: number }>();

  // Count admin users via RBAC (users with role_admin or role_super_admin)
  const adminUsers = await db.prepare(`
    SELECT COUNT(DISTINCT ur.user_id) as count
    FROM user_roles ur
    WHERE ur.role_id IN ('role_admin', 'role_super_admin')
      AND ur.is_active = 1
      AND (ur.expires_at IS NULL OR ur.expires_at > datetime('now'))
  `).first<{ count: number }>();

  return {
    totalUsers: totalUsers?.count || 0,
    adminUsers: adminUsers?.count || 0,
  };
}

export async function getRoleStats(db: D1Database): Promise<RoleStats> {
  const result = await db.prepare(`
    SELECT
      COUNT(*) as total_roles,
      SUM(CASE WHEN is_system = 1 THEN 1 ELSE 0 END) as system_roles,
      SUM(CASE WHEN is_system = 0 THEN 1 ELSE 0 END) as custom_roles
    FROM roles
  `).first<{ total_roles: number; system_roles: number; custom_roles: number }>();

  return {
    totalRoles: result?.total_roles || 0,
    systemRoles: result?.system_roles || 0,
    customRoles: result?.custom_roles || 0,
  };
}

export async function getUsersByRole(db: D1Database, limit: number = 5): Promise<UsersByRole[]> {
  const result = await db.prepare(`
    SELECT r.name, COUNT(ur.user_id) as user_count
    FROM roles r
    LEFT JOIN user_roles ur ON r.id = ur.role_id AND ur.is_active = 1
    GROUP BY r.id, r.name
    ORDER BY user_count DESC
    LIMIT ?
  `).bind(limit).all<UsersByRole>();

  return result.results || [];
}
