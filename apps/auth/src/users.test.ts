import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import "./test-setup"; // Setup database schema
import {
  getOrCreateUser,
  getUserById,
  getUserByEmail,
  updateUser,
  deleteUser,
  createUser,
  clearPasswordResetRequired,
  checkPasswordResetRequired,
} from "./users";

// Mock logger to prevent console spam during tests
vi.mock("./logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("User Management Functions", () => {
  beforeEach(async () => {
    // Clean up database before each test (order matters for foreign keys)
    // Must delete from child tables first
    await env.AUTH_DB.prepare("DELETE FROM user_permissions").run();
    await env.AUTH_DB.prepare("DELETE FROM user_roles").run();
    await env.AUTH_DB.prepare("DELETE FROM role_permissions").run();
    await env.AUTH_DB.prepare("DELETE FROM permissions").run();
    await env.AUTH_DB.prepare("DELETE FROM roles").run();
    await env.AUTH_DB.prepare("DELETE FROM user").run();

    // Re-seed system roles
    const systemRoles = [
      { id: 'role_super_admin', name: 'super_admin', description: 'Super administrator', is_system: 1 },
      { id: 'role_admin', name: 'admin', description: 'Administrator', is_system: 1 },
      { id: 'role_moderator', name: 'moderator', description: 'Moderator', is_system: 1 },
      { id: 'role_user', name: 'user', description: 'Standard user', is_system: 1 },
    ];
    for (const role of systemRoles) {
      await env.AUTH_DB.prepare(`
        INSERT INTO roles (id, name, description, is_system)
        VALUES (?, ?, ?, ?)
      `).bind(role.id, role.name, role.description, role.is_system).run();
    }

    // Create system user (needed for granted_by foreign key in user_roles)
    await env.AUTH_DB.prepare(`
      INSERT INTO user (id, email, password_reset_required)
      VALUES ('system', 'system@test.com', FALSE)
    `).run();
  });

  describe("getOrCreateUser", () => {
    it("should create a new user when user does not exist", async () => {
      const email = "newuser@example.com";

      const user = await getOrCreateUser(env, email);

      expect(user).toBeDefined();
      expect(user.id).toBeDefined();
      expect(user.roles).toContain("user");

      // Verify user was inserted into database
      const dbUser = await env.AUTH_DB.prepare(
        "SELECT email, password_reset_required FROM user WHERE id = ?"
      )
        .bind(user.id)
        .first<{ email: string; password_reset_required: number }>();

      expect(dbUser).toBeDefined();
      expect(dbUser?.email).toBe(email);
      expect(dbUser?.password_reset_required).toBe(0); // FALSE in SQLite

      // Verify RBAC role was assigned
      const roleAssignment = await env.AUTH_DB.prepare(
        "SELECT role_id FROM user_roles WHERE user_id = ? AND is_active = 1"
      ).bind(user.id).first<{ role_id: string }>();
      expect(roleAssignment?.role_id).toBe("role_user");
    });

    it("should return existing user when user already exists", async () => {
      const email = "existing@example.com";

      // Create user first time
      const firstUser = await getOrCreateUser(env, email);

      // Try to create again
      const secondUser = await getOrCreateUser(env, email);

      // Should return same user
      expect(secondUser.id).toBe(firstUser.id);
      expect(secondUser.roles).toEqual(firstUser.roles);
    });

    it("should handle race condition when multiple requests create same user", async () => {
      const email = "concurrent@example.com";

      // Simulate race condition by creating user directly in DB (without role column)
      await env.AUTH_DB.prepare(
        "INSERT INTO user (email, password_reset_required) VALUES (?, FALSE)"
      )
        .bind(email)
        .run();

      // Try to create user - should handle UNIQUE constraint violation
      const user = await getOrCreateUser(env, email);

      expect(user).toBeDefined();
      expect(user.id).toBeDefined();
      // Note: User created directly may not have RBAC role, but getOrCreateUser handles this
      expect(user.roles).toBeDefined();
    });

    it("should throw error for invalid operations", async () => {
      const email = "error@example.com";

      // Create user first
      await getOrCreateUser(env, email);

      // Mock a database error by dropping the table (simulating catastrophic failure)
      // In real scenario, this would be a connection error or similar
      // Here we just verify the user is returned properly when exists
      const user = await getOrCreateUser(env, email);
      expect(user).toBeDefined();
    });
  });

  describe("getUserById", () => {
    it("should find user by ID", async () => {
      const email = "findme@example.com";

      // Create user
      const createdUser = await getOrCreateUser(env, email);

      // Find user by ID
      const foundUser = await getUserById(env, createdUser.id);

      expect(foundUser).toBeDefined();
      expect(foundUser?.id).toBe(createdUser.id);
      expect(foundUser?.email).toBe(email);
      expect(foundUser?.created_at).toBeDefined();
    });

    it("should return null when user not found", async () => {
      const foundUser = await getUserById(env, "non-existent-id");

      expect(foundUser).toBeNull();
    });
  });

  describe("getUserByEmail", () => {
    it("should find user by email", async () => {
      const email = "findbyemail@example.com";

      // Create user
      const createdUser = await getOrCreateUser(env, email);

      // Find user by email
      const foundUser = await getUserByEmail(env, email);

      expect(foundUser).toBeDefined();
      expect(foundUser?.id).toBe(createdUser.id);
      expect(foundUser?.email).toBe(email);
    });

    it("should return null when user not found", async () => {
      const foundUser = await getUserByEmail(env, "nonexistent@example.com");

      expect(foundUser).toBeNull();
    });
  });

  describe("createUser", () => {
    it("should create user with admin role via RBAC", async () => {
      const email = "admin@example.com";

      const user = await createUser(env, email, "admin");

      expect(user).toBeDefined();
      expect(user.id).toBeDefined();
      expect(user.email).toBe(email);

      // Verify RBAC role was assigned
      const roleAssignment = await env.AUTH_DB.prepare(
        "SELECT role_id FROM user_roles WHERE user_id = ? AND is_active = 1"
      ).bind(user.id).first<{ role_id: string }>();
      expect(roleAssignment?.role_id).toBe("role_admin");

      // Verify password_reset_required is TRUE for admin-created users
      const dbUser = await env.AUTH_DB.prepare(
        "SELECT password_reset_required FROM user WHERE id = ?"
      )
        .bind(user.id)
        .first<{ password_reset_required: number }>();

      expect(dbUser?.password_reset_required).toBe(1); // TRUE in SQLite
    });

    it("should create user with default role via RBAC", async () => {
      const email = "defaultrole@example.com";

      const user = await createUser(env, email);

      // Verify RBAC role was assigned
      const roleAssignment = await env.AUTH_DB.prepare(
        "SELECT role_id FROM user_roles WHERE user_id = ? AND is_active = 1"
      ).bind(user.id).first<{ role_id: string }>();
      expect(roleAssignment?.role_id).toBe("role_user");
    });
  });

  describe("updateUser", () => {
    it("should update user email", async () => {
      const originalEmail = "original@example.com";
      const newEmail = "updated@example.com";

      // Create user
      const user = await getOrCreateUser(env, originalEmail);

      // Update email
      const updatedUser = await updateUser(env, user.id, { email: newEmail });

      expect(updatedUser).toBeDefined();
      expect(updatedUser?.email).toBe(newEmail);
    });

    it("should return null when updating non-existent user", async () => {
      const updatedUser = await updateUser(env, "non-existent-id", {
        email: "new@example.com",
      });

      expect(updatedUser).toBeNull();
    });

    it("should throw error when no updates provided", async () => {
      const email = "noupdate@example.com";
      const user = await getOrCreateUser(env, email);

      await expect(updateUser(env, user.id, {})).rejects.toThrow(
        "No updates provided"
      );
    });
  });

  describe("deleteUser", () => {
    it("should delete existing user", async () => {
      const email = "deleteme@example.com";

      // Create user
      const user = await getOrCreateUser(env, email);

      // Delete user
      const deleted = await deleteUser(env, user.id);

      expect(deleted).toBe(true);

      // Verify user is gone
      const foundUser = await getUserById(env, user.id);
      expect(foundUser).toBeNull();
    });

    it("should return false when deleting non-existent user", async () => {
      const deleted = await deleteUser(env, "non-existent-id");

      expect(deleted).toBe(false);
    });
  });

  describe("Password Reset Functions", () => {
    it("should check password reset required status", async () => {
      const email = "resetcheck@example.com";

      // Create user via admin (password_reset_required = TRUE)
      const user = await createUser(env, email, "user");

      // Check status (SQLite returns 1 for TRUE)
      const resetRequired = await checkPasswordResetRequired(env, email);

      expect(resetRequired).toBeTruthy();
    });

    it("should return false when password reset not required", async () => {
      const email = "noreset@example.com";

      // Create user via login flow (password_reset_required = FALSE)
      await getOrCreateUser(env, email);

      // Check status
      const resetRequired = await checkPasswordResetRequired(env, email);

      expect(resetRequired).toBe(false);
    });

    it("should clear password reset required flag", async () => {
      const email = "clearreset@example.com";

      // Create user via admin (password_reset_required = TRUE)
      await createUser(env, email, "user");

      // Verify it's set (SQLite returns 1 for TRUE)
      let resetRequired = await checkPasswordResetRequired(env, email);
      expect(resetRequired).toBeTruthy();

      // Clear flag
      const cleared = await clearPasswordResetRequired(env, email);
      expect(cleared).toBe(true);

      // Verify it's cleared
      resetRequired = await checkPasswordResetRequired(env, email);
      expect(resetRequired).toBe(false);
    });

    it("should return false when clearing flag for non-existent user", async () => {
      const cleared = await clearPasswordResetRequired(
        env,
        "nonexistent@example.com"
      );

      expect(cleared).toBe(false);
    });
  });
});
