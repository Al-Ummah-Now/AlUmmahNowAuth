import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adminCopy } from "./admin-copy";
import { MESSAGES } from "../../../profile/src/i18n";

// The admin account menu speaks the page's language with the profile menu's words (AUDIT-2 2026-11-22:
// on ?lang=ar the admin menu said "Sign in to another account" and "Sign out" in English)
describe("account menu copy", () => {
  it.each(["en", "ar"] as const)("matches the profile menu in %s", (lang) => {
    const t = adminCopy(lang).accountMenu;
    const p = MESSAGES[lang];
    expect(t.accountMenu).toBe(p.accountMenu);
    expect(t.moreAccounts).toBe(p.moreAccounts);
    expect(t.switchTo("Noor")).toBe(p.switchTo.replace("{name}", "Noor"));
    expect(t.signOutOf("Noor")).toBe(p.signOutOf.replace("{name}", "Noor"));
    expect(t.addAccount).toBe(p.addAccount);
    expect(t.apps).toBe(p.appsButton);
    expect(t.signOut).toBe(p.signOut);
    expect(t.signOutAll).toBe(p.signOutAll);
  });

  it("the admin header passes the page language's words to the menu", () => {
    const layout = readFileSync(new URL("../components/admin-layout.tsx", import.meta.url), "utf8");
    expect(layout).toMatch(/<AccountSwitcher[\s\S]*?labels=\{menu\}[\s\S]*?\/>/);
  });

  it("the menu has no hard-coded English in its markup", () => {
    const src = readFileSync(new URL("../../../../packages/ui/src/components/account-switcher.tsx", import.meta.url), "utf8");
    const render = src.slice(src.indexOf("return (\n    <div className=\"relative\">")).replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    for (const s of ["More accounts", "Sign in to another account", "Al Ummah Now apps", ">Sign out<", "Sign out of all accounts", "Account menu"]) {
      expect(render).not.toContain(s);
    }
  });
});
