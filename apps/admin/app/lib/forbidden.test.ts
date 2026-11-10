import { describe, expect, it } from "vitest";
import { forbiddenLocale } from "./forbidden";

const req = (query = "", headers: Record<string, string> = {}) =>
  new Request(`https://admin.auth.alummahnow.net/forbidden${query}`, { headers });

describe("forbidden page language", () => {
  it("is English with no lang, even when the browser prefers Arabic", () => {
    expect(forbiddenLocale(req("", { "Accept-Language": "ar-SA,ar;q=0.9" }))).toBe("en");
  });

  it("is Arabic only for ?lang=ar", () => {
    expect(forbiddenLocale(req("?lang=ar"))).toBe("ar");
    expect(forbiddenLocale(req("?lang=en", { "Accept-Language": "ar" }))).toBe("en");
  });

  it("falls back to English for unsupported or invalid values", () => {
    for (const lang of ["fr", "AR", "ar-SA", "constructor", "__proto__", "<x>"]) {
      expect(forbiddenLocale(req(`?lang=${encodeURIComponent(lang)}`, { "Accept-Language": "ar" }))).toBe("en");
    }
  });
});
