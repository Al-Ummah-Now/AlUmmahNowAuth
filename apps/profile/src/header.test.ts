/**
 * The profile's header is the shared one (AlUmmahNow docs/design/NAV.md "Header"), built with the
 * vendored header.js builders (packages/ui/src/nav, kept byte-identical by `pnpm nav:check`).
 */
import { describe, expect, it } from "vitest";
import { renderHomePage } from "./page";
import { NAV_FONTS_CSS } from "../../../packages/ui/src/nav/aun-nav-fonts.generated.ts";
import { brandHtml, envBadgeHtml, langButtonHtml, signInHtml } from "../../../packages/ui/src/nav/header.js";
import { modeIconSvg } from "../../../packages/ui/src/nav/mode-toggle.js";
import {
  langHref,
  modeButtonBothHtml,
  PAGE_MODE_SCRIPT,
  pageHeaderHtml,
  sameSitePath,
  scriptJson,
} from "../../../packages/ui/src/nav/page-header.ts";

const base = {
  apps: [],
  user: { id: "u1", email: "a@e2e.alummahnow.net", roles: [] },
  authServerUrl: "https://auth.qa.alummahnow.net",
  appUrl: "https://profile.auth.qa.alummahnow.net",
  clientId: "client",
  environment: "qa",
};

const headerOf = (html: string) => html.slice(html.indexOf('<header class="aun-header"'), html.indexOf("</header>") + 9);
/** The header's controls in reading order, by class. */
const order = (header: string) =>
  [...header.matchAll(/class="(aun-brand|aun-env|aun-lang|aun-icon-btn aun-mode|account-switcher|aun-signin)"/g)].map((m) => m[1]);

describe("profile header", () => {
  it("renders the builders in the spec's order: brand, QA badge, language, light/dark, account; no links to other sites", () => {
    const header = headerOf(renderHomePage({ ...base, locale: "en", path: "/?theme=fawanees" }));
    expect(order(header)).toEqual(["aun-brand", "aun-env", "aun-lang", "aun-icon-btn aun-mode", "account-switcher"]);
    expect(header).toContain(brandHtml({ lang: "en", href: "/", app: "Account", logoSrc: "/brand/logo-64.webp" }));
    expect(header).toContain(envBadgeHtml("qa", "en"));
    // no Website / Videos in the bar (owner, 2026-11-15): they are in the account menu's apps
    expect(header).not.toMatch(/aun-apps|aun-app\b|www\.qa\.alummahnow\.net|videos\.qa\.alummahnow\.net/);
    // the language button keeps the page's query and swaps ?lang=
    expect(header).toContain(langButtonHtml({ lang: "en", href: "/?theme=fawanees&lang=ar" }));
    expect(header).toContain(modeButtonBothHtml("en"));
    // full width, like every app's header: no max width, no centred row
    expect(header).toMatch(/^<header class="aun-header" data-testid="aun-header"><a class="aun-brand"/);
    expect(header).not.toContain("--aun-header-max");
    expect(header).not.toContain("aun-header-row");
  });

  it("Arabic: the same controls in Arabic, the link back to English keeps the query", () => {
    const header = headerOf(renderHomePage({ ...base, locale: "ar", path: "/?lang=ar&theme=fawanees" }));
    expect(header).toContain(brandHtml({ lang: "ar", href: "/?lang=ar", app: "الحساب", logoSrc: "/brand/logo-64.webp" }));
    expect(header).toContain(langButtonHtml({ lang: "ar", href: "/?lang=en&theme=fawanees" }));
    expect(header).not.toContain("www.qa.alummahnow.net");
    expect(header).toContain(modeButtonBothHtml("ar"));
  });

  it("signed out: a solid Sign in in the header (no emoji button), back to this page after signing in", () => {
    const html = renderHomePage({ ...base, user: null, locale: "en", path: "/?theme=fawanees&error=access_denied" });
    const header = headerOf(html);
    expect(order(header)).toEqual(["aun-brand", "aun-env", "aun-lang", "aun-icon-btn aun-mode", "aun-signin"]);
    expect(header).toContain(signInHtml({ lang: "en", href: `/login?return=${encodeURIComponent("/?theme=fawanees")}` }));
    expect(html).not.toContain("navMenu");
    expect(header).not.toContain("accountSwitcher");
  });

  it("no badge in production", () => {
    const header = headerOf(renderHomePage({ ...base, environment: "production", authServerUrl: "http://localhost:3301", locale: "en" }));
    expect(header).not.toContain("aun-env");
  });

  it("loads the mode script after the page's styles, so a saved choice is on screen before first paint", () => {
    const html = renderHomePage({ ...base, locale: "en" });
    expect(html.indexOf(`<script>${PAGE_MODE_SCRIPT}</script>`)).toBeGreaterThan(html.indexOf("</style>"));
    expect(html.indexOf(`<script>${PAGE_MODE_SCRIPT}</script>`)).toBeLessThan(html.indexOf("</head>"));
  });
});

describe("profile header theme (AlUmmahNow NAV.md \"Theme\")", () => {
  it("the band, edge and control font are the contract's for <html data-theme>, with no profile override", () => {
    const html = renderHomePage({ ...base, locale: "en", path: "/" });
    expect(html).toMatch(/<html [^>]*data-theme="[a-z][a-z0-9-]*"/);
    const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    expect(style).toContain("--aun-header-band:");
    expect(style).toContain(NAV_FONTS_CSS);
    // the profile sets none of the header's look itself
    expect(style).not.toMatch(/\.aun-header\s*\{[^}]*--aun-header-bg/);
    expect(style).not.toContain("--auth-profile-nav-background");
  });
});

describe("shared page header (packages/ui/src/nav/page-header.ts)", () => {
  it("langHref keeps the path and query, swaps lang, drops one-shot parameters", () => {
    expect(langHref(new URL("https://a.example/password/authorize?client_id=x&lang=en"), "ar")).toBe("/password/authorize?client_id=x&lang=ar");
    expect(langHref("/", "ar")).toBe("/?lang=ar");
    expect(langHref("/?error=x&a=1#frag", "en", ["error"])).toBe("/?a=1&lang=en");
  });

  it("self-links are never protocol-relative (//evil.example, /\\evil.example)", () => {
    for (const bad of ["//evil.example", "///evil.example/x", "/\\evil.example", "\\\\evil.example"]) {
      expect(langHref(bad, "ar")).toMatch(/^\/(?![/\\])/);
      expect(langHref(new URL(`https://auth.example${bad.replace(/\\/g, "/")}`), "ar")).toMatch(/^\/(?![/\\])/);
    }
    expect(langHref("//evil.example?a=1", "ar")).toBe("/evil.example?a=1&lang=ar");
    expect(sameSitePath("https://evil.example/")).toBe("/");
    expect(sameSitePath("/\\evil.example")).toBe("/evil.example");
    // the profile page: a request path that starts with // keeps the link on this site
    const header = headerOf(renderHomePage({ ...base, locale: "en", path: "//evil.example/x?theme=fawanees" }));
    expect(header).not.toMatch(/href="\/\//);
    expect(header).not.toContain("evil.example?");
  });

  it("modeButtonBothHtml is the builder's button with both icons, the mode on screen picked by CSS", () => {
    const html = modeButtonBothHtml("en");
    expect(html).toBe(
      `<button type="button" class="aun-icon-btn aun-mode" id="mode-toggle" data-testid="theme-toggle" aria-label="Switch to dark mode" title="Switch to dark mode">` +
        modeIconSvg("sun", "aun-mode-sun") +
        modeIconSvg("moon", "aun-mode-moon") +
        `</button>`,
    );
  });

  it("the sign-in pages' header has no account slot", () => {
    const html = pageHeaderHtml({ lang: "en", brandHref: "/", app: "Account", langHref: "/?lang=ar" });
    expect(html).not.toContain("aun-signin");
    expect(html).not.toContain("aun-acct-btn");
    expect(html).toMatch(/^<header class="aun-header" data-testid="aun-header"><a class="aun-brand"/);
  });

  it("the mode script is valid ES5-era JavaScript", () => {
    expect(() => new Function(PAGE_MODE_SCRIPT)).not.toThrow();
    expect(PAGE_MODE_SCRIPT).not.toMatch(/=>|\blet\b|\bconst\b|`/);
  });
});

describe("scriptJson (JSON inlined in a <script>)", () => {
  it("can't close the script element or open a comment, and still parses to the same value", () => {
    const value = { a: "</script><script>alert(1)</script>", b: "<!-- x -->", c: "a & b", d: "line\u2028sep\u2029end" };
    const out = scriptJson(value);
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(out).toContain("\\u003c/script\\u003e");
    expect(JSON.parse(out)).toEqual(value);
  });

  it("leaves the mode labels as they were (Arabic included)", () => {
    expect(PAGE_MODE_SCRIPT).toContain('"ar":{"toLight":"التبديل إلى الوضع الفاتح"');
    expect(PAGE_MODE_SCRIPT).not.toContain("</script");
  });
});
