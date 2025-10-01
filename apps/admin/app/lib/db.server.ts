// Server-side database utilities for connecting to the shared D1 database

export interface User {
  id: string;
  email: string;
  role: string;
  created_at: string;
  password_reset_required?: boolean;
}

export async function getAllUsers(db: D1Database): Promise<User[]> {
  const result = await db.prepare(
    `SELECT id, email, role, created_at, password_reset_required FROM user ORDER BY created_at DESC`
  ).all<User>();

  return result.results || [];
}

export async function getUserById(db: D1Database, id: string): Promise<User | null> {
  const result = await db.prepare(
    `SELECT id, email, role, created_at, password_reset_required FROM user WHERE id = ?`
  )
    .bind(id)
    .first<User>();

  return result || null;
}

export async function createUser(
  db: D1Database,
  email: string,
  role: string = 'user'
): Promise<User> {
  const result = await db.prepare(
    `INSERT INTO user (email, role, password_reset_required) VALUES (?, ?, TRUE) RETURNING id, email, role, created_at`
  )
    .bind(email, role)
    .first<User>();

  if (!result) {
    throw new Error(`Unable to create user: ${email}`);
  }

  return result;
}

export async function updateUser(
  db: D1Database,
  id: string,
  updates: { email?: string; role?: string }
): Promise<User | null> {
  const setParts: string[] = [];
  const values: any[] = [];

  if (updates.email !== undefined) {
    setParts.push('email = ?');
    values.push(updates.email);
  }

  if (updates.role !== undefined) {
    setParts.push('role = ?');
    values.push(updates.role);
  }

  if (setParts.length === 0) {
    throw new Error('No updates provided');
  }

  values.push(id);

  const result = await db.prepare(
    `UPDATE user SET ${setParts.join(', ')} WHERE id = ? RETURNING id, email, role, created_at`
  )
    .bind(...values)
    .first<User>();

  return result || null;
}

export async function deleteUser(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare(
    `DELETE FROM user WHERE id = ?`
  )
    .bind(id)
    .run();

  return (result.meta?.changes || 0) > 0;
}

export async function getUserStats(db: D1Database) {
  const totalUsers = await db.prepare(`SELECT COUNT(*) as count FROM user`).first<{ count: number }>();
  const adminUsers = await db.prepare(`SELECT COUNT(*) as count FROM user WHERE role = 'admin'`).first<{ count: number }>();

  return {
    totalUsers: totalUsers?.count || 0,
    adminUsers: adminUsers?.count || 0,
  };
}
