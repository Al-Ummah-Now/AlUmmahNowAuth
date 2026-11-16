import { describe, expect, it } from "vitest";
import { renderHomePage } from "./page";

const base = {
  apps: [],
  user: { id: "u1", email: "a@e2e.alummahnow.net", roles: [] },
  authServerUrl: "https://auth.qa.alummahnow.net",
  appUrl: "https://profile.auth.qa.alummahnow.net",
  clientId: "client",
  environment: "qa",
};

/**
 * "Add a passkey" is hidden when Auth says the account can't add one now
 * (canAdd: a staff member's first passkey needs an emailed code, and Auth
 * can't send email) or at the passkey limit. The page hides it with the
 * hidden attribute, which .btn's display must not override.
 */
describe('account hub: "Add a passkey"', () => {
  it.each(["en", "ar"] as const)("hides the button when canAdd is false or at the limit (%s)", (locale) => {
    const html = renderHomePage({ ...base, locale, path: locale === "ar" ? "/?lang=ar" : "/" });
    expect(html).toContain('id="passkeyAdd"');
    expect(html).toContain("document.getElementById('passkeyAdd').hidden = !!data && (items.length >= (data.max || 10) || data.canAdd === false);");
    expect(html).toMatch(/\.btn\[hidden\] \{ display: none; \}/);
    // the hidden rule comes after .btn's display, so it wins
    expect(html.indexOf(".btn[hidden]")).toBeGreaterThan(html.indexOf("display: inline-flex"));
  });
});
