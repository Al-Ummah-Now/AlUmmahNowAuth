import { describe, expect, it } from "vitest";
import { appsForUser } from "./apps";
import { MESSAGES } from "./i18n";
import { escapeHtml, renderAppCards, renderAppsSection } from "./launcher";
import { renderHomePage, scriptJson } from "./page";

describe("renderAppsSection (account menu, AlUmmahNow docs/design/NAV.md)", () => {
  const admin = renderAppsSection(appsForUser(["Admin"], "qa", "en"), MESSAGES.en);
  const member = renderAppsSection(appsForUser(["Member"], "qa", "en"), MESSAGES.en);

  it("lists the other apps in the shared order and labels, never this one", () => {
    const ids = [...admin.matchAll(/<a role="menuitem"[^>]*data-app="([a-z-]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["www", "videos", "cms", "content-admin", "auth-admin"]);
    expect(admin).toContain(">Website<");
    expect(admin).toContain(">Content management<");
    expect(admin).toContain(">Videos admin<");
    expect(admin).toContain(">Accounts admin<");
    expect(admin).not.toContain('data-app="profile"');
    expect(admin).toMatch(/<span class="aun-menu-label" id="appsLabel">Al Ummah Now apps<\/span>/);
    expect(admin.match(/role="menuitem"/g)).toHaveLength(5);
    // Each app with its own icon (the shared nav's ids: the content admin is "admin")
    expect(admin).toContain('<img class="aun-app-icon" data-app="admin" src="/aun-nav/icons/admin.webp" width="32" height="32" alt="" loading="lazy" decoding="async">');
  });

  it("shows staff apps only to staff", () => {
    expect(admin).toContain("https://admin.auth.qa.alummahnow.net");
    expect(member).not.toContain("admin.");
    expect([...member.matchAll(/<a role="menuitem"[^>]*data-app="([a-z-]+)"/g)].map((m) => m[1])).toEqual(["www", "videos"]);
  });

  it("opens apps in the same tab, and renders nothing when there is nothing else", () => {
    expect(admin).not.toContain("target=");
    expect(renderAppsSection(appsForUser([], null, "en"), MESSAGES.en)).toBe("");
  });
});

describe("renderAppCards", () => {
  it("shows each app's own favicon, the same image as the account menu (no drawn icon or colour tile)", () => {
    const cards = renderAppCards(appsForUser(["Admin"], "qa", "en"), MESSAGES.en);
    for (const id of ["www", "videos", "cms", "admin", "auth-admin"]) {
      expect(cards).toContain(`<img class="aun-app-icon aun-app-icon--card" data-app="${id}" src="/aun-nav/icons/${id}.webp" width="48" height="48" alt="" loading="lazy" decoding="async">`);
    }
    expect(cards).not.toContain("<svg class=\"app-icon-svg\"");
    expect(cards).not.toContain("app-tile");
  });

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

  it("puts the apps in the account menu (no separate launcher) and uses the shared nav classes", () => {
    const html = renderHomePage({ ...base, locale: "en", apps: appsForUser(["Admin"], "qa", "en") });
    expect(html).not.toContain('id="appsTrigger"');
    expect(html).toMatch(/<div class="account-dropdown aun-menu" id="accountDropdown" role="menu" hidden>[\s\S]*id="accountApps"/);
    expect(html).toContain('class="account-trigger aun-acct-btn"');
    expect(html).toContain(".aun-menu {");
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
