import { logger } from './logger';

export async function getOrCreateUser(env: Env, email: string): Promise<{ id: string; role: string }> {
    logger.debug('getOrCreateUser called', { email });
    
    // First check if user already exists
    const existingUser = await env.AUTH_DB.prepare(
      `SELECT id, role FROM user WHERE email = ?`
    )
      .bind(email)
      .first<{ id: string; role: string }>();
    
    if (existingUser) {
      logger.info('Existing user found', { userId: existingUser.id, email, role: existingUser.role });
      return existingUser;
    }
    
    logger.info('Creating new user', { email });
    // Create new user (from login flow, not admin creation) - no password reset required
    const result = await env.AUTH_DB.prepare(
      `INSERT INTO user (email, role, password_reset_required) VALUES (?, 'user', FALSE) RETURNING id, role`
    )
      .bind(email)
      .first<{ id: string; role: string }>();
      
    if (!result) {
      logger.error('Failed to create user', { email });
      throw new Error(`Unable to process user: ${email}`);
    }
    
    logger.info('User created successfully', { userId: result.id, email, role: result.role });
    return result;
  }

export async function getUserById(env: Env, id: string): Promise<{ id: string; email: string; role: string; created_at: string; password_reset_required?: boolean } | null> {
  logger.debug('getUserById called', { userId: id });
  
  const result = await env.AUTH_DB.prepare(
    `SELECT id, email, role, created_at, password_reset_required FROM user WHERE id = ?`
  )
    .bind(id)
    .first<{ id: string; email: string; role: string; created_at: string; password_reset_required: boolean }>();
  
  if (result) {
    logger.debug('User found by ID', { userId: id, email: result.email, role: result.role });
  } else {
    logger.warn('User not found by ID', { userId: id });
  }
  
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
  logger.info('createUser called (admin action)', { email, role });
  
  const result = await env.AUTH_DB.prepare(
    `INSERT INTO user (email, role, password_reset_required) VALUES (?, ?, TRUE) RETURNING id, email, role`
  )
    .bind(email, role)
    .first<{ id: string; email: string; role: string }>();
  
  if (!result) {
    logger.error('Failed to create user (admin action)', { email, role });
    throw new Error(`Unable to create user: ${email}`);
  }
  
  logger.info('User created successfully (admin action)', { userId: result.id, email, role });
  return result;
}

export async function updateUser(env: Env, id: string, updates: { email?: string; role?: string }): Promise<{ id: string; email: string; role: string } | null> {
  logger.info('updateUser called', { userId: id, updates });
  
  const setParts: string[] = [];
  const values: any[] = [];
  
  if (updates.email !== undefined) {
    setParts.push('email = ?');
    values.push(updates.email);
  }
  
  if (updates.role !== undefined) {
    setParts.push('role = ?');
    values.push(updates.role);
    logger.info('Role change detected', { userId: id, newRole: updates.role });
  }
  
  if (setParts.length === 0) {
    logger.warn('updateUser called with no updates', { userId: id });
    throw new Error('No updates provided');
  }
  
  values.push(id);
  
  const result = await env.AUTH_DB.prepare(
    `UPDATE user SET ${setParts.join(', ')} WHERE id = ? RETURNING id, email, role`
  )
    .bind(...values)
    .first<{ id: string; email: string; role: string }>();
  
  if (result) {
    logger.info('User updated successfully', { userId: id, newEmail: result.email, newRole: result.role });
  } else {
    logger.error('User update failed - user not found', { userId: id });
  }
    
  return result || null;
}

export async function deleteUser(env: Env, id: string): Promise<boolean> {
  logger.warn('deleteUser called', { userId: id });
  
  const result = await env.AUTH_DB.prepare(
    `DELETE FROM user WHERE id = ?`
  )
    .bind(id)
    .run();
  
  const deleted = (result.meta?.changes || 0) > 0;
  
  if (deleted) {
    logger.info('User deleted successfully', { userId: id });
  } else {
    logger.warn('User deletion failed - user not found', { userId: id });
  }
  
  return deleted;
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
  logger.debug('checkPasswordResetRequired called', { email });
  
  const result = await env.AUTH_DB.prepare(
    `SELECT password_reset_required FROM user WHERE email = ?`
  )
    .bind(email)
    .first<{ password_reset_required: boolean }>();
  
  const resetRequired = result?.password_reset_required || false;
  
  if (resetRequired) {
    logger.info('Password reset required for user', { email });
  }
  
  return resetRequired;
}