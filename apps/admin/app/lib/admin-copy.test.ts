/**
 * Every Auth admin page is written in English and Arabic (?lang=ar). These tests keep the two
 * languages in step: the same keys in every copy file, Arabic numbers in ٠–٩ and never grouped,
 * compact counts from 1,000 (cut, not rounded), the theme catalog's labels all in Arabic, and no
 * English text typed straight into a page.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECTIONS } from "../../../../packages/ui/src/auth-theme/catalog.ts";
import { ADMIN_COPY, AR_USERS, CATALOG_AR, catalogLabel, countOf, pageTitle } from "./admin-copy";
import { autocompleteStrings } from "./autocomplete-strings";
import { confirmCopy } from "./confirm-copy";
import { deletionCopy } from "./deletion-copy";
import { pagesCopy } from "./pages-copy";
import { shellCopy } from "./shell-copy";
import { signingKeysCopy } from "./signing-keys-copy";
import { systemAccountsCopy } from "./system-accounts";

/** Every key path in a copy object (functions and strings are leaves). */
function keys(value: unknown, path = ""): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([k, v]) => keys(v, path ? `${path}.${k}` : k));
  }
  return [path];
}

/** Every string a copy object can show: strings, and functions called with sample values. */
function texts(value: unknown, samples: unknown[]): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "function") return samples.flatMap((n) => texts((value as (...a: unknown[]) => unknown)(n, n, n, n), []));
  if (value && typeof value === "object") return Object.values(value).flatMap((v) => texts(v, samples));
  return [];
}

const COPY_FILES: Record<string, (lang: "en" | "ar") => unknown> = {
  "admin-copy": (lang) => ADMIN_COPY[lang],
  "shell-copy": shellCopy,
  "pages-copy": pagesCopy,
  "deletion-copy": deletionCopy,
  "confirm-copy": confirmCopy,
  "signing-keys-copy": signingKeysCopy,
  "system-accounts": systemAccountsCopy,
  "autocomplete-strings": autocompleteStrings,
};

describe("English and Arabic have the same keys", () => {
  it.each(Object.keys(COPY_FILES))("%s", (name) => {
    const copy = COPY_FILES[name];
    expect(keys(copy("ar")).sort()).toEqual(keys(copy("en")).sort());
  });

  it("no Arabic text is left empty", () => {
    for (const text of texts(ADMIN_COPY.ar, [3])) expect(text.trim().length).toBeGreaterThan(0);
  });
});

describe("Arabic numbers", () => {
  // Numbers the pages pass in: small, 3–10, 11–99, hundreds, thousands and millions
  const samples = [0, 1, 2, 3, 7, 12, 100, 101, 1250, 2999, 45000, 1_500_000];
  const ar = ADMIN_COPY.ar;
  // Every Arabic string that takes a number, called with each sample
  const numeric: ((n: number) => string)[] = [
    (n) => ar.common.page(n, n), (n) => ar.dashboard.rolesSplit(n, n), ar.dashboard.users, ar.role.permissions, ar.role.users,
    ar.moderation.needsAttention, (n) => ar.moderation.queueSummary(n, n), ar.moderation.failedTitle, (n) => ar.moderation.running(true, n),
    ar.themes.defaultFor, ar.theme.problems, ar.theme.contrastProblems, ar.theme.size, ar.theme.previewFailed, ar.theme.stopColour,
    ar.theme.stopPosition, ar.theme.removeStop, ar.security.intro, (n) => ar.security.staffCount(n, false, n), ar.security.confirmOnBody,
  ];
  const arabic = [...texts(ar, []), ...numeric.flatMap((f) => samples.map((n) => f(n)))];

  it("are written in ٠–٩, never 0–9", () => {
    // Code and names stay as they are: D1, v1 (format), WCAG AA, CSS lengths and placeholders
    const code = /D1|v1|v\d|\d+px|\{[^}]*\}|\(\?theme=…\)/g;
    for (const text of arabic) expect(text.replace(code, ""), text).not.toMatch(/[0-9]/);
  });

  it("are never grouped («,» or «٬»)", () => {
    for (const text of arabic) expect(text, text).not.toMatch(/[٠-٩][,٬][٠-٩]/);
  });

  it("counts from 1,000 are compact and cut, never rounded", () => {
    expect(countOf(2999, "en", ["user", "users"], AR_USERS)).toBe("2.9K users");
    expect(countOf(2999, "ar", ["user", "users"], AR_USERS)).toBe("٢٫٩ ألف مستخدم");
    expect(countOf(1_500_000, "ar", ["user", "users"], AR_USERS)).toBe("١٫٥ م مستخدم");
    expect(ADMIN_COPY.ar.moderation.queueSummary(45000, 1250)).toBe("٤٥ ألف مطابقة، ١٫٢ ألف مفتوحة (قيد الانتظار أو بانتظار معلومات)");
  });

  it("the noun agrees with the number", () => {
    const ar = (n: number) => countOf(n, "ar", ["user", "users"], AR_USERS);
    expect([1, 2, 3, 10, 11, 99, 100, 101, 0].map(ar)).toEqual([
      "مستخدم واحد",
      "مستخدمان",
      "٣ مستخدمين",
      "١٠ مستخدمين",
      "١١ مستخدمًا",
      "٩٩ مستخدمًا",
      "١٠٠ مستخدم",
      "١٠١ مستخدم",
      "٠ مستخدم",
    ]);
    expect(countOf(1, "en", ["user", "users"], AR_USERS)).toBe("1 user");
    expect(countOf(12, "en", ["user", "users"], AR_USERS)).toBe("12 users");
  });

  it("the failed-actions banner agrees with the count", () => {
    const t = ADMIN_COPY.ar.moderation;
    expect(t.needsAttention(1)).toBe("فشل إجراء واحد تمت الموافقة عليه بعد كل المحاولات، ويحتاج إلى مشرف.");
    expect(t.needsAttention(2)).toBe("فشل إجراءان تمت الموافقة عليهما بعد كل المحاولات، ويحتاجان إلى مشرف.");
    expect(t.needsAttention(3)).toBe("فشلت ٣ إجراءات تمت الموافقة عليها بعد كل المحاولات، وتحتاج إلى مشرف.");
    expect(t.needsAttention(12)).toBe("فشل ١٢ إجراءً تمت الموافقة عليه بعد كل المحاولات، ويحتاج إلى مشرف.");
  });

  it("the dashboard's role split and pager", () => {
    expect(ADMIN_COPY.ar.dashboard.rolesSplit(4, 2)).toBe("٤ للنظام، ٢ مخصَّصة");
    expect(ADMIN_COPY.ar.common.page(2, 13)).toBe("الصفحة ٢ من ١٣");
  });
});

describe("theme builder catalog", () => {
  const labels = new Set(SECTIONS.flatMap((s) => [s.label, ...s.slots.map((slot) => slot.label)]));

  it.each([...labels])("%s has an Arabic name", (label) => {
    expect(CATALOG_AR[label]).toBeTruthy();
    expect(catalogLabel(label, "ar")).not.toBe(label);
    expect(catalogLabel(label, "en")).toBe(label);
  });
});

describe("page titles", () => {
  it("follow the page language", () => {
    expect(pageTitle("dashboard", "en")).toBe("Dashboard - Al Ummah Now Admin");
    expect(pageTitle("dashboard", "ar")).toBe("لوحة المعلومات - إدارة حسابات الأمة الآن");
    expect(pageTitle("roles", "ar", "مشرف")).toBe("مشرف - الأدوار - إدارة حسابات الأمة الآن");
  });
});

describe("no English typed into a page", () => {
  // Text between tags, and title/placeholder/aria-label attributes, must come from a copy file.
  // Allowed: code and names that stay as they are in both languages.
  const ALLOWED = /^(OAuth|OpenID|WCAG AA|theme\.json|English|عربي|v\d.*|D1|×|—|-|·)$/;
  const dir = join(__dirname, "..");
  const files = [
    ...readdirSync(join(dir, "routes")).filter((f) => f.endsWith(".tsx") && !f.includes(".test.")).map((f) => join(dir, "routes", f)),
    ...readdirSync(join(dir, "components")).filter((f) => f.endsWith(".tsx") && !f.includes(".test.")).map((f) => join(dir, "components", f)),
  ];

  it.each(files.map((f) => [f.slice(dir.length + 1), f]))("%s", (_name, file) => {
    const source = readFileSync(file, "utf8")
      // comments
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const found: string[] = [];
    for (const m of source.matchAll(/>([^<>{}]*[A-Za-z]{2,}[^<>{}]*)</g)) {
      const text = m[1].trim();
      // TypeScript generics and arrows look like text between > and <
      if (!text || /[=;()]|=>|\b(const|return|typeof|extends)\b/.test(m[1]) || ALLOWED.test(text)) continue;
      found.push(text);
    }
    for (const m of source.matchAll(/\b(title|placeholder|aria-label)="([^"]*[A-Za-z]{2,}[^"]*)"/g)) {
      if (!ALLOWED.test(m[2]) && !/^(e\.g\.|eid-2027|user@example\.com|https:\/\/example\.com)/.test(m[2])) found.push(`${m[1]}="${m[2]}"`);
    }
    expect(found).toEqual([]);
  });
});
