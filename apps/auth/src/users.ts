import { logger } from './logger';
import * as v from 'valibot';

// Helper to fetch RBAC roles for a user
async function getUserRoles(env: Env, userId: string): Promise<string[]> {
  const rolesResult = await env.AUTH_DB.prepare(`
    SELECT r.name
    FROM user_roles ur
    JOIN roles r ON ur.role_id = r.id
    WHERE ur.user_id = ?
      AND ur.is_active = 1
      AND (ur.expires_at IS NULL OR ur.expires_at > datetime('now'))
    ORDER BY r.name
  `).bind(userId).all<{ name: string }>();

  return rolesResult.results?.map(r => r.name) || [];
}

// Overloaded signatures for backward compatibility
export async function getOrCreateUser(env: Env, email: string, returnIsNew: true): Promise<{ id: string; roles: string[]; isNew: boolean }>;
export async function getOrCreateUser(env: Env, email: string, returnIsNew?: false): Promise<{ id: string; roles: string[] }>;
export async function getOrCreateUser(env: Env, email: string, returnIsNew: boolean = false): Promise<{ id: string; roles: string[] } | { id: string; roles: string[]; isNew: boolean }> {
    logger.debug('getOrCreateUser called', { email });

    // First check if user already exists
    const existingUser = await env.AUTH_DB.prepare(
      `SELECT id FROM user WHERE email = ?`
    )
      .bind(email)
      .first<{ id: string }>();

    if (existingUser) {
      const roles = await getUserRoles(env, existingUser.id);
      logger.info('Existing user found', { userId: existingUser.id, email, roles });
      return returnIsNew ? { id: existingUser.id, roles, isNew: false } : { id: existingUser.id, roles };
    }

    logger.info('Creating new user', { email });
    // Create new user (from login flow, not admin creation) - no password reset required
    // Wrap in try-catch to handle race condition with concurrent requests
    try {
      const result = await env.AUTH_DB.prepare(
        `INSERT INTO user (email, password_reset_required) VALUES (?, FALSE) RETURNING id`
      )
        .bind(email)
        .first<{ id: string }>();

      if (!result) {
        logger.error('Failed to create user', { email });
        throw new Error(`Unable to process user: ${email}`);
      }

      // Assign default 'member' role in RBAC system (OpenAuth: role_member_default)
      await env.AUTH_DB.prepare(
        `INSERT INTO user_roles (user_id, role_id, granted_by, is_active)
         VALUES (?, 'role_member_default', 'system', 1)`
      ).bind(result.id).run();

      const roles = ['user']; // New users get 'user' role
      logger.info('User created successfully', { userId: result.id, email, roles });
      return returnIsNew ? { id: result.id, roles, isNew: true } : { id: result.id, roles };
    } catch (error) {
      // Check if this is a UNIQUE constraint violation (race condition)
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('UNIQUE') || errorMessage.includes('unique')) {
        logger.info('Race condition detected, fetching user created by concurrent request', { email });

        // Another request created the user, fetch it
        const concurrentUser = await env.AUTH_DB.prepare(
          `SELECT id FROM user WHERE email = ?`
        )
          .bind(email)
          .first<{ id: string }>();

        if (concurrentUser) {
          const roles = await getUserRoles(env, concurrentUser.id);
          logger.info('User fetched after race condition', { userId: concurrentUser.id, email, roles });
          return returnIsNew ? { id: concurrentUser.id, roles, isNew: false } : { id: concurrentUser.id, roles };
        }
      }

      // If not a race condition or fetch failed, rethrow
      logger.error('Failed to create or fetch user', { email, error: errorMessage });
      throw error;
    }
  }

export async function getUserById(env: Env, id: string): Promise<{ id: string; email: string; created_at: string; password_reset_required?: boolean } | null> {
  logger.debug('getUserById called', { userId: id });

  const result = await env.AUTH_DB.prepare(
    `SELECT id, email, created_at, password_reset_required FROM user WHERE id = ?`
  )
    .bind(id)
    .first<{ id: string; email: string; created_at: string; password_reset_required: boolean }>();

  if (result) {
    logger.debug('User found by ID', { userId: id, email: result.email });
  } else {
    logger.warn('User not found by ID', { userId: id });
  }

  return result || null;
}

export async function getUserByEmail(env: Env, email: string): Promise<{ id: string; email: string; created_at: string; password_reset_required?: boolean } | null> {
  const result = await env.AUTH_DB.prepare(
    `SELECT id, email, created_at, password_reset_required FROM user WHERE email = ?`
  )
    .bind(email)
    .first<{ id: string; email: string; created_at: string; password_reset_required: boolean }>();
  return result || null;
}

export async function getAllUsers(env: Env): Promise<{ id: string; email: string; created_at: string; password_reset_required?: boolean }[]> {
  const result = await env.AUTH_DB.prepare(
    `SELECT id, email, created_at, password_reset_required FROM user ORDER BY created_at DESC`
  )
    .all<{ id: string; email: string; created_at: string; password_reset_required: boolean }>();
  return result.results || [];
}

export async function createUser(env: Env, email: string, initialRole: string = 'user'): Promise<{ id: string; email: string }> {
  logger.info('createUser called (admin action)', { email, initialRole });

  const result = await env.AUTH_DB.prepare(
    `INSERT INTO user (email, password_reset_required) VALUES (?, TRUE) RETURNING id, email`
  )
    .bind(email)
    .first<{ id: string; email: string }>();

  if (!result) {
    logger.error('Failed to create user (admin action)', { email, initialRole });
    throw new Error(`Unable to create user: ${email}`);
  }

  // Assign RBAC role based on initialRole parameter (OpenAuth role IDs)
  const roleId = initialRole === 'admin' ? 'role_admin_default' : 'role_member_default';
  await env.AUTH_DB.prepare(
    `INSERT INTO user_roles (user_id, role_id, granted_by, is_active) VALUES (?, ?, 'system', 1)`
  ).bind(result.id, roleId).run();

  logger.info('User created successfully (admin action)', { userId: result.id, email, initialRole, roleId });
  return result;
}

/**
 * Validation schema for user updates
 * Ensures email format is valid
 */
const UpdateUserSchema = v.object({
  email: v.optional(v.pipe(v.string(), v.email('Invalid email format'))),
});

/**
 * Invalidate all sessions for a user
 *
 * Deletes all active sessions for a user from KV storage.
 * Used when a user's role changes to ensure they re-authenticate
 * with their new permissions.
 *
 * @param storage - Cloudflare KV namespace where sessions are stored
 * @param userId - The ID of the user whose sessions should be invalidated
 * @returns Number of sessions invalidated
 */
async function _invalidateUserSessions(storage: KVNamespace, userId: string): Promise<number> {
  logger.info('Invalidating all sessions for user', { userId });

  try {
    let invalidatedCount = 0;
    let cursor: string | undefined;
    let hasMore = true;

    // List all sessions (they are stored with prefix 'session:')
    while (hasMore) {
      const listResult = await storage.list({
        prefix: 'session:',
        cursor,
      });

      // Check each session to see if it belongs to the user
      for (const key of listResult.keys) {
        try {
          const sessionData = await storage.get(key.name);
          if (sessionData) {
            const session = JSON.parse(sessionData);

            // Check if this session belongs to the user
            if (session.user?.id === userId) {
              await storage.delete(key.name);
              invalidatedCount++;
              logger.debug('Session invalidated', { sessionKey: key.name, userId });
            }
          }
        } catch (error) {
          logger.warn('Failed to parse or delete session', {
            sessionKey: key.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Check if there are more results
      hasMore = !listResult.list_complete;
      cursor = hasMore ? (listResult as { cursor?: string }).cursor : undefined;
    }

    logger.info('Sessions invalidation complete', { userId, invalidatedCount });
    return invalidatedCount;
  } catch (error) {
    logger.error('Failed to invalidate user sessions', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Don't throw - session invalidation failure shouldn't block user updates
    return 0;
  }
}

export async function updateUser(env: Env, id: string, updates: { email?: string }): Promise<{ id: string; email: string } | null> {
  logger.info('updateUser called', { userId: id, updates });

  // Validate input with Valibot before processing
  try {
    v.parse(UpdateUserSchema, updates);
  } catch (error) {
    const validationError = error as v.ValiError<typeof UpdateUserSchema>;
    logger.error('User update validation failed', {
      userId: id,
      updates,
      errors: validationError.issues,
    });
    throw new Error(`Invalid user update data: ${validationError.issues.map(i => i.message).join(', ')}`);
  }

  if (updates.email === undefined) {
    logger.warn('updateUser called with no updates', { userId: id });
    throw new Error('No updates provided');
  }

  const result = await env.AUTH_DB.prepare(
    `UPDATE user SET email = ? WHERE id = ? RETURNING id, email`
  )
    .bind(updates.email, id)
    .first<{ id: string; email: string }>();

  if (result) {
    logger.info('User updated successfully', { userId: id, newEmail: result.email });
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