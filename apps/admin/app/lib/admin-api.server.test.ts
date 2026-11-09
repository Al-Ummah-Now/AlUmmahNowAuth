import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTokenCache, deleteUser, getUser, isErrorResponse, type ActingUser } from "./admin-api.server";

const env = {
  AUTH_SERVER_URL: "https://auth.example.test",
  ADMIN_CLIENT_ID: "admin-client",
  ADMIN_CLIENT_SECRET: "admin-secret",
};
const actingUser: ActingUser = { id: "usr_admin", email: "admin@example.test", roles: ["admin"] };

/** Answers the M2M token request, then hands every other request to `api`. */
function mockAuthServer(api: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/token")) {
      return Response.json({ access_token: "m2m-token", token_type: "Bearer", expires_in: 3600 });
    }
    return api(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("admin API client", () => {
  beforeEach(() => clearTokenCache());
  afterEach(() => vi.unstubAllGlobals());

  it("deleteUser reports success when the auth server answers 204 No Content", async () => {
    const fetchMock = mockAuthServer(() => new Response(null, { status: 204 }));

    const result = await deleteUser(env, actingUser, "usr_123");

    // Was { error: "Unexpected end of JSON input" }: the empty 204 body was parsed as JSON
    expect(result).toEqual({ success: true });
    expect(isErrorResponse(result)).toBe(false);
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(url)).toBe("https://auth.example.test/admin/users/usr_123");
    expect(init?.method).toBe("DELETE");
  });

  it("deleteUser still reports the auth server's error", async () => {
    mockAuthServer(() => Response.json({ error: "not_found", error_description: "User not found" }, { status: 404 }));

    expect(await deleteUser(env, actingUser, "usr_missing")).toEqual({ error: "User not found" });
  });

  it("other calls still return the JSON body", async () => {
    const user = { id: "usr_123", email: "u@example.test" };
    mockAuthServer(() => Response.json(user));

    expect(await getUser(env, actingUser, "usr_123")).toEqual(user);
  });
});
