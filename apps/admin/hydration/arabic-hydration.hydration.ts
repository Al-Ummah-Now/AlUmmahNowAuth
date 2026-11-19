/**
 * Arabic pages hydrate in WebKit without errors and show Eastern Arabic (Hindi) numerals ٠–٩.
 *
 * Plain `ar` formats with 0–9 in Node and ٠–٩ in WebKit, so a server render hydrated in Safari
 * failed with React #418 and re-rendered the page. Every value now goes through
 * packages/ui/src/format.ts (`ar-u-nu-arab`). The server here renders the real admin route
 * components in Node; WebKit hydrates them (see hydration/server.mjs).
 */
import { expect, test, type Page } from "@playwright/test";

const ASCII_DIGIT = /[0-9]/;
const EASTERN_DIGIT = /[٠-٩]/;

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function hydrate(page: Page, path: string): Promise<string[]> {
  const errors = watchErrors(page);
  await page.goto(path);
  await page.waitForFunction(() => (window as unknown as { __hydrated?: boolean }).__hydrated === true);
  const hydrationErrors = await page.evaluate(() => (window as unknown as { __hydrationErrors: string[] }).__hydrationErrors);
  return [...errors, ...hydrationErrors];
}

for (const lang of ["ar", "en"] as const) {
  for (const name of ["deleted", "users", "passkeys", "audit", "sessions", "clients"] as const) {
    test(`admin ${name} (${lang}) hydrates without errors`, async ({ page }) => {
      expect(await hydrate(page, `/admin/${name}?lang=${lang}`)).toEqual([]);
    });
  }
}

test("Recently deleted in Arabic: dates and days left in ٠–٩", async ({ page }) => {
  expect(await hydrate(page, "/admin/deleted?lang=ar")).toEqual([]);
  // The formatted cells (dates, "in N days"); ids and emails stay as they are
  const cells = (await page.locator("tbody td").allInnerTexts()).filter((text) => /UTC|بعد/.test(text));
  expect(cells.filter((text) => EASTERN_DIGIT.test(text)).length).toBeGreaterThanOrEqual(3); // two dates, "in 27 days"
  for (const text of cells) expect(text, text).not.toMatch(ASCII_DIGIT);
  await expect(page.locator("main p").first()).toContainText("٣٠");
});

test("Users in Arabic: the system accounts count is in ٠–٩", async ({ page }) => {
  expect(await hydrate(page, "/admin/users?lang=ar")).toEqual([]);
  await expect(page.getByTestId("system-accounts-toggle")).toContainText("١");
});

test("Profile in Arabic: passkey dates and account times in ٠–٩", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/profile?lang=ar");
  const meta = page.locator("#passkeyList li").first();
  await expect(meta).toContainText("٢٠٢٦");
  expect(await meta.innerText()).not.toMatch(ASCII_DIGIT);
  await expect(page.locator("footer")).toContainText("٢٠٢");
  expect(await page.locator("footer").innerText()).not.toMatch(ASCII_DIGIT);
  expect(errors).toEqual([]);
});

// Every localized page in Arabic: no Arabic numerals 0–9 outside ids, emails, IPs, URLs and code
for (const name of ["users", "passkeys", "audit", "sessions", "clients", "deleted"] as const) {
  test(`admin ${name} in Arabic: right-to-left, Arabic words, ٠–٩`, async ({ page }) => {
    expect(await hydrate(page, `/admin/${name}?lang=ar`)).toEqual([]);
    const main = page.locator("main");
    expect(await main.evaluate((el) => getComputedStyle(el.querySelector("h1, h2")!).direction)).toBe("rtl");
    // The visible text, without the values that stay as typed (bdi, code, dir=ltr, mono)
    const text = await main.evaluate((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelectorAll("bdi, code, [dir=ltr], .font-mono, .sr-only, [hidden]").forEach((n) => n.remove());
      return copy.innerText;
    });
    expect(text).toMatch(/[\u0600-\u06FF]/);
    expect(text, text).not.toMatch(ASCII_DIGIT);
  });
}
