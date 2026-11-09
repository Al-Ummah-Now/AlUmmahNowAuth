import { describe, expect, it } from "vitest";
import { dirFor, MESSAGES, pickLocale } from "./i18n";

const req = (query = "", headers: Record<string, string> = {}) =>
  new Request(`https://profile.auth.qa.alummahnow.net/${query}`, { headers });

describe("pickLocale", () => {
  it("defaults to English", () => {
    expect(pickLocale(req())).toBe("en");
  });

  it("is Arabic only when the link asks with ?lang=ar", () => {
    expect(pickLocale(req("?lang=ar"))).toBe("ar");
    expect(pickLocale(req("?lang=en"))).toBe("en");
  });

  it("ignores a saved cookie and the browser's Accept-Language", () => {
    expect(pickLocale(req("", { Cookie: "profile_lang=ar", "Accept-Language": "ar-SA,ar;q=0.9" }))).toBe("en");
  });

  it("falls back to English for unsupported or invalid values", () => {
    for (const lang of ["fr", "AR", "ar-SA", "constructor", "__proto__", "<x>"]) {
      expect(pickLocale(req(`?lang=${encodeURIComponent(lang)}`))).toBe("en");
    }
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
});
