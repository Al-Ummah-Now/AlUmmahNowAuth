import { afterEach, describe, expect, it, vi } from "vitest";
import { clientSecretFor, getOpenAuthClient } from "./openauth.client.server";

const ID = "1448ed27-39a6-417d-b4c8-07f881e81269";
const env = { AUTH_SERVER_URL: "https://auth.test", ADMIN_CLIENT_ID: ID, ADMIN_CLIENT_SECRET: "s3cret" };

afterEach(() => vi.unstubAllGlobals());

describe("the admin authenticates as a confidential client (#211)", () => {
  it("uses ADMIN_CLIENT_SECRET only for ADMIN_CLIENT_ID", () => {
    expect(clientSecretFor(ID, env)).toBe("s3cret");
    expect(clientSecretFor("someone-else", env)).toBeUndefined();
    expect(clientSecretFor(ID, { ADMIN_CLIENT_ID: ID })).toBeUndefined();
  });

  it("sends HTTP Basic credentials on the code exchange and the refresh", async () => {
    const seen: Array<{ auth: string | null; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push({ auth: new Headers(init.headers).get("Authorization"), body: String(init.body) });
        return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 60 }), { status: 200 });
      }),
    );
    const client = getOpenAuthClient(undefined, { ...env, AUTH_SERVER_URL: "https://auth.secret.test" });
    await client.exchange("code", "https://admin.test/auth/callback", "verifier");
    await client.refresh("user:tok");
    const basic = `Basic ${btoa(`${ID}:s3cret`)}`;
    expect(seen.map((s) => s.auth)).toEqual([basic, basic]);
    expect(seen[0].body).toContain("grant_type=authorization_code");
    expect(seen[1].body).toContain("grant_type=refresh_token");
  });

  it("sends no credentials without the secret", async () => {
    const auths: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        auths.push(new Headers(init.headers).get("Authorization"));
        return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 60 }), { status: 200 });
      }),
    );
    const client = getOpenAuthClient(undefined, { AUTH_SERVER_URL: "https://auth.public.test", ADMIN_CLIENT_ID: ID });
    await client.refresh("user:tok");
    expect(auths).toEqual([null]);
  });
});
