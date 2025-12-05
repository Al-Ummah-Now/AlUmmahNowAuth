/**
 * E2E Tests for Token Revocation
 *
 * These tests verify that token revocation works end-to-end:
 * 1. User logs in and gets tokens
 * 2. Token is revoked via /token/revoke
 * 3. Introspection returns inactive
 * 4. Refresh with revoked token fails
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { issuer } from "@al-ummah-now/openauth";
import { createClient } from "@al-ummah-now/openauth/client";
import { MemoryStorage } from "@al-ummah-now/openauth/storage/memory";
import { createSubjects } from "@al-ummah-now/openauth/subject";
import type { Provider } from "@al-ummah-now/openauth/provider/provider";
import * as v from "valibot";
import "./test-setup"; // Setup database schema

// Mock logger
vi.mock("./logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Test subjects matching the app
const subjects = createSubjects({
  user: v.object({
    id: v.string(),
    email: v.pipe(v.string(), v.email()),
    roles: v.array(v.string()),
  }),
});

describe("Token Revocation E2E", () => {
  let app: ReturnType<typeof issuer>;
  let storage: ReturnType<typeof MemoryStorage>;
  const testClientId = "e2e-test-client";
  const testClientSecret = "e2e-test-secret-12345";
  const issuerUrl = "http://localhost";

  beforeAll(async () => {
    // Create OAuth client in database with proper PBKDF2 hash
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const saltHex = Array.from(salt)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Hash the secret using PBKDF2
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(testClientSecret),
      "PBKDF2",
      false,
      ["deriveBits"]
    );

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: 100000, // Must match OpenAuth default
        hash: "SHA-256",
      },
      keyMaterial,
      64 * 8
    );

    const hashHex = Array.from(new Uint8Array(derivedBits))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const secretHash = `${saltHex}:${hashHex}`;

    // Insert test client
    await env.AUTH_DB.prepare(
      `INSERT OR REPLACE INTO oauth_clients
       (id, client_id, client_secret_hash, client_type, allowed_grants, redirect_uris, created_at)
       VALUES (?, ?, ?, 'confidential', '["authorization_code","refresh_token"]', '["http://localhost:3000/callback"]', ?)`
    )
      .bind(testClientId, testClientId, secretHash, Date.now())
      .run();
  });

  beforeEach(() => {
    // Fresh storage for each test
    storage = MemoryStorage();

    // Create OpenAuth issuer with proper "dummy" provider pattern
    app = issuer({
      storage,
      subjects,
      clientDb: env.AUTH_DB,
      providers: {
        // Dummy provider that auto-completes authentication
        dummy: {
          type: "dummy",
          init(route, ctx) {
            route.get("/authorize", async (c) => {
              // This properly creates the auth code via OpenAuth's internal flow
              return ctx.success(c, {
                email: "test@example.com",
              });
            });
          },
        } satisfies Provider<{ email: string }>,
      },
      allow: async () => true,
      success: async (ctx, value) => {
        if (value.provider === "dummy") {
          return ctx.subject("user", {
            id: "test-user-123",
            email: value.email,
            roles: ["user"],
          });
        }
        throw new Error("Invalid provider");
      },
    });
  });

  /**
   * Helper to generate tokens using OpenAuth client
   */
  async function generateTokens(): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    // Create OpenAuth client that uses our app
    const client = createClient({
      issuer: issuerUrl,
      clientID: testClientId,
      fetch: (url, init) => app.fetch(new Request(url, init)),
    });

    // Start authorization flow
    const { challenge, url } = await client.authorize(
      "http://localhost:3000/callback",
      "code",
      { pkce: true }
    );

    // Execute authorization (first redirect)
    let response = await app.fetch(new Request(url));
    expect(response.status).toBe(302);

    // Follow redirect to provider with cookies
    const cookie = response.headers.get("set-cookie");
    const providerLocation = response.headers.get("location")!;
    // Handle relative URLs
    const providerUrl = providerLocation.startsWith("http")
      ? providerLocation
      : `${issuerUrl}${providerLocation}`;

    response = await app.fetch(
      new Request(providerUrl, {
        headers: cookie ? { cookie } : {},
      })
    );
    expect(response.status).toBe(302);

    // Extract code from callback redirect
    const callbackLocation = response.headers.get("location")!;
    // Handle relative URLs
    const location = new URL(
      callbackLocation.startsWith("http") ? callbackLocation : `${issuerUrl}${callbackLocation}`,
      issuerUrl
    );
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    // Exchange code for tokens manually to see actual errors
    const tokenResponse = await app.fetch(
      new Request(`${issuerUrl}/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          redirect_uri: "http://localhost:3000/callback",
          client_id: testClientId,
          code_verifier: challenge.verifier!, // Use verifier from challenge object
        }).toString(),
      })
    );

    if (tokenResponse.status !== 200) {
      const errorBody = await tokenResponse.text();
      throw new Error(`Token exchange failed: ${tokenResponse.status} - ${errorBody}`);
    }

    const tokens = await tokenResponse.json();
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    };
  }

  /**
   * Helper to create Basic auth header
   */
  function basicAuth(clientId: string, clientSecret: string): string {
    return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
  }

  it("should revoke access token and introspection returns inactive", async () => {
    // Step 1: Get tokens
    const { accessToken } = await generateTokens();

    // Step 2: Verify token is active via introspection
    const introspectResponse1 = await app.fetch(
      new Request("http://localhost/token/introspect", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: basicAuth(testClientId, testClientSecret),
        },
        body: new URLSearchParams({
          token: accessToken,
        }).toString(),
      })
    );

    expect(introspectResponse1.status).toBe(200);
    const introspect1 = await introspectResponse1.json();
    expect(introspect1.active).toBe(true);

    // Step 3: Revoke the access token
    const revokeResponse = await app.fetch(
      new Request("http://localhost/token/revoke", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: basicAuth(testClientId, testClientSecret),
        },
        body: new URLSearchParams({
          token: accessToken,
          token_type_hint: "access_token",
        }).toString(),
      })
    );

    // RFC 7009: Revocation always returns 200
    expect(revokeResponse.status).toBe(200);

    // Step 4: Verify token is now inactive via introspection
    const introspectResponse2 = await app.fetch(
      new Request("http://localhost/token/introspect", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: basicAuth(testClientId, testClientSecret),
        },
        body: new URLSearchParams({
          token: accessToken,
        }).toString(),
      })
    );

    expect(introspectResponse2.status).toBe(200);
    const introspect2 = await introspectResponse2.json();
    expect(introspect2.active).toBe(false); // Token should be inactive after revocation
  });

  it("should revoke refresh token and subsequent refresh fails", async () => {
    // Step 1: Get tokens
    const { refreshToken } = await generateTokens();

    // Step 2: Verify refresh works before revocation
    const refreshResponse1 = await app.fetch(
      new Request("http://localhost/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: testClientId,
        }).toString(),
      })
    );

    expect(refreshResponse1.status).toBe(200);
    const newTokens = await refreshResponse1.json();
    expect(newTokens.access_token).toBeTruthy();

    // Step 3: Revoke the refresh token
    const revokeResponse = await app.fetch(
      new Request("http://localhost/token/revoke", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: basicAuth(testClientId, testClientSecret),
        },
        body: new URLSearchParams({
          token: refreshToken,
          token_type_hint: "refresh_token",
        }).toString(),
      })
    );

    expect(revokeResponse.status).toBe(200);

    // Step 4: Try to use the revoked refresh token - should fail
    const refreshResponse2 = await app.fetch(
      new Request("http://localhost/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: testClientId,
        }).toString(),
      })
    );

    // Should fail because token was revoked
    expect(refreshResponse2.status).toBe(400);
    const error = await refreshResponse2.json();
    expect(error.error).toBe("invalid_grant");
  });

  it("should return 401 for introspection without client auth", async () => {
    const { accessToken } = await generateTokens();

    // Try introspection without credentials
    const response = await app.fetch(
      new Request("http://localhost/token/introspect", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          token: accessToken,
        }).toString(),
      })
    );

    // OpenAuth returns 401 for missing client credentials on introspection
    expect(response.status).toBe(401);
  });

  it("should return error for revocation without client auth", async () => {
    const { accessToken } = await generateTokens();

    // Try revocation without credentials
    const response = await app.fetch(
      new Request("http://localhost/token/revoke", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          token: accessToken,
        }).toString(),
      })
    );

    // OpenAuth returns 400 invalid_request for missing client credentials
    expect(response.status).toBe(400);
  });

  it("should handle introspection of invalid token gracefully", async () => {
    const response = await app.fetch(
      new Request("http://localhost/token/introspect", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: basicAuth(testClientId, testClientSecret),
        },
        body: new URLSearchParams({
          token: "invalid-token-that-does-not-exist",
        }).toString(),
      })
    );

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.active).toBe(false); // Invalid tokens are inactive
  });

  it("should handle revocation of non-existent token gracefully (RFC 7009)", async () => {
    // RFC 7009: Revocation of non-existent token should succeed (idempotent)
    const response = await app.fetch(
      new Request("http://localhost/token/revoke", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: basicAuth(testClientId, testClientSecret),
        },
        body: new URLSearchParams({
          token: "non-existent-token",
        }).toString(),
      })
    );

    // RFC 7009: Always return 200 for revocation
    expect(response.status).toBe(200);
  });
});
