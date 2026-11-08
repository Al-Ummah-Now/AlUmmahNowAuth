import { describe, expect, it } from "vitest";
import { dirFor, langCookie, MESSAGES, pickLocale } from "./i18n";

const req = (query = "", headers: Record<string, string> = {}) =>
  new Request(`https://profile.auth.qa.alummahnow.net/${query}`, { headers });

describe("pickLocale", () => {
  it("defaults to English", () => {
    expect(pickLocale(req())).toEqual({ locale: "en", fromQuery: false });
  });

  it("?lang= wins over cookie and Accept-Language, and is flagged for persisting", () => {
    expect(pickLocale(req("?lang=ar", { Cookie: "profile_lang=en", "Accept-Language": "en" }))).toEqual({
      locale: "ar",
      fromQuery: true,
    });
  });

  it("ignores unsupported ?lang values", () => {
    expect(pickLocale(req("?lang=fr")).locale).toBe("en");
  });

  it("uses the saved cookie next", () => {
    expect(pickLocale(req("", { Cookie: "profile_session=abc; profile_lang=ar", "Accept-Language": "en" })).locale).toBe("ar");
  });

  it("falls back to the best supported Accept-Language", () => {
    expect(pickLocale(req("", { "Accept-Language": "ar-EG,ar;q=0.9,en;q=0.8" })).locale).toBe("ar");
    expect(pickLocale(req("", { "Accept-Language": "fr-FR, en;q=0.5, ar;q=0.9" })).locale).toBe("ar");
    expect(pickLocale(req("", { "Accept-Language": "fr-FR, de" })).locale).toBe("en");
  });
});

describe("direction and messages", () => {
  it("Arabic is RTL, English is LTR", () => {
    expect(dirFor("ar")).toBe("rtl");
    expect(dirFor("en")).toBe("ltr");
  });

  it("Arabic has a translation for every English key", () => {
    for (const key of Object.keys(MESSAGES.en) as (keyof typeof MESSAGES.en)[]) {
      expect(MESSAGES.ar[key], key).toBeTruthy();
    }
  });

  it("lang cookie is Secure outside localhost", () => {
    expect(langCookie("ar", false)).toContain("Secure;");
    expect(langCookie("ar", true)).not.toContain("Secure;");
  });
});
