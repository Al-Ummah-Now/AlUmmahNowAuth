import { logger } from '../logger';

/**
 * Helper to fetch RBAC roles for a user
 *
 * @param db - D1 database instance
 * @param userId - The user ID to fetch roles for
 * @returns Array of role names assigned to the user
 */
async function getUserRoles(db: D1Database, userId: string): Promise<string[]> {
  const rolesResult = await db.prepare(`
    SELECT r.name
    FROM rbac_user_roles ur
    JOIN rbac_roles r ON ur.role_id = r.id
    WHERE ur.user_id = ?
      AND (ur.expires_at IS NULL OR ur.expires_at > unixepoch() * 1000)
    ORDER BY r.name
  `).bind(userId).all<{ name: string }>();

  return rolesResult.results?.map(r => r.name) || [];
}

/**
 * Get or create a user by email, handling race conditions
 *
 * This function is NOT in OpenAuth's UserService. It handles the specific
 * case where multiple concurrent requests might try to create the same user,
 * and ensures consistent behavior with proper race condition handling.
 *
 * When a new user is created through the login flow, they are assigned the
 * default 'member' role and password_reset_required is set to FALSE.
 *
 * @param db - D1 database instance
 * @param tenantId - The tenant ID (typically 'default')
 * @param email - The user's email address
 * @param returnIsNew - Whether to include the isNew flag in the response
 * @returns User object with id, roles, and optionally isNew flag
 */
export async function getOrCreateUser(db: D1Database, tenantId: string, email: string, returnIsNew: true): Promise<{ id: string; roles: string[]; isNew: boolean }>;
export async function getOrCreateUser(db: D1Database, tenantId: string, email: string, returnIsNew?: false): Promise<{ id: string; roles: string[] }>;
export async function getOrCreateUser(db: D1Database, tenantId: string, email: string, returnIsNew: boolean = false): Promise<{ id: string; roles: string[] } | { id: string; roles: string[]; isNew: boolean }> {
  logger.debug('getOrCreateUser called', { email, tenantId });

  // First check if user already exists
  const existingUser = await db.prepare(
    `SELECT id FROM users WHERE email = ?`
  )
    .bind(email)
    .first<{ id: string }>();

  if (existingUser) {
    const roles = await getUserRoles(db, existingUser.id);
    logger.info('Existing user found', { userId: existingUser.id, email, roles });
    return returnIsNew ? { id: existingUser.id, roles, isNew: false } : { id: existingUser.id, roles };
  }

  logger.info('Creating new user', { email });
  // Create new user (from login flow, not admin creation) - no password reset required
  // Wrap in try-catch to handle race condition with concurrent requests
  try {
    const result = await db.prepare(
      `INSERT INTO users (email, password_reset_required) VALUES (?, FALSE) RETURNING id`
    )
      .bind(email)
      .first<{ id: string }>();

    if (!result) {
      logger.error('Failed to create user', { email });
      throw new Error(`Unable to process user: ${email}`);
    }

    // Assign default 'member' role in RBAC system (OpenAuth: role_member_default)
    await db.prepare(
      `INSERT INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by)
       VALUES (?, 'role_member_default', ?, unixepoch() * 1000, 'system')`
    ).bind(result.id, tenantId).run();

    // Fetch the actual role we just assigned
    const roles = await getUserRoles(db, result.id);
    logger.info('User created successfully', { userId: result.id, email, roles });
    return returnIsNew ? { id: result.id, roles, isNew: true } : { id: result.id, roles };
  } catch (error) {
    // Check if this is a UNIQUE constraint violation (race condition)
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('UNIQUE') || errorMessage.includes('unique')) {
      logger.info('Race condition detected, fetching user created by concurrent request', { email });

      // Another request created the user, fetch it
      const concurrentUser = await db.prepare(
        `SELECT id FROM users WHERE email = ?`
      )
        .bind(email)
        .first<{ id: string }>();

      if (concurrentUser) {
        const roles = await getUserRoles(db, concurrentUser.id);
        logger.info('User fetched after race condition', { userId: concurrentUser.id, email, roles });
        return returnIsNew ? { id: concurrentUser.id, roles, isNew: false } : { id: concurrentUser.id, roles };
      }
    }

    // If not a race condition or fetch failed, rethrow
    logger.error('Failed to create or fetch user', { email, error: errorMessage });
    throw error;
  }
}

/**
 * Check if a user needs to reset their password
 *
 * This function checks the password_reset_required flag for a user.
 * This flag is set when an admin creates a user, requiring them to
 * set a password on first login.
 *
 * @param db - D1 database instance
 * @param email - The user's email address
 * @returns True if password reset is required, false otherwise
 */
export async function checkPasswordResetRequired(db: D1Database, email: string): Promise<boolean> {
  logger.debug('checkPasswordResetRequired called', { email });

  const result = await db.prepare(
    `SELECT password_reset_required FROM users WHERE email = ?`
  )
    .bind(email)
    .first<{ password_reset_required: boolean }>();

  const resetRequired = result?.password_reset_required || false;

  if (resetRequired) {
    logger.info('Password reset required for user', { email });
  }

  return resetRequired;
}

/**
 * Clear the password reset required flag for a user
 *
 * This function is called after a user successfully sets their password
 * for the first time (when created by an admin).
 *
 * @param db - D1 database instance
 * @param email - The user's email address
 * @returns True if the flag was cleared, false if user not found
 */
export async function clearPasswordResetRequired(db: D1Database, email: string): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE users SET password_reset_required = FALSE WHERE email = ?`
  )
    .bind(email)
    .run();
  return (result.meta?.changes || 0) > 0;
}
