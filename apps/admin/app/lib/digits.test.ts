/**
 * Arabic admin copy and dates show Eastern Arabic (Hindi) numerals ٠–٩ (owner decision 2026-11-15);
 * English is unchanged. The formatter is packages/ui/src/format.ts.
 */
import { describe, expect, it } from "vitest";
import { confirmCopy } from "./confirm-copy";
import { formatDate, formatDateTime, formatDateTimeMs } from "./date-utils";
import { deletionCopy, RETENTION_DAYS } from "./deletion-copy";
import { sameMonthYear } from "../../../../packages/ui/src/format.ts";

describe("Arabic long dates hydrate in Safari", () => {
  it("no comma between the month and the year (WebKit adds one, Node does not)", () => {
    expect(sameMonthYear("١٢ نوفمبر، ٢٠٢٦")).toBe("١٢ نوفمبر ٢٠٢٦");
    expect(sameMonthYear("١٢ نوفمبر ٢٠٢٦")).toBe("١٢ نوفمبر ٢٠٢٦");
    // The weekday's comma stays: «الخميس، ١٢ نوفمبر ٢٠٢٦»
    expect(sameMonthYear("الخميس، ١٢ نوفمبر، ٢٠٢٦")).toBe("الخميس، ١٢ نوفمبر ٢٠٢٦");
  });
});

const ASCII_DIGIT = /[0-9]/;

describe("Arabic admin copy has no 0–9", () => {
  const t = deletionCopy("ar");
  const texts = [
    t.deleteBody("user", "x"),
    t.pageIntro,
    t.roleHolders(1),
    t.roleHolders(12),
    ...[0, 1, 2, 5, 27].map((d) => t.daysLeft(d)),
    confirmCopy("ar").deletesAccount("a@b.c"),
  ];
  for (const text of texts) {
    it(text, () => expect(text).not.toMatch(ASCII_DIGIT));
  }

  it("numbers are there, in ٠–٩", () => {
    expect(t.pageIntro).toContain("٣٠");
    expect(t.daysLeft(27)).toBe("بعد ٢٧ يومًا");
  });

  it("English keeps 0–9", () => {
    expect(deletionCopy("en").pageIntro).toContain(String(RETENTION_DAYS));
    expect(confirmCopy("en").deletesAccount("a@b.c")).toContain("30 days");
  });
});

describe("admin dates", () => {
  const at = Date.UTC(2026, 10, 15, 9, 30, 5);

  it("Arabic in ٠–٩", () => {
    expect(formatDateTimeMs(at, "ar")).not.toMatch(ASCII_DIGIT);
    expect(formatDate(at / 1000, "ar")).not.toMatch(ASCII_DIGIT);
  });

  it("English stays as toLocaleString() printed on the server (en-US), with plain spaces", () => {
    expect(formatDate(new Date(at).toISOString())).toMatch(/^11\/1[45]\/2026$/);
    expect(formatDateTime(at / 1000)).toMatch(/^11\/1[45]\/2026, \d{1,2}:30:05 [AP]M$/);
  });
});
