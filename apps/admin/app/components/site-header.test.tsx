/**
 * The accounts admin renders the shared header (AlUmmahNow docs/design/NAV.md "Header") as JSX.
 * Each piece must equal what the vendored builders (packages/ui/src/nav/header.js, byte for byte
 * the AlUmmahNow file: `pnpm nav:check`) produce, so the admin's header can't drift from the
 * other apps'.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { appLinksHtml, brandHtml, envBadgeHtml, HEADER_ORDER, langButtonHtml } from "../../../../packages/ui/src/nav/header.js";
import { modeButtonBothHtml, publicAppLinks } from "../../../../packages/ui/src/nav/page-header.ts";
import { AppLinks, Brand, EnvBadge, LangButton } from "./site-header";
import { langSwitchHref } from "../lib/shell-copy";
import { ModeButton } from "./theme-toggle";

/**
 * The element as HTML, with React's serialisation differences evened out: it closes void elements
 * with "/>", keeps the camel case of hrefLang (HTML attribute names are case-insensitive), and
 * puts an image preload hint ahead of server-rendered images.
 */
const html = (node: React.ReactElement) =>
  renderToStaticMarkup(node)
    .replace(/<link rel="preload" as="image" href="[^"]*"\/>/g, "")
    .replace(/\s*\/>/g, ">")
    .replace(/ hrefLang=/g, " hreflang=");

describe("admin header = the shared builders", () => {
  for (const lang of ["en", "ar"] as const) {
    const app = lang === "ar" ? "إدارة الحسابات" : "Accounts admin";

    it(`${lang}: brand`, () => {
      const href = lang === "ar" ? "/?lang=ar" : "/";
      expect(html(<Brand lang={lang} href={href} app={app} />)).toBe(brandHtml({ lang, href, app, logoSrc: "/brand/logo-64.webp" }));
    });

    it(`${lang}: QA and STAGE badges, none in production or local dev`, () => {
      for (const env of ["qa", "stage"]) expect(html(<EnvBadge environment={env} lang={lang} />)).toBe(envBadgeHtml(env, lang));
      for (const env of ["production", "development", undefined]) expect(html(<EnvBadge environment={env} lang={lang} />)).toBe("");
    });

    it(`${lang}: Website and Videos`, () => {
      const links = publicAppLinks("https://auth.qa.alummahnow.net", lang);
      expect(links.map((l) => l.id)).toEqual(["www", "videos"]);
      expect(html(<AppLinks lang={lang} links={links} />)).toBe(appLinksHtml({ lang, links, iconBase: "/aun-nav/icons" }));
      expect(html(<AppLinks lang={lang} links={[]} />)).toBe("");
    });

    it(`${lang}: language button`, () => {
      const href = langSwitchHref("/users", lang === "ar" ? "?lang=ar&q=amina" : "?q=amina", lang);
      expect(href).toBe(lang === "ar" ? "/users?q=amina" : "/users?q=amina&lang=ar");
      expect(html(<LangButton lang={lang} href={href} />)).toBe(langButtonHtml({ lang, href }));
    });

    it(`${lang}: light/dark button, both modes`, () => {
      for (const dark of [false, true]) expect(html(<ModeButton lang={lang} dark={dark} />)).toBe(modeButtonBothHtml(lang, dark));
    });
  }

  it("the language link is never protocol-relative (a path like //evil.example)", () => {
    expect(langSwitchHref("//evil.example", "", "en")).toBe("/evil.example?lang=ar");
    expect(langSwitchHref("/\\evil.example", "?lang=ar", "ar")).toBe("/evil.example");
  });

  it("keeps the spec's order: drawer toggle, brand, badge, then app links, language, light/dark, account", () => {
    expect(HEADER_ORDER).toEqual(["menu", "brand", "env", "primary", "actions", "apps", "lang", "mode", "account"]);
  });
});
