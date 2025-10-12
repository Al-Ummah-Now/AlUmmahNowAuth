import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  getUserSession,
  createSession,
  deleteSession,
  getSessionTokenFromCookie,
  createSessionCookie,
  clearSessionCookie,
  type SessionData,
} from "./session";

describe("Session Management Functions", () => {
  beforeEach(async () => {
    // Clean up KV before each test
    const keys = await env.AUTH_STORAGE.list({ prefix: "session:" });
    for (const key of keys.keys) {
      await env.AUTH_STORAGE.delete(key.name);
    }
  });

  describe("getSessionTokenFromCookie", () => {
    it("should extract session token from cookie header", () => {
      const request = new Request("https://example.com", {
        headers: {
          Cookie: "auth_session=test-token-123; other=value",
        },
      });

      const token = getSessionTokenFromCookie(request);

      expect(token).toBe("test-token-123");
    });

    it("should return null when no cookie header present", () => {
      const request = new Request("https://example.com");

      const token = getSessionTokenFromCookie(request);

      expect(token).toBeNull();
    });

    it("should return null when auth_session cookie not present", () => {
      const request = new Request("https://example.com", {
        headers: {
          Cookie: "other=value; another=test",
        },
      });

      const token = getSessionTokenFromCookie(request);

      expect(token).toBeNull();
    });

    it("should handle cookie values with equals signs", () => {
      const request = new Request("https://example.com", {
        headers: {
          Cookie: "auth_session=token=with=equals; other=value",
        },
      });

      const token = getSessionTokenFromCookie(request);

      expect(token).toBe("token=with=equals");
    });
  });

  describe("createSession", () => {
    it("should create and store session in KV", async () => {
      const sessionData: SessionData = {
        user: {
          id: "user-123",
          email: "test@example.com",
          role: "user",
        },
        tokens: {
          access: "access-token-xyz",
          refresh: "refresh-token-abc",
        },
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      };

      const sessionToken = await createSession(env.AUTH_STORAGE, sessionData);

      expect(sessionToken).toBeDefined();
      expect(typeof sessionToken).toBe("string");

      // Verify session was stored in KV
      const storedData = await env.AUTH_STORAGE.get(`session:${sessionToken}`);
      expect(storedData).toBeDefined();

      const parsedData = JSON.parse(storedData!) as SessionData;
      expect(parsedData.user.id).toBe("user-123");
      expect(parsedData.user.email).toBe("test@example.com");
      expect(parsedData.tokens.access).toBe("access-token-xyz");
    });

    it("should generate unique session tokens", async () => {
      const sessionData: SessionData = {
        user: {
          id: "user-456",
          email: "another@example.com",
          role: "admin",
        },
        tokens: {
          access: "access-token-123",
        },
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      };

      const token1 = await createSession(env.AUTH_STORAGE, sessionData);
      const token2 = await createSession(env.AUTH_STORAGE, sessionData);

      expect(token1).not.toBe(token2);
    });
  });

  describe("getUserSession", () => {
    it("should retrieve session from KV", async () => {
      const sessionData: SessionData = {
        user: {
          id: "user-789",
          email: "retrieve@example.com",
          role: "moderator",
        },
        tokens: {
          access: "access-token-retrieve",
        },
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      };

      // Create session
      const sessionToken = await createSession(env.AUTH_STORAGE, sessionData);

      // Create request with session cookie
      const request = new Request("https://example.com", {
        headers: {
          Cookie: `auth_session=${sessionToken}`,
        },
      });

      // Retrieve session
      const retrievedSession = await getUserSession(request, env.AUTH_STORAGE);

      expect(retrievedSession).toBeDefined();
      expect(retrievedSession?.user.id).toBe("user-789");
      expect(retrievedSession?.user.email).toBe("retrieve@example.com");
      expect(retrievedSession?.user.role).toBe("moderator");
      expect(retrievedSession?.tokens.access).toBe("access-token-retrieve");
    });

    it("should return null when no cookie present", async () => {
      const request = new Request("https://example.com");

      const session = await getUserSession(request, env.AUTH_STORAGE);

      expect(session).toBeNull();
    });

    it("should return null when session not found in KV", async () => {
      const request = new Request("https://example.com", {
        headers: {
          Cookie: "auth_session=non-existent-token",
        },
      });

      const session = await getUserSession(request, env.AUTH_STORAGE);

      expect(session).toBeNull();
    });

    it("should handle expired sessions", async () => {
      const sessionData: SessionData = {
        user: {
          id: "user-expired",
          email: "expired@example.com",
          role: "user",
        },
        tokens: {
          access: "expired-access-token",
        },
        expiresAt: new Date(Date.now() - 1000).toISOString(), // Expired 1 second ago
      };

      // Create session
      const sessionToken = await createSession(env.AUTH_STORAGE, sessionData);

      // Create request with session cookie
      const request = new Request("https://example.com", {
        headers: {
          Cookie: `auth_session=${sessionToken}`,
        },
      });

      // Try to retrieve expired session
      const session = await getUserSession(request, env.AUTH_STORAGE);

      expect(session).toBeNull();

      // Verify session was deleted from KV
      const storedData = await env.AUTH_STORAGE.get(`session:${sessionToken}`);
      expect(storedData).toBeNull();
    });

    it("should handle corrupted JSON in session data", async () => {
      const sessionToken = "corrupted-token-123";

      // Store corrupted JSON in KV
      await env.AUTH_STORAGE.put(
        `session:${sessionToken}`,
        "{ invalid json data }{"
      );

      // Create request with corrupted session cookie
      const request = new Request("https://example.com", {
        headers: {
          Cookie: `auth_session=${sessionToken}`,
        },
      });

      // Try to retrieve session - should handle gracefully
      const session = await getUserSession(request, env.AUTH_STORAGE);

      expect(session).toBeNull();

      // Verify corrupted session was deleted
      const storedData = await env.AUTH_STORAGE.get(`session:${sessionToken}`);
      expect(storedData).toBeNull();
    });

    it("should handle session without expiresAt field", async () => {
      const sessionToken = "no-expiry-token";

      // Store session without expiresAt
      const partialSession = {
        user: {
          id: "user-no-expiry",
          email: "noexpiry@example.com",
          role: "user",
        },
        tokens: {
          access: "access-token-no-expiry",
        },
      };

      await env.AUTH_STORAGE.put(
        `session:${sessionToken}`,
        JSON.stringify(partialSession)
      );

      const request = new Request("https://example.com", {
        headers: {
          Cookie: `auth_session=${sessionToken}`,
        },
      });

      // Should retrieve session successfully (no expiry check)
      const session = await getUserSession(request, env.AUTH_STORAGE);

      expect(session).toBeDefined();
      expect(session?.user.id).toBe("user-no-expiry");
    });
  });

  describe("deleteSession", () => {
    it("should remove session from KV", async () => {
      const sessionData: SessionData = {
        user: {
          id: "user-delete",
          email: "delete@example.com",
          role: "user",
        },
        tokens: {
          access: "access-token-delete",
        },
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      };

      // Create session
      const sessionToken = await createSession(env.AUTH_STORAGE, sessionData);

      // Verify session exists
      let storedData = await env.AUTH_STORAGE.get(`session:${sessionToken}`);
      expect(storedData).toBeDefined();

      // Create request with session cookie
      const request = new Request("https://example.com", {
        headers: {
          Cookie: `auth_session=${sessionToken}`,
        },
      });

      // Delete session
      await deleteSession(request, env.AUTH_STORAGE);

      // Verify session was deleted
      storedData = await env.AUTH_STORAGE.get(`session:${sessionToken}`);
      expect(storedData).toBeNull();
    });

    it("should handle deletion when no cookie present", async () => {
      const request = new Request("https://example.com");

      // Should not throw error
      await expect(
        deleteSession(request, env.AUTH_STORAGE)
      ).resolves.toBeUndefined();
    });

    it("should handle deletion of non-existent session", async () => {
      const request = new Request("https://example.com", {
        headers: {
          Cookie: "auth_session=non-existent-session",
        },
      });

      // Should not throw error
      await expect(
        deleteSession(request, env.AUTH_STORAGE)
      ).resolves.toBeUndefined();
    });
  });

  describe("Cookie Helper Functions", () => {
    describe("createSessionCookie", () => {
      it("should create secure cookie for production", () => {
        const token = "test-token-456";

        const cookie = createSessionCookie(token, false);

        expect(cookie).toContain(`auth_session=${token}`);
        expect(cookie).toContain("Path=/");
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("Secure");
        expect(cookie).toContain("SameSite=Strict");
        expect(cookie).toContain(`Max-Age=${7 * 24 * 60 * 60}`);
      });

      it("should create non-secure cookie for localhost", () => {
        const token = "localhost-token-789";

        const cookie = createSessionCookie(token, true);

        expect(cookie).toContain(`auth_session=${token}`);
        expect(cookie).toContain("Path=/");
        expect(cookie).toContain("HttpOnly");
        expect(cookie).not.toContain("Secure");
        expect(cookie).toContain("SameSite=Strict");
      });
    });

    describe("clearSessionCookie", () => {
      it("should create cookie clearing header for production", () => {
        const cookie = clearSessionCookie(false);

        expect(cookie).toContain("auth_session=");
        expect(cookie).toContain("Path=/");
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("Secure");
        expect(cookie).toContain("Max-Age=0");
      });

      it("should create cookie clearing header for localhost", () => {
        const cookie = clearSessionCookie(true);

        expect(cookie).toContain("auth_session=");
        expect(cookie).not.toContain("Secure");
        expect(cookie).toContain("Max-Age=0");
      });
    });
  });
});
