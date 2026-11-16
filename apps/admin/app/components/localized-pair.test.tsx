// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { LocalizedPair, type TranslateFn } from "./localized-pair";
import { pairErrors } from "../lib/localized-errors";
import type { LocalizedPairValue } from "../../../../packages/ui/src/l10n/localized";

afterEach(cleanup);

function Harness({ initial, translate, flagMissing }: { initial: LocalizedPairValue; translate?: TranslateFn; flagMissing?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <LocalizedPair label="Client name" value={value} onChange={setValue} translate={translate} flagMissing={flagMissing} errors={pairErrors(value, "name")} />
      <div data-testid="value">{JSON.stringify(value)}</div>
    </>
  );
}

const valueOf = () => JSON.parse(screen.getByTestId("value").textContent ?? "{}");

describe("LocalizedPair", () => {
  it("labels both fields and sets lang/dir on each", () => {
    render(<Harness initial={{ en: "Videos", ar: "المرئيات" }} />);
    const en = screen.getByLabelText("English") as HTMLInputElement;
    const ar = screen.getByLabelText("العربية") as HTMLInputElement;
    expect(en.lang).toBe("en");
    expect(en.dir).toBe("ltr");
    expect(ar.lang).toBe("ar");
    expect(ar.dir).toBe("rtl");
  });

  it("ties a missing-language error to its field", () => {
    render(<Harness initial={{ en: "Videos", ar: "" }} />);
    const ar = screen.getByLabelText("العربية");
    expect(ar.getAttribute("aria-invalid")).toBe("true");
    const describedBy = ar.getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)?.textContent).toBe("Enter the Arabic name");
    expect(screen.getByLabelText("English").getAttribute("aria-invalid")).toBeNull();
  });

  it("flags legacy values: an Arabic field holding English counts as missing", () => {
    render(<Harness initial={{ en: "Videos", ar: "Videos" }} flagMissing />);
    expect(screen.getByTestId("missing-ar").textContent).toBe("Arabic missing");
    expect(screen.queryByTestId("missing-en")).toBeNull();
  });

  it("has no Translate buttons when translation isn't set up", () => {
    render(<Harness initial={{ en: "Videos", ar: "" }} />);
    expect(screen.queryByRole("button", { name: /Translate/ })).toBeNull();
  });

  it("fills the empty side from the typed one and announces it", async () => {
    const translate = vi.fn<TranslateFn>(async () => "المرئيات");
    render(<Harness initial={{ en: "Videos", ar: "" }} translate={translate} />);
    expect((screen.getByRole("button", { name: "Translate to English" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Translate to Arabic" })));
    expect(translate).toHaveBeenCalledWith("Videos", "en", "ar");
    expect(valueOf()).toEqual({ en: "Videos", ar: "المرئيات" });
    expect(screen.getByRole("status").textContent).toMatch(/Arabic filled from English/);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("replacing text already there offers Undo, which restores it", async () => {
    const translate = vi.fn<TranslateFn>(async () => "Visual items");
    render(<Harness initial={{ en: "Videos", ar: "المرئيات" }} translate={translate} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Translate to English" })));
    expect(valueOf().en).toBe("Visual items");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(valueOf().en).toBe("Videos");
  });

  it("reports a failed translation without changing the fields", async () => {
    const translate = vi.fn<TranslateFn>(async () => {
      throw new Error("Daily limit reached");
    });
    render(<Harness initial={{ en: "Videos", ar: "" }} translate={translate} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Translate to Arabic" })));
    expect(valueOf()).toEqual({ en: "Videos", ar: "" });
    expect(screen.getByRole("status").textContent).toBe("Couldn't translate: Daily limit reached");
  });
});

describe("pairErrors", () => {
  it("needs both languages", () => {
    expect(pairErrors({ en: "a", ar: "ب" })).toBeUndefined();
    expect(pairErrors({ en: " ", ar: "ب" }, "name")).toEqual({ en: "Enter the English name" });
  });
});
