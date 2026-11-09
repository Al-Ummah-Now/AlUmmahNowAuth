import { describe, expect, it } from "vitest";
import {
  LOGIN_COOKIE,
  buildAuthorizeUrl,
  loginCookie,
  loginPath,
  parsePrompt,
  safeReturnPath,
  savedReturnPath,
} from "./sign-in";

describe("safeReturnPath", () => {
  it("keeps same-origin paths with their query", () => {
    expect(safeReturnPath("/")).toBe("/");
    expect(safeReturnPath("/?lang=ar")).toBe("/?lang=ar");
  });

  it("drops anything that could leave the app or loop", () => {
    for (const bad of [null, "", "https://evil.example/", "//evil.example", "/\\evil.example", "evil", "/a\\b", "/x\n", "/login?return=/", "/callback", "/logout"]) {
      expect(safeReturnPath(bad as string | null)).toBe("/");
    }
  });
});

describe("parsePrompt", () => {
  it("only allows none and login (never select_account on the normal path)", () => {
    expect(parsePrompt("none")).toBe("none");
    expect(parsePrompt("login")).toBe("login");
    expect(parsePrompt("select_account")).toBeUndefined();
    expect(parsePrompt("consent")).toBeUndefined();
    expect(parsePrompt(null)).toBeUndefined();
  });
});

describe("authorize URL", () => {
  const base = { authServerUrl: "https://auth.example", clientId: "c1", redirectUri: "https://p.example/callback", state: "s1" };

  it("has no prompt by default", () => {
    const url = new URL(buildAuthorizeUrl(base));
    expect(url.origin + url.pathname).toBe("https://auth.example/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "c1",
      redirect_uri: "https://p.example/callback",
      state: "s1",
    });
  });

  it("passes prompt=none / prompt=login through", () => {
    expect(new URL(buildAuthorizeUrl({ ...base, prompt: "none" })).searchParams.get("prompt")).toBe("none");
    expect(new URL(buildAuthorizeUrl({ ...base, prompt: "login" })).searchParams.get("prompt")).toBe("login");
  });

  it("loginPath encodes the return path and prompt", () => {
    expect(loginPath("/?lang=ar")).toBe("/login?return=%2F%3Flang%3Dar");
    expect(loginPath("https://evil.example", "none")).toBe("/login?return=%2F&prompt=none");
  });
});

describe("return path cookie", () => {
  const cookieHeader = (state: string, path: string) => loginCookie(state, path, false).split(";")[0];

  it("is HttpOnly, Secure, Lax and short-lived", () => {
    const c = loginCookie("s", "/", false);
    expect(c).toMatch(new RegExp(`^${LOGIN_COOKIE}=`));
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Max-Age=600");
    expect(loginCookie("s", "/", true)).not.toContain("Secure");
  });

  it("returns the saved path only when the state matches", () => {
    const header = `other=1; ${cookieHeader("state-1", "/?lang=ar")}`;
    expect(savedReturnPath(header, "state-1")).toBe("/?lang=ar");
    expect(savedReturnPath(header, "state-2")).toBe("/");
    expect(savedReturnPath(header, null)).toBe("/");
    expect(savedReturnPath(null, "state-1")).toBe("/");
    expect(savedReturnPath(`${LOGIN_COOKIE}=state-1.${encodeURIComponent("//evil.example")}`, "state-1")).toBe("/");
  });
});
