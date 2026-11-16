/**
 * Arabic pages show Eastern Arabic (Hindi) numerals ٠–٩ for every formatted value (owner decision
 * 2026-11-15, AlUmmahNow#1488/#1496), through the one formatter packages/ui/src/format.ts.
 * English pages keep Arabic numerals 0–9. This file guards the formatter, the Profile page, and the
 * whole repo against new direct Intl / toLocale*String display calls and region-pinned digits.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  clientFormatScript,
  formatCompact,
  formatDate,
  formatDateTime,
  formatDuration,
  formatList,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRelative,
  formatTime,
  fill,
  intlLocale,
  NUMERIC_DATE_TIME,
  toAsciiDigits,
  toAsciiNumber,
} from "../../../packages/ui/src/format.ts";
import { renderHomePage } from "./page";

const ASCII_DIGIT = /[0-9]/;
const EASTERN = /[٠-٩]/;
const AT = Date.UTC(2026, 10, 15, 9, 30, 5);

describe("format.ts in Arabic: Eastern Arabic (Hindi) numerals ٠–٩ only", () => {
  const outputs: Record<string, string> = {
    number: formatNumber(1234567.5, "ar"),
    compact: formatCompact(15300, "ar"),
    percent: formatPercent(0.256, "ar"),
    money: formatMoney(1234.5, "USD", "ar"),
    date: formatDate(AT, "ar", { dateStyle: "long", timeZone: "UTC" }),
    dateMedium: formatDate(AT, "ar"),
    time: formatTime(AT, "ar", { timeZone: "UTC" }),
    dateTime: formatDateTime(AT, "ar", { timeZone: "UTC" }),
    numericDateTime: formatDate(AT, "ar", { ...NUMERIC_DATE_TIME, timeZone: "UTC" }),
    relativeMinutes: formatRelative(AT - 5 * 60_000, "ar", AT),
    relativeDays: formatRelative(AT - 3 * 86_400_000, "ar", AT),
    relativeOld: formatRelative(AT - 90 * 86_400_000, "ar", AT),
    duration: formatDuration(3725, "ar"),
    fill: fill("بعد {n} يومًا من {total}", { n: 27, total: 30 }, "ar"),
  };
  for (const [name, text] of Object.entries(outputs)) {
    it(`${name}: ${text}`, () => {
      expect(text).toMatch(EASTERN);
      expect(text).not.toMatch(ASCII_DIGIT);
    });
  }

  it("money is the Arabic currency name, never «US$»", () => {
    expect(formatMoney(1234.5, "USD", "ar")).toBe("١٬٢٣٤٫٥٠ دولار أمريكي");
    expect(formatMoney(1234.5, "USD", "ar")).not.toContain("$");
  });

  it("pins the numbering system, so Node and every browser agree", () => {
    expect(intlLocale("ar")).toBe("ar-u-nu-arab");
    expect(clientFormatScript("ar")).toContain('"ar-u-nu-arab"');
  });

  it("one plain space in dates and times (ICU builds differ: no-break spaces broke hydration)", () => {
    expect(formatDateTime(AT, "ar", { timeZone: "UTC" })).not.toMatch(/[\u00A0\u202F\u2009]/);
    expect(formatDate(AT, "en", { ...NUMERIC_DATE_TIME, timeZone: "UTC" }, "en-US")).toBe("11/15/2026, 9:30:05 AM");
  });
});

describe("format.ts in English: unchanged, Arabic numerals 0–9", () => {
  it("formats as before", () => {
    expect(formatNumber(1234567.5, "en")).toBe("1,234,567.5");
    expect(formatMoney(1.5, "USD", "en")).toBe("US$1.50");
    expect(formatDate(AT, "en", { dateStyle: "long", timeZone: "UTC" })).toBe("15 November 2026");
    expect(formatDuration(65, "en")).toBe("1:05");
    expect(formatList(["a", "b", "c"], "en")).toBe("a, b, and c");
    expect(fill("{n} of {total}", { n: 2, total: 10 }, "en")).toBe("2 of 10");
  });
});

describe("inputs: ٠–٩ typed in become 0–9", () => {
  it("normalises Eastern Arabic (Hindi) and Persian numerals", () => {
    expect(toAsciiDigits("١٢٣٤٥٦")).toBe("123456");
    expect(toAsciiDigits("۰۹ abc 7")).toBe("09 abc 7");
    expect(toAsciiNumber("١٬٢٣٤٫٥")).toBe("1234.5");
  });
});

describe("Profile page in Arabic", () => {
  const page = (locale: "ar" | "en") =>
    renderHomePage({ locale, apps: [], user: null, authServerUrl: "https://auth.example.com", appUrl: "https://profile.example.com", clientId: "profile" });

  it("the footer year is in ٠–٩ (no grouping mark)", () => {
    const footer = /<footer class="footer">([\s\S]*?)<\/footer>/.exec(page("ar"))![1];
    expect(footer).toContain(formatNumber(new Date().getUTCFullYear(), "ar", { useGrouping: false }));
    expect(footer.replace(/<[^>]*>/g, "")).not.toMatch(ASCII_DIGIT);
  });

  it("the in-browser formatter uses the pinned locale; English keeps 0–9", () => {
    expect(page("ar")).toContain('var AUN_LOCALE="ar-u-nu-arab"');
    expect(page("en")).toContain('var AUN_LOCALE="en-GB"');
    expect(page("en")).toContain(`© ${new Date().getUTCFullYear()}`);
  });
});

// Repo-wide guard: every display format goes through packages/ui/src/format.ts
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCE_DIRS = ["apps/auth/src", "apps/profile/src", "apps/admin/app", "apps/audit-consumer/src", "packages/ui/src"];
const FORMATTER = "packages/ui/src/format.ts";
const isTest = (path: string) => /\.test\.tsx?$|__tests__|__mocks__/.test(path);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$|\.generated\.ts$/.test(name)) out.push(path);
  }
  return out;
}

describe("repo guard: no direct Intl/toLocale*String display calls, no region-pinned digits", () => {
  const files = SOURCE_DIRS.flatMap((d) => sourceFiles(join(root, d))).map((p) => relative(root, p));

  it("finds the sources", () => expect(files.length).toBeGreaterThan(100));

  it("Intl.*Format and toLocale*String only in the formatter", () => {
    const offenders = files
      .filter((f) => f !== FORMATTER && !isTest(f))
      .filter((f) => /\bIntl\.(NumberFormat|DateTimeFormat|RelativeTimeFormat|ListFormat|PluralRules)\s*\(|\.toLocale(Date|Time)?String\s*\(/.test(readFileSync(join(root, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no 'ar-SA', 'ar-EG' or 'nu-latn' outside tests (they pin a region or 0–9 in Arabic)", () => {
    const offenders = files
      .filter((f) => !isTest(f))
      .filter((f) => /['"`](ar-SA|ar-EG)\b|nu-latn/.test(readFileSync(join(root, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
