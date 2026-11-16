// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TranslateMissingDialog, type MissingRow } from "./translate-missing-dialog";
import { fieldTranslator, translateAll } from "../lib/translate-client";

afterEach(cleanup);

const rows: MissingRow[] = [
  { id: "c1", label: "Videos", source: "Videos", current: "" },
  { id: "c2", label: "Quran app", source: "Read Surah Al-Fatiha", current: "Quran app" },
  { id: "c3", label: "Studio", source: "Studio", current: "" },
];

/** Mocked service: no real AI in tests. */
const translator = vi.fn(async () => [
  { text: "المرئيات" },
  { text: "", refused: "quran" as const },
  { text: "الاستوديو" },
]) as unknown as typeof translateAll;

describe("TranslateMissingDialog", () => {
  it("shows every suggestion for review and saves only what the admin keeps", async () => {
    const onSave = vi.fn();
    render(<TranslateMissingDialog open onOpenChange={() => {}} rows={rows} to="ar" field="clients.name" onSave={onSave} translator={translator} />);
    expect(translator).toHaveBeenCalledWith("clients.name", "en", "ar", ["Videos", "Read Surah Al-Fatiha", "Studio"], "en");
    await screen.findByTestId("translate-missing-review");
    expect(onSave).not.toHaveBeenCalled(); // never saved unseen

    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    expect(inputs.map((i) => i.value)).toEqual(["المرئيات", "", "الاستوديو"]);
    expect(inputs[0].lang).toBe("ar");
    expect(inputs[0].dir).toBe("rtl");
    // Quran text: refused, not fillable, explained
    expect(inputs[1].disabled).toBe(true);
    expect(screen.getByText(/never machine-translated/)).toBeTruthy();
    expect(screen.getByText("Quran app")).toBeTruthy(); // the current (copied) value is shown

    fireEvent.change(inputs[0], { target: { value: "مرئيات الأمة" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Save Studio" }));
    fireEvent.click(screen.getByRole("button", { name: "Save 1 reviewed" }));
    expect(onSave).toHaveBeenCalledWith([{ id: "c1", text: "مرئيات الأمة" }]);
  });

  it("shows the error with a retry; nothing is saved", async () => {
    const failing = vi.fn(async () => {
      throw new Error("You've reached today's translation limit. Try again tomorrow.");
    }) as unknown as typeof translateAll;
    render(<TranslateMissingDialog open onOpenChange={() => {}} rows={rows} to="ar" field="clients.name" onSave={vi.fn()} translator={failing} />);
    expect((await screen.findByRole("alert")).textContent).toContain("translation limit");
    expect((screen.getByRole("button", { name: /Save/ }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe("fieldTranslator", () => {
  it("is undefined when Translate is off (buttons hidden)", () => {
    expect(fieldTranslator(false, "clients.name")).toBeUndefined();
  });

  it("posts to this site's /api/translate and turns a Quran refusal into an error", async () => {
    const fetchMock = vi.fn(async () => Response.json({ items: [{ text: "", refused: "quran" }] }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const translate = fieldTranslator(true, "themes.name")!;
      await expect(translate("Al-Fatiha 1:1", "en", "ar")).rejects.toThrow(/never machine-translated/);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("/api/translate");
      expect(JSON.parse(String(init.body))).toEqual({ field: "themes.name", from: "en", to: "ar", texts: ["Al-Fatiha 1:1"] });
      expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i); // no secret from the browser
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("translateAll pages by 50", async () => {
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => Response.json({ items: JSON.parse(String(init.body)).texts.map((t: string) => ({ text: `ar:${t}` })) }));
    const texts = Array.from({ length: 120 }, (_, i) => `t${i}`);
    const out = await translateAll("clients.name", "en", "ar", texts, "en", fetchMock as unknown as typeof fetch);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(out[119]).toEqual({ text: "ar:t119" });
    await waitFor(() => expect(out.length).toBe(120));
  });
});
