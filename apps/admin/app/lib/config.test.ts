/**
 * getAuthServerUrl: AUTH_SERVER_URL from the Worker's vars decides the Auth origin everywhere, local dev
 * included (it used to be overridden by a hard-coded localhost:3301 on localhost).
 */
import { describe, expect, it } from "vitest";
import { getAuthServerUrl, LOCAL_AUTH_SERVER_URL } from "./config";

const req = (url: string) => new Request(url);

describe("getAuthServerUrl", () => {
  it("uses AUTH_SERVER_URL on a local admin, so dev can point at another Auth server", () => {
    expect(getAuthServerUrl(req("http://localhost:3303/"), { AUTH_SERVER_URL: "http://localhost:3401" })).toBe("http://localhost:3401");
    expect(getAuthServerUrl(req("http://127.0.0.1:3303/"), { AUTH_SERVER_URL: "https://auth.qa.alummahnow.net" })).toBe("https://auth.qa.alummahnow.net");
  });

  it("uses AUTH_SERVER_URL on a deployed admin", () => {
    expect(getAuthServerUrl(req("https://admin.auth.qa.alummahnow.net/"), { AUTH_SERVER_URL: "https://auth.qa.alummahnow.net" })).toBe("https://auth.qa.alummahnow.net");
  });

  it("falls back to the local Auth server on localhost, and to production elsewhere", () => {
    expect(LOCAL_AUTH_SERVER_URL).toBe("http://localhost:3301");
    expect(getAuthServerUrl(req("http://localhost:3303/"), {})).toBe(LOCAL_AUTH_SERVER_URL);
    expect(getAuthServerUrl(req("http://127.0.0.1:3303/"))).toBe(LOCAL_AUTH_SERVER_URL);
    expect(getAuthServerUrl(req("https://admin.example.net/"), {})).toBe("https://auth.alummahnow.net");
    expect(getAuthServerUrl()).toBe("https://auth.alummahnow.net");
  });
});
