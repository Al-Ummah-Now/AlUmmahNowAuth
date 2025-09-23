export async function getOrCreateUser(env: Env, email: string): Promise<{ id: string; role: string }> {
    // First check if user already exists
    const existingUser = await env.AUTH_DB.prepare(
      `SELECT id, role FROM user WHERE email = ?`
    )
      .bind(email)
      .first<{ id: string; role: string }>();
    
    if (existingUser) {
      return existingUser;
    }
    
    // Create new user (from login flow, not admin creation) - no password reset required
    const result = await env.AUTH_DB.prepare(
      `INSERT INTO user (email, role, password_reset_required) VALUES (?, 'user', FALSE) RETURNING id, role`
    )
      .bind(email)
      .first<{ id: string; role: string }>();
      
    if (!result) {
      throw new Error(`Unable to process user: ${email}`);
    }
    return result;
  }

export async function getUserById(env: Env, id: string): Promise<{ id: string; email: string; role: string; created_at: string; password_reset_required?: boolean } | null> {
  const result = await env.AUTH_DB.prepare(
    `SELECT id, email, role, created_at, password_reset_required FROM user WHERE id = ?`
  )
    .bind(id)
    .first<{ id: string; email: string; role: string; created_at: string; password_reset_required: boolean }>();
  return result || null;
}

export async function getUserByEmail(env: Env, email: string): Promise<{ id: string; email: string; role: string; created_at: string; password_reset_required?: boolean } | null> {
  const result = await env.AUTH_DB.prepare(
    `SELECT id, email, role, created_at, password_reset_required FROM user WHERE email = ?`
  )
    .bind(email)
    .first<{ id: string; email: string; role: string; created_at: string; password_reset_required: boolean }>();
  return result || null;
}

export async function getAllUsers(env: Env): Promise<{ id: string; email: string; role: string; created_at: string; password_reset_required?: boolean }[]> {
  const result = await env.AUTH_DB.prepare(
    `SELECT id, email, role, created_at, password_reset_required FROM user ORDER BY created_at DESC`
  )
    .all<{ id: string; email: string; role: string; created_at: string; password_reset_required: boolean }>();
  return result.results || [];
}

export async function createUser(env: Env, email: string, role: string = 'user'): Promise<{ id: string; email: string; role: string }> {
  const result = await env.AUTH_DB.prepare(
    `INSERT INTO user (email, role, password_reset_required) VALUES (?, ?, TRUE) RETURNING id, email, role`
  )
    .bind(email, role)
    .first<{ id: string; email: string; role: string }>();
  if (!result) {
    throw new Error(`Unable to create user: ${email}`);
  }
  return result;
}

export async function updateUser(env: Env, id: string, updates: { email?: string; role?: string }): Promise<{ id: string; email: string; role: string } | null> {
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
  
  const result = await env.AUTH_DB.prepare(
    `UPDATE user SET ${setParts.join(', ')} WHERE id = ? RETURNING id, email, role`
  )
    .bind(...values)
    .first<{ id: string; email: string; role: string }>();
    
  return result || null;
}

export async function deleteUser(env: Env, id: string): Promise<boolean> {
  const result = await env.AUTH_DB.prepare(
    `DELETE FROM user WHERE id = ?`
  )
    .bind(id)
    .run();
  return (result.meta?.changes || 0) > 0;
}

export async function clearPasswordResetRequired(env: Env, email: string): Promise<boolean> {
  const result = await env.AUTH_DB.prepare(
    `UPDATE user SET password_reset_required = FALSE WHERE email = ?`
  )
    .bind(email)
    .run();
  return (result.meta?.changes || 0) > 0;
}

export async function checkPasswordResetRequired(env: Env, email: string): Promise<boolean> {
  const result = await env.AUTH_DB.prepare(
    `SELECT password_reset_required FROM user WHERE email = ?`
  )
    .bind(email)
    .first<{ password_reset_required: boolean }>();
  return result?.password_reset_required || false;
}