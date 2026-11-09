import { describe, expect, it } from "vitest";
import { LOGIN_COOKIE, loginCookie, loginPath, parsePrompt, safeReturnPath, savedReturnPath, withPrompt } from "./sign-in";

describe("admin sign-in helpers", () => {
  it("safeReturnPath keeps same-origin paths and drops the rest", () => {
    expect(safeReturnPath("/users?page=2")).toBe("/users?page=2");
    for (const bad of [null, "", "https://evil.example", "//evil.example", "/\\evil", "/a\\b", "/x\r", "/login", "/auth/callback?x", "/logout"]) {
      expect(safeReturnPath(bad as string | null)).toBe("/");
    }
  });

  it("parsePrompt only allows none and login", () => {
    expect(parsePrompt("none")).toBe("none");
    expect(parsePrompt("login")).toBe("login");
    expect(parsePrompt("select_account")).toBeUndefined();
    expect(parsePrompt(null)).toBeUndefined();
  });

  it("loginPath and withPrompt", () => {
    expect(loginPath("/users?page=2")).toBe("/login?redirect=%2Fusers%3Fpage%3D2");
    expect(loginPath("/roles", "none")).toBe("/login?redirect=%2Froles&prompt=none");
    expect(withPrompt("https://auth.example/authorize?client_id=c")).toBe("https://auth.example/authorize?client_id=c");
    expect(new URL(withPrompt("https://auth.example/authorize?client_id=c", "login")).searchParams.get("prompt")).toBe("login");
  });

  it("the return path cookie only counts for its own state", () => {
    const pair = loginCookie("st", "/users").split(";")[0];
    expect(pair).toBe(`${LOGIN_COOKIE}=st.${encodeURIComponent("/users")}`);
    expect(loginCookie("st", "/")).toContain("Max-Age=600");
    expect(savedReturnPath(`a=b; ${pair}`, "st")).toBe("/users");
    expect(savedReturnPath(pair, "other")).toBe("/");
    expect(savedReturnPath(null, "st")).toBe("/");
  });
});
