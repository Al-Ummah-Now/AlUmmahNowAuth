import { describe, expect, it } from "vitest";
import { appsForUser } from "./apps";
import { MESSAGES } from "./i18n";
import { escapeHtml, renderAppCards, renderLauncher } from "./launcher";
import { renderHomePage, scriptJson } from "./page";

describe("renderLauncher", () => {
  const admin = renderLauncher(appsForUser(["Admin"], "qa", "en"), MESSAGES.en);
  const member = renderLauncher(appsForUser(["Member"], "qa", "en"), MESSAGES.en);

  it("uses the menu-button pattern", () => {
    expect(admin).toMatch(/<button[^>]+id="appsTrigger"[^>]+aria-haspopup="true"[^>]+aria-expanded="false"[^>]+aria-controls="appsMenu"/);
    expect(admin).toMatch(/id="appsMenu" role="menu" aria-labelledby="appsTrigger" hidden/);
    // www, videos, profile, content admin, CMS, auth admin
    expect(admin.match(/role="menuitem"/g)).toHaveLength(6);
  });

  it("marks the current app with aria-current", () => {
    expect(admin.match(/aria-current="page"/g)).toHaveLength(1);
    expect(admin).toMatch(/aria-current="page"[\s\S]*?Profile/);
  });

  it("groups admin apps under Administration only for admins", () => {
    expect(admin).toContain("Administration");
    expect(admin).toContain("https://admin.auth.qa.alummahnow.net");
    expect(member).not.toContain("Administration");
    expect(member).not.toContain("admin.");
  });

  it("opens apps in the same tab", () => {
    expect(admin).not.toContain("target=");
  });
});

describe("renderAppCards", () => {
  it("omits the current app and returns nothing when there is nothing else", () => {
    const cards = renderAppCards(appsForUser(["Member"], "qa", "en"), MESSAGES.en);
    expect(cards).toContain("https://videos.qa.alummahnow.net");
    expect(cards).not.toContain('data-app="profile"');
    expect(renderAppCards(appsForUser([], null, "en"), MESSAGES.en)).toBe("");
  });
});

describe("renderHomePage", () => {
  const base = {
    apps: appsForUser(["Admin"], "qa", "ar"),
    user: { id: "u1", email: "a@e2e.alummahnow.net", roles: ["Admin"] },
    authServerUrl: "https://auth.qa.alummahnow.net",
    appUrl: "https://profile.auth.qa.alummahnow.net",
    clientId: "client",
  };

  it("sets lang and dir for Arabic and offers a switch back to English", () => {
    const html = renderHomePage({ ...base, locale: "ar" });
    expect(html).toContain('<html lang="ar" dir="rtl" data-theme="fawanees">');
    expect(html).toContain('href="?lang=en"');
    expect(html).toContain("تطبيقاتك");
  });

  it("no longer renders the old standalone Admin button", () => {
    const html = renderHomePage({ ...base, locale: "en", apps: appsForUser(["Admin"], "qa", "en") });
    expect(html).not.toContain("⚙️ Admin");
    expect(html).not.toContain("adminUrl");
  });

  it("embeds user data safely inside <script>", () => {
    const html = renderHomePage({ ...base, locale: "en", user: { ...base.user, email: "</script><script>alert(1)</script>" } });
    expect(html).not.toContain("</script><script>alert(1)");
    expect(scriptJson("</script>")).toBe('"\\u003c/script>"');
  });
  it("confirms sign-outs in an in-page dialog, never a browser prompt", () => {
    const html = renderHomePage({ ...base, locale: "en" });
    expect(html).toMatch(/<dialog class="confirm-dialog" id="confirmDialog" role="alertdialog" aria-labelledby="confirmTitle" aria-describedby="confirmMessage">/);
    expect(html).toMatch(/value="cancel" class="btn btn-secondary" id="confirmCancel" autofocus>Cancel</);
    expect(html).toContain('onclick="requestSignOutAll()"');
    expect(html).toContain("requestSignOutAccount(this.dataset.userId)");
    expect(html).not.toMatch(/(?<![\w$.])(?:window\.)?(?:confirm|alert|prompt)\s*\(|beforeunload/);
  });

  it("words the dialog in Arabic for Arabic pages", () => {
    const html = renderHomePage({ ...base, locale: "ar" });
    expect(html).toContain(`autofocus>${MESSAGES.ar.confirmCancel}<`);
    expect(html).toContain(MESSAGES.ar.signOutAllTitle);
  });
});

describe("escapeHtml", () => {
  it("escapes markup characters", () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  });
});
