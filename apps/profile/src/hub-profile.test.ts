import { describe, expect, it } from "vitest";
import { renderHomePage, yearText } from "./page";
import { MESSAGES } from "./i18n";

const base = {
  apps: [],
  user: { id: "usr_0123456789abcdef", email: "yusuf.rahman@alummahnow.net", roles: ["Admin", "Member"] },
  authServerUrl: "https://auth.qa.alummahnow.net",
  appUrl: "https://profile.auth.qa.alummahnow.net",
  clientId: "client",
  environment: "qa",
};

/** "Your profile" on the account hub (design audit of Auth #426). */
describe("account hub: Your profile", () => {
  it.each(["en", "ar"] as const)("never shows the account's id: a Name row from the account list instead (%s)", (locale) => {
    const html = renderHomePage({ ...base, locale });
    expect(html).not.toContain('id="userId"');
    expect(html).not.toContain("getElementById('userId')");
    expect(html).toContain('id="userNameField" hidden');
    expect(html).toContain("document.getElementById('userName').textContent = hasName ? name : '';");
  });

  it("role badges: the role's name in the page's language, never upper-cased", () => {
    const html = renderHomePage({ ...base, locale: "ar" });
    expect(html).toContain("badge.textContent = T.roleNames[lower] || role;");
    expect(html).not.toContain("role.toUpperCase()");
    expect(MESSAGES.ar.roleNames.admin).toBe("مشرف");
    expect(MESSAGES.ar.roleNames.member).toBe("عضو");
    expect(MESSAGES.en.roleNames).toEqual({});
  });

  it("fields, headings and buttons use the theme's tokens (readable in light and dark), no emoji headings", () => {
    const html = renderHomePage({ ...base, locale: "en" });
    expect(html).not.toContain("rgba(15, 23, 42, 0.6)");
    expect(html).not.toContain("rgba(255, 255, 255, 0.1)");
    expect(html).toMatch(/\.btn-secondary \{[^}]*--fanous-c-button-secondary-border/);
    expect(html).not.toMatch(/[👤🔑🚪]/u);
    expect(html).toContain("<h2>Your profile</h2>");
  });

  it("the footer year uses Eastern Arabic (Hindi) numerals in Arabic", () => {
    expect(yearText(2026, "ar")).toBe("٢٠٢٦");
    expect(yearText(2026, "en")).toBe("2026");
    const html = renderHomePage({ ...base, locale: "ar" });
    expect(html).toMatch(/<footer class="footer">\s*<p>© [٠-٩]{4} الأمة الآن\.<\/p>/);
  });
});
