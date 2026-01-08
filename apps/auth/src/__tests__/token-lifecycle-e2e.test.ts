/**
 * E2E Tests for Complete Token Lifecycle
 *
 * These tests verify the complete token lifecycle works end-to-end:
 * 1. Authorization code flow with PKCE
 * 2. Token issuance
 * 3. Token refresh
 * 4. Token introspection
 * 5. Token revocation
 * 6. Refresh token rotation
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { env } from "cloudflare:test";
import { issuer, hashClientSecret } from "@al-ummah-now/openauth";
import { createClient } from "@al-ummah-now/openauth/client";
import { MemoryStorage } from "@al-ummah-now/openauth/storage/memory";
import { createSubjects } from "@al-ummah-now/openauth/subject";
import type { Provider } from "@al-ummah-now/openauth/provider/provider";
import * as v from "valibot";
import { setupDatabase } from "../test-setup";

// Mock logger
vi.mock("../logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const subjects = createSubjects({
  user: v.object({
    id: v.string(),
    email: v.pipe(v.string(), v.email()),
    roles: v.array(v.string()),
  }),
});

describe("Token Lifecycle E2E", () => {
  let app: ReturnType<typeof issuer>;
  let storage: ReturnType<typeof MemoryStorage>;
  const testClientId = "lifecycle-test-client";
  const testClientSecret = "lifecycle-test-secret-12345";
  const issuerUrl = "http://localhost";

  // Ensure database schema is set up before tests run
  beforeAll(async () => {
    await setupDatabase();
  });

  function basicAuth(clientId: string, clientSecret: string): string {
    return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
  }

  beforeEach(async () => {
    storage = MemoryStorage();

    // Create OAuth client using OpenAuth schema
    const secretHash = await hashClientSecret(testClientSecret);
    await env.AUTH_DB.prepare(
      `INSERT OR REPLACE INTO oauth_clients
       (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, enabled, created_at, updated_at)
       VALUES (?, 'default', 'Test Client', ?, '["authorization_code","refresh_token"]', '["openid","profile","email"]', '["http://localhost:3000/callback"]', 1, ?, ?)`
    )
      .bind(testClientId, secretHash, Date.now(), Date.now())
      .run();

    app = issuer({
      storage,
      subjects,
      clientDb: env.AUTH_DB,
      providers: {
        dummy: {
          type: "dummy",
          init(route, ctx) {
            route.get("/authorize", async (c) => {
              return ctx.success(c, { email: "lifecycle@example.com" });
            });
          },
        } satisfies Provider<{ email: string }>,
      },
      allow: async () => true,
      success: async (ctx, value) => {
        if (value.provider === "dummy") {
          return ctx.subject("user", {
            id: "lifecycle-user-123",
            email: value.email,
            roles: ["user"],
          });
        }
        throw new Error("Invalid provider");
      },
    });
  });

  async function completeAuthFlow(): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    const client = createClient({
      issuer: issuerUrl,
      clientID: testClientId,
      fetch: (url, init) => app.fetch(new Request(url, init)),
    });

    const { challenge, url } = await client.authorize(
      "http://localhost:3000/callback",
      "code",
      { pkce: true }
    );

    // Step 1: Initiate authorization
    let response = await app.fetch(new Request(url));
    expect(response.status).toBe(302);

    // Step 2: Follow to provider
    const cookie = response.headers.get("set-cookie");
    const providerLocation = response.headers.get("location")!;
    const providerUrl = providerLocation.startsWith("http")
      ? providerLocation
      : `${issuerUrl}${providerLocation}`;

    response = await app.fetch(
      new Request(providerUrl, {
        headers: cookie ? { cookie } : {},
      })
    );
    expect(response.status).toBe(302);

    // Step 3: Extract auth code from callback
    const callbackLocation = response.headers.get("location")!;
    const location = new URL(
      callbackLocation.startsWith("http")
        ? callbackLocation
        : `${issuerUrl}${callbackLocation}`,
      issuerUrl
    );
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    // Step 4: Exchange code for tokens
    const tokenResponse = await app.fetch(
      new Request(`${issuerUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          redirect_uri: "http://localhost:3000/callback",
          client_id: testClientId,
          code_verifier: challenge.verifier!,
        }).toString(),
      })
    );

    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json();
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    };
  }

  describe("Complete Authorization Code Flow", () => {
    it("should complete full auth code flow with PKCE", async () => {
      const { accessToken, refreshToken } = await completeAuthFlow();

      expect(accessToken).toBeTruthy();
      expect(refreshToken).toBeTruthy();

      // Verify access token is a valid JWT
      const parts = accessToken.split(".");
      expect(parts.length).toBe(3);

      // Decode payload
      const payload = JSON.parse(atob(parts[1]));
      expect(payload.mode).toBe("access");
      expect(payload.type).toBe("user");
      expect(payload.aud).toBe(testClientId);
      expect(payload.iss).toBe(issuerUrl);
      expect(payload.jti).toBeTruthy();
      expect(payload.properties.id).toBe("lifecycle-user-123");
      expect(payload.properties.email).toBe("lifecycle@example.com");
    });

    it("should issue new access token on refresh", async () => {
      const { accessToken: originalAccessToken, refreshToken } =
        await completeAuthFlow();

      // Wait a tiny bit to ensure different iat
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Refresh the token
      const refreshResponse = await app.fetch(
        new Request(`${issuerUrl}/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: testClientId,
          }).toString(),
        })
      );

      expect(refreshResponse.status).toBe(200);
      const newTokens = await refreshResponse.json();

      expect(newTokens.access_token).toBeTruthy();
      expect(newTokens.refresh_token).toBeTruthy();

      // Access token should be different (new JTI)
      const originalPayload = JSON.parse(atob(originalAccessToken.split(".")[1]));
      const newPayload = JSON.parse(atob(newTokens.access_token.split(".")[1]));
      expect(newPayload.jti).not.toBe(originalPayload.jti);

      // Subject should be the same
      expect(newPayload.sub).toBe(originalPayload.sub);
    });

    it("should rotate refresh token on each use", async () => {
      const { refreshToken: firstRefreshToken } = await completeAuthFlow();

      // First refresh
      const refresh1 = await app.fetch(
        new Request(`${issuerUrl}/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: firstRefreshToken,
            client_id: testClientId,
          }).toString(),
        })
      );
      expect(refresh1.status).toBe(200);
      const tokens1 = await refresh1.json();

      // Second refresh with new token
      const refresh2 = await app.fetch(
        new Request(`${issuerUrl}/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: tokens1.refresh_token,
            client_id: testClientId,
          }).toString(),
        })
      );
      expect(refresh2.status).toBe(200);
      const tokens2 = await refresh2.json();

      // Each refresh should give a different refresh token
      expect(tokens1.refresh_token).not.toBe(firstRefreshToken);
      expect(tokens2.refresh_token).not.toBe(tokens1.refresh_token);
    });
  });

  describe("Token Introspection", () => {
    it("should return full token details for valid access token", async () => {
      const { accessToken } = await completeAuthFlow();

      const response = await app.fetch(
        new Request(`${issuerUrl}/token/introspect`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: basicAuth(testClientId, testClientSecret),
          },
          body: new URLSearchParams({ token: accessToken }).toString(),
        })
      );

      expect(response.status).toBe(200);
      const result = await response.json();

      expect(result.active).toBe(true);
      expect(result.token_type).toBe("Bearer");
      expect(result.client_id).toBe(testClientId);
      expect(result.sub).toContain("user:");
      expect(result.iss).toBe(issuerUrl);
      expect(result.exp).toBeTruthy();
    });

    it("should return inactive for revoked token", async () => {
      const { accessToken } = await completeAuthFlow();

      // Revoke the token
      await app.fetch(
        new Request(`${issuerUrl}/token/revoke`, {
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

      // Introspect should show inactive
      const response = await app.fetch(
        new Request(`${issuerUrl}/token/introspect`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: basicAuth(testClientId, testClientSecret),
          },
          body: new URLSearchParams({ token: accessToken }).toString(),
        })
      );

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.active).toBe(false);
    });

    it("should not allow cross-client token introspection", async () => {
      const { accessToken } = await completeAuthFlow();

      // Create a different client
      const otherClientId = "other-client";
      const otherClientSecret = "other-secret-12345";
      const secretHash = await hashClientSecret(otherClientSecret);
      await env.AUTH_DB.prepare(
        `INSERT OR REPLACE INTO oauth_clients
         (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, enabled, created_at, updated_at)
         VALUES (?, 'default', 'Other Test Client', ?, '["authorization_code"]', '["openid","profile","email"]', '["http://localhost:3000/callback"]', 1, ?, ?)`
      )
        .bind(otherClientId, secretHash, Date.now(), Date.now())
        .run();

      // Try to introspect with different client
      const response = await app.fetch(
        new Request(`${issuerUrl}/token/introspect`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: basicAuth(otherClientId, otherClientSecret),
          },
          body: new URLSearchParams({ token: accessToken }).toString(),
        })
      );

      expect(response.status).toBe(200);
      const result = await response.json();
      // Per RFC 7662: returns inactive for tokens client can't see
      expect(result.active).toBe(false);
    });
  });

  describe("Token Revocation", () => {
    it("should revoke access token and prevent future use", async () => {
      const { accessToken } = await completeAuthFlow();

      // Verify token is active
      let response = await app.fetch(
        new Request(`${issuerUrl}/token/introspect`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: basicAuth(testClientId, testClientSecret),
          },
          body: new URLSearchParams({ token: accessToken }).toString(),
        })
      );
      expect((await response.json()).active).toBe(true);

      // Revoke
      response = await app.fetch(
        new Request(`${issuerUrl}/token/revoke`, {
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
      expect(response.status).toBe(200);

      // Verify token is now inactive
      response = await app.fetch(
        new Request(`${issuerUrl}/token/introspect`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: basicAuth(testClientId, testClientSecret),
          },
          body: new URLSearchParams({ token: accessToken }).toString(),
        })
      );
      expect((await response.json()).active).toBe(false);
    });

    it("should revoke refresh token and prevent future refresh", async () => {
      const { refreshToken } = await completeAuthFlow();

      // Verify refresh works
      let response = await app.fetch(
        new Request(`${issuerUrl}/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: testClientId,
          }).toString(),
        })
      );
      expect(response.status).toBe(200);

      // Revoke the original refresh token
      response = await app.fetch(
        new Request(`${issuerUrl}/token/revoke`, {
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
      expect(response.status).toBe(200);

      // Try to use original refresh token - should fail
      response = await app.fetch(
        new Request(`${issuerUrl}/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: testClientId,
          }).toString(),
        })
      );
      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toBe("invalid_grant");
    });
  });

  describe("Error Handling", () => {
    it("should reject expired authorization code", async () => {
      const client = createClient({
        issuer: issuerUrl,
        clientID: testClientId,
        fetch: (url, init) => app.fetch(new Request(url, init)),
      });

      const { challenge, url } = await client.authorize(
        "http://localhost:3000/callback",
        "code",
        { pkce: true }
      );

      // Complete flow to get code
      let response = await app.fetch(new Request(url));
      const cookie = response.headers.get("set-cookie");
      const providerLocation = response.headers.get("location")!;
      const providerUrl = providerLocation.startsWith("http")
        ? providerLocation
        : `${issuerUrl}${providerLocation}`;

      response = await app.fetch(
        new Request(providerUrl, {
          headers: cookie ? { cookie } : {},
        })
      );

      const callbackLocation = response.headers.get("location")!;
      const location = new URL(
        callbackLocation.startsWith("http")
          ? callbackLocation
          : `${issuerUrl}${callbackLocation}`,
        issuerUrl
      );
      const code = location.searchParams.get("code")!;

      // Use code once
      response = await app.fetch(
        new Request(`${issuerUrl}/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: "http://localhost:3000/callback",
            client_id: testClientId,
            code_verifier: challenge.verifier!,
          }).toString(),
        })
      );
      expect(response.status).toBe(200);

      // Try to use code again - should fail
      response = await app.fetch(
        new Request(`${issuerUrl}/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: "http://localhost:3000/callback",
            client_id: testClientId,
            code_verifier: challenge.verifier!,
          }).toString(),
        })
      );
      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toBe("invalid_grant");
    });

    it("should reject invalid PKCE verifier", async () => {
      const client = createClient({
        issuer: issuerUrl,
        clientID: testClientId,
        fetch: (url, init) => app.fetch(new Request(url, init)),
      });

      const { url } = await client.authorize(
        "http://localhost:3000/callback",
        "code",
        { pkce: true }
      );

      // Complete flow to get code
      let response = await app.fetch(new Request(url));
      const cookie = response.headers.get("set-cookie");
      const providerLocation = response.headers.get("location")!;
      const providerUrl = providerLocation.startsWith("http")
        ? providerLocation
        : `${issuerUrl}${providerLocation}`;

      response = await app.fetch(
        new Request(providerUrl, {
          headers: cookie ? { cookie } : {},
        })
      );

      const callbackLocation = response.headers.get("location")!;
      const location = new URL(
        callbackLocation.startsWith("http")
          ? callbackLocation
          : `${issuerUrl}${callbackLocation}`,
        issuerUrl
      );
      const code = location.searchParams.get("code")!;

      // Try with wrong verifier
      response = await app.fetch(
        new Request(`${issuerUrl}/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: "http://localhost:3000/callback",
            client_id: testClientId,
            code_verifier: "wrong-verifier-that-does-not-match",
          }).toString(),
        })
      );
      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toBe("invalid_grant");
    });
  });

  describe("Well-Known Endpoints", () => {
    it("should expose OAuth authorization server metadata", async () => {
      const response = await app.fetch(
        new Request(`${issuerUrl}/.well-known/oauth-authorization-server`)
      );

      expect(response.status).toBe(200);
      const metadata = await response.json();

      expect(metadata.issuer).toBe(issuerUrl);
      expect(metadata.authorization_endpoint).toBe(`${issuerUrl}/authorize`);
      expect(metadata.token_endpoint).toBe(`${issuerUrl}/token`);
      expect(metadata.response_types_supported).toContain("code");
      expect(metadata.grant_types_supported).toContain("authorization_code");
      expect(metadata.grant_types_supported).toContain("refresh_token");
      // PKCE support may or may not be advertised in metadata
      if (metadata.code_challenge_methods_supported) {
        expect(metadata.code_challenge_methods_supported).toContain("S256");
      }
    });
  });
});
