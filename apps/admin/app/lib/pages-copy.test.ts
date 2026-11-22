/**
 * The user Passkeys page's English copy uses typographic quotes (’ “ ”), like the sign-in pages
 * (Auth passkey-wording.test.ts). A straight ' or " in any of its strings fails here.
 */
import { describe, expect, it } from "vitest";
import { pagesCopy } from "./pages-copy";

/** Every string in a copy block, functions called with a sample value. */
function strings(value: unknown, path = ""): Array<[string, string]> {
  if (typeof value === "string") return [[path, value]];
  if (typeof value === "function") return strings((value as (...a: unknown[]) => unknown)("Laptop", "macOS"), path + "()");
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  return [];
}

describe("user Passkeys page copy (English)", () => {
  const copy = strings(pagesCopy("en").passkeys);

  it("has strings to check", () => {
    expect(copy.length).toBeGreaterThan(30);
  });

  it.each(copy)("%s has no straight quotes", (_path, text) => {
    expect(text).not.toMatch(/["']/);
  });

  it("uses curly quotes in the failed attempts card", () => {
    const t = pagesCopy("en").passkeys;
    expect(t.failuresIntro).toContain("didn’t");
    expect(t.reasons.failed).toBe("Couldn’t add");
    expect(t.allEvents).toBe("All of this user’s events");
    expect(t.removeBody("Laptop")).toBe("“Laptop” will no longer sign in to this account. The user is emailed.");
  });
});
