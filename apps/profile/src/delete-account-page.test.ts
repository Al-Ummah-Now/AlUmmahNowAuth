/** Runs the delete page's own script (the source the page embeds) against a small document. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGES } from "./i18n";
import { deleteAccountScript, MAX_PASSES_PER_CONFIRMATION, renderDeleteAccountPage, REQUEST_TIMEOUT_MS } from "./page";

const AUTH = "https://auth.qa.alummahnow.net";
const USER = { id: "u-del-1", email: "delete-me@example.com", roles: ["Member"] };

type Listener = (ev: { target: unknown; preventDefault(): void; defaultPrevented: boolean }) => void;

class El {
  listeners: Record<string, Listener[]> = {};
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  value = "";
  textContent = "";
  disabled = false;
  open = false;
  focused = 0;
  addEventListener(type: string, fn: Listener) {
    (this.listeners[type] ??= []).push(fn);
  }
  dispatch(type: string) {
    const ev = { target: this as unknown, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const fn of this.listeners[type] ?? []) fn(ev);
    return ev;
  }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  focus() { this.focused++; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch("close"); }
}

interface Answer { status?: number; body?: unknown; raw?: string }

function load(o: { locale?: "en" | "ar"; stage?: "started" | "content_erased" } = {}) {
  const locale = o.locale ?? "en";
  const html = renderDeleteAccountPage({ locale, user: USER, authServerUrl: AUTH, stage: o.stage ?? null });
  const script = deleteAccountScript({ locale, userId: USER.id, startedBefore: Boolean(o.stage) });
  // The very source the page carries
  expect(html).toContain(script);
  const els: Record<string, El> = {};
  for (const id of ["deleteAccountBtn", "deleteAccountDialog", "deleteAccountForm", "deleteConfirmInput", "deleteDialogSubmit", "deleteDialogCancel", "deleteDialogStatus", "deleteDialogTitle", "deleteDialogBody", "deleteConfirmLabel"]) {
    expect(html).toContain(`id="${id}"`);
    els[id] = new El();
  }
  els.deleteDialogSubmit.disabled = true;
  const location = { href: "", reloads: 0, reload() { this.reloads++; } };
  const requests: { url: string; init: RequestInit; body: unknown }[] = [];
  const answers: (Answer | "network" | "hang" | "held")[] = [];
  let held: Promise<Response> | null = null;
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init, body: JSON.parse(String(init.body)) });
    const a = answers.shift() ?? "hang";
    if (a === "network") throw new TypeError("Failed to fetch");
    if (a === "held") return held!;
    if (a === "hang") return new Promise<Response>(() => {});
    return new Response(a.raw ?? JSON.stringify(a.body), { status: a.status ?? 200 });
  });
  // The pending request's own timeout is kept apart from the page's other timers
  const timers: { fn: () => void; ms: number }[] = [];
  const timeouts: { fn: () => void; id: number; cleared: boolean }[] = [];
  new Function("document", "window", "fetch", "setTimeout", "clearTimeout", script)(
    { getElementById: (id: string) => els[id] ?? null },
    { location },
    fetchFn,
    (fn: () => void, ms: number) => {
      if (ms === REQUEST_TIMEOUT_MS) return timeouts.push({ fn, id: timeouts.length + 1, cleared: false });
      return timers.push({ fn, ms });
    },
    (id: number) => { timeouts[id - 1].cleared = true; },
  );
  const t = MESSAGES[locale];
  const ui = {
    t, els, location, requests, answers, timers, timeouts,
    open: els.deleteAccountBtn, dialog: els.deleteAccountDialog, input: els.deleteConfirmInput, submit: els.deleteDialogSubmit,
    cancel: els.deleteDialogCancel, status: els.deleteDialogStatus, form: els.deleteAccountForm,
    type(word: string) { els.deleteConfirmInput.value = word; els.deleteConfirmInput.dispatch("input"); },
    hold(p: Promise<Response>) { held = p; },
    confirm(...a: (Answer | "network" | "hang" | "held")[]) {
      answers.push(...a);
      if (!els.deleteAccountDialog.open) els.deleteAccountBtn.dispatch("click");
      ui.type(t.deleteAccountConfirmWord);
      els.deleteAccountForm.dispatch("submit");
    },
    async settle() { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); },
  };
  return ui;
}

const MORE: Answer = { body: { deleted: false, complete: false } };

describe("the delete page's script", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("sends nothing until the word is typed, in either language", () => {
    for (const locale of ["en", "ar"] as const) {
      const ui = load({ locale });
      ui.open.dispatch("click");
      expect(ui.dialog.open).toBe(true);
      expect(ui.submit.disabled).toBe(true);
      expect(ui.cancel.focused).toBe(1);
      ui.form.dispatch("submit");
      for (const same of ["حذف", "DELETE", " حَذْف ", "حـــذف", "\u200Fحذف\u200E", " delete ", "Delete", "\u202ADELETE\u202C"]) {
        ui.type(same);
        expect(ui.submit.disabled, JSON.stringify(same)).toBe(false);
      }
      for (const other of ["احذف", "حذفا", "حذ", "DELET", "DELETE ME", "DELETE حذف", ""]) {
        ui.type(other);
        expect(ui.submit.disabled, JSON.stringify(other)).toBe(true);
      }
      expect(ui.requests).toEqual([]);
    }
  });

  it("sends the account it was opened for, never a token, and leaves for sign-out when done", async () => {
    const ui = load({ locale: "ar" });
    ui.confirm({ body: { deleted: true, complete: true, erased: true } });
    expect(ui.submit.disabled).toBe(true);
    expect(ui.cancel.disabled).toBe(true);
    expect(ui.input.disabled).toBe(true);
    expect(ui.status.textContent).toBe(ui.t.deleteAccountKeepOpen);
    await ui.settle();
    expect(ui.requests).toHaveLength(1);
    expect(ui.requests[0]).toMatchObject({ url: "/api/account", init: { method: "DELETE" }, body: { confirm: "DELETE", userId: USER.id } });
    expect(ui.location.href).toBe(`/logout?return=${encodeURIComponent("/delete-account?lang=ar")}`);
  });

  it("goes on pass after pass, numbers the steps in the page's digits, and says when the run began again", async () => {
    const ui = load({ locale: "ar" });
    ui.confirm(MORE, { body: { deleted: false, complete: false, restarted: true } }, "hang");
    await ui.settle();
    expect(ui.requests).toHaveLength(3);
    for (const r of ui.requests) expect(r.body).toEqual({ confirm: "DELETE", userId: USER.id });
    expect(ui.submit.textContent).toContain("٣");
    expect(ui.status.textContent).toBe(ui.t.deleteAccountRestarted);
  });

  it("a double submit sends one request", async () => {
    const ui = load();
    ui.confirm("hang");
    ui.form.dispatch("submit");
    ui.form.dispatch("submit");
    await ui.settle();
    expect(ui.requests).toHaveLength(1);
  });

  it("Esc, Cancel and the backdrop do nothing while a request is out, also a second Esc", () => {
    const ui = load();
    ui.confirm("hang");
    expect(ui.dialog.dispatch("cancel").defaultPrevented).toBe(true);
    ui.cancel.dispatch("click");
    ui.dialog.dispatch("click");
    expect(ui.dialog.open).toBe(true);
    ui.dialog.close();
    expect(ui.dialog.open).toBe(true);
    expect(ui.location.reloads).toBe(0);
  });

  it("closing before anything was sent changes nothing; after a pass it reloads so the page says so", async () => {
    const ui = load();
    ui.open.dispatch("click");
    ui.dialog.dispatch("cancel");
    expect(ui.dialog.open).toBe(false);
    expect(ui.location.reloads).toBe(0);
    ui.confirm(MORE, { status: 502, body: { error: "videos_erasure_failed", started: true } });
    await ui.settle();
    expect(ui.status.textContent).toBe(ui.t.deleteAccountErrorStarted);
    ui.cancel.dispatch("click");
    expect(ui.location.reloads).toBe(1);
  });

  it("says what is known after each failure, and lets the person try again with the step count restarted", async () => {
    for (const [answer, message] of [
      [{ status: 502, body: { error: "videos_erasure_refused", started: false } }, "deleteAccountErrorNothing"],
      [{ status: 502, body: { error: "videos_erasure_failed", started: true } }, "deleteAccountErrorStarted"],
      [{ status: 502, body: { error: "account_deletion_failed", started: true, contentErased: true } }, "deleteAccountContentErasedError"],
      ["network", "deleteAccountErrorUnknown"],
      [{ status: 500, raw: "Internal Server Error" }, "deleteAccountErrorUnknown"],
      [{ status: 502, body: {} }, "deleteAccountErrorUnknown"],
    ] as const) {
      const ui = load();
      ui.confirm(answer as Answer);
      await ui.settle();
      expect(ui.status.textContent).toBe(ui.t[message]);
      expect(ui.status.attrs["data-tone"]).toBe("error");
      expect(ui.submit.disabled).toBe(false);
      expect(ui.location.href).toBe("");
      ui.confirm("hang");
      expect(ui.submit.textContent).toBe(ui.t.deleteAccountDeleting);
      expect(ui.requests).toHaveLength(2);
    }
  });

  it("a pause keeps the button off until the time is up, and says whether something may be gone", async () => {
    for (const [body, message] of [
      [{ error: "resume_unavailable", started: true, retryAfter: 300 }, "deleteAccountPaused"],
      [{ error: "resume_unavailable", started: true, retryAfter: 3600 }, "deleteAccountPausedLater"],
      [{ error: "videos_busy", started: false, retryAfter: 60 }, "deleteAccountBusyNothing"],
    ] as const) {
      const ui = load();
      ui.confirm({ status: 503, body });
      await ui.settle();
      expect(ui.status.textContent).toBe(ui.t[message]);
      expect(ui.submit.disabled).toBe(true);
      expect(ui.cancel.disabled).toBe(false);
      ui.form.dispatch("submit");
      expect(ui.requests).toHaveLength(1);
      expect(ui.timers[0].ms).toBe(body.retryAfter * 1000);
      ui.timers[0].fn();
      expect(ui.submit.disabled).toBe(false);
    }
  });

  it("goes to the page's sign-in state when a sign-in is needed, whatever the reason", async () => {
    for (const [status, error] of [[401, "insufficient_user_authentication"], [409, "content_erased_reauth_required"], [401, "not_authenticated"]] as const) {
      const ui = load({ locale: "ar" });
      ui.confirm({ status, body: { error, started: true } });
      await ui.settle();
      expect(ui.location.href).toBe("/delete-account?reauth=1&lang=ar");
      // Should that page not come: not stuck, and nothing can be sent again
      expect([ui.cancel.disabled, ui.submit.disabled]).toEqual([false, true]);
    }
  });

  it("stops and reloads when the account changed in another tab, and sends nothing until then", async () => {
    const ui = load();
    ui.confirm({ status: 409, body: { error: "account_mismatch" } });
    await ui.settle();
    expect(ui.status.textContent).toBe(ui.t.deleteAccountMismatch);
    expect(ui.submit.disabled).toBe(true);
    expect(ui.submit.textContent).toBe(ui.t.deleteAccountConfirmAction);
    ui.form.dispatch("submit");
    expect(ui.requests).toHaveLength(1);
    ui.timers[0].fn();
    expect(ui.location.reloads).toBe(1);
  });

  it("what stays behind is said before the account goes, and only a second confirmation goes on", async () => {
    for (const [leftover, message] of [["channel", "deleteAccountLeftChannel"], ["other", "deleteAccountLeftOther"]] as const) {
      const ui = load();
      ui.confirm({ body: { deleted: false, complete: false, leftover } });
      await ui.settle();
      expect(ui.requests).toHaveLength(1);
      expect(ui.status.textContent).toBe(ui.t[message]);
      expect(ui.submit.textContent).toBe(ui.t.deleteAccountAnyway);
      expect(ui.submit.disabled).toBe(false);
      expect(ui.location.href).toBe("");
      ui.confirm({ body: { deleted: true, complete: true, erased: true, leftover } });
      await ui.settle();
      expect(ui.requests[1].body).toEqual({ confirm: "DELETE", userId: USER.id, acceptLeftover: leftover });
      expect(ui.location.href).toContain("/logout");
    }
    const ui = load();
    ui.confirm({ body: { deleted: false, complete: false, leftover: "channel" } });
    await ui.settle();
    ui.cancel.dispatch("click");
    expect(ui.location.reloads).toBe(1);
    ui.confirm("hang");
    expect(ui.requests[1].body).toEqual({ confirm: "DELETE", userId: USER.id });
  });

  it("asks again after a bounded number of passes", async () => {
    const ui = load();
    ui.confirm(...Array.from({ length: MAX_PASSES_PER_CONFIRMATION + 5 }, () => MORE));
    for (let i = 0; i < 20; i++) await ui.settle();
    expect(ui.requests).toHaveLength(MAX_PASSES_PER_CONFIRMATION);
    expect(ui.status.textContent).toBe(ui.t.deleteAccountMore);
    expect(ui.submit.disabled).toBe(false);
  });

  it("confirms in the dialog when the page after sign-out could not be told, with a focused Done and Esc to leave", async () => {
    for (const [answer, body] of [
      [{ erased: true }, "deleteAccountDoneBody"],
      [{ erased: false }, "deleteAccountDoneBodyAccount"],
      [{ erased: true, leftover: "channel" }, "deleteAccountDoneBodyChannel"],
      [{ erased: true, leftover: "other" }, "deleteAccountDoneBodyOther"],
    ] as const) {
      for (const way of ["button", "Esc", "backdrop"]) {
        const ui = load();
        ui.confirm({ body: { deleted: true, complete: true, ...answer, confirmed: false } });
        const focusedBefore = ui.cancel.focused;
        await ui.settle();
        expect(ui.status.textContent).toBe(`${ui.t[body]} ${ui.t.deleteAccountDonePurge.replace("{days}", "30")}`);
        expect(ui.els.deleteDialogTitle.textContent).toBe(ui.t.deleteAccountDoneTitle);
        for (const el of [ui.submit, ui.input]) expect(el.style.display).toBe("none");
        expect([ui.cancel.textContent, ui.cancel.disabled, ui.cancel.style.display]).toEqual([ui.t.deleteAccountDoneButton, false, undefined]);
        expect(ui.cancel.focused).toBe(focusedBefore + 1);
        // It stays until they leave
        expect(ui.timers).toEqual([]);
        expect(ui.location.href).toBe("");
        if (way === "button") ui.cancel.dispatch("click");
        else if (way === "Esc") ui.dialog.dispatch("cancel");
        else ui.dialog.dispatch("click");
        expect(ui.location.href).toBe(`/logout?return=${encodeURIComponent("/delete-account")}`);
        expect(ui.location.reloads).toBe(0);
        ui.form.dispatch("submit");
        expect(ui.requests).toHaveLength(1);
      }
    }
  });

  it("sign-out that does not come after a deletion: the dialog says it is done, with Done and Esc", async () => {
    const ui = load();
    ui.confirm({ body: { deleted: true, complete: true, erased: true } });
    await ui.settle();
    expect(ui.location.href).toContain("/logout");
    ui.location.href = "";
    expect(ui.timers).toHaveLength(1);
    ui.timers[0].fn();
    expect(ui.els.deleteDialogTitle.textContent).toBe(ui.t.deleteAccountDoneTitle);
    expect([ui.cancel.textContent, ui.cancel.disabled]).toEqual([ui.t.deleteAccountDoneButton, false]);
    ui.dialog.dispatch("cancel");
    expect(ui.location.href).toContain("/logout");
  });

  it("a request that never answers gives the dialog back; its late answer changes nothing", async () => {
    const ui = load();
    let answer: (r: Response) => void = () => {};
    ui.hold(new Promise<Response>((r) => { answer = r; }));
    ui.confirm("held");
    expect(ui.cancel.disabled).toBe(true);
    ui.timeouts[0].fn();
    expect(ui.status.textContent).toBe(ui.t.deleteAccountErrorUnknown);
    expect([ui.cancel.disabled, ui.submit.disabled]).toEqual([false, false]);
    answer(new Response(JSON.stringify({ deleted: false, complete: false })));
    await ui.settle();
    expect(ui.requests).toHaveLength(1);
    expect(ui.status.textContent).toBe(ui.t.deleteAccountErrorUnknown);
    ui.cancel.dispatch("click");
    expect(ui.location.reloads).toBe(1);

    const quick = load();
    quick.confirm({ status: 502, body: { error: "videos_erasure_failed", started: true } });
    await quick.settle();
    expect(quick.timeouts[0].cleared).toBe(true);
  });

  it("every state the dialog can stop in has an enabled way out", async () => {
    for (const a of [
      { status: 502, body: { error: "x", started: false } }, { status: 502, body: { error: "x", started: true } },
      { status: 502, body: { error: "x", started: true, contentErased: true } }, "network",
      { status: 503, body: { error: "resume_unavailable", started: true, retryAfter: 300 } },
      { status: 503, body: { error: "videos_busy", started: false, retryAfter: 60 } },
      { status: 409, body: { error: "account_mismatch" } },
      { body: { deleted: false, complete: false, leftover: "channel" } }, { body: { deleted: false, complete: false, leftover: "other" } },
      { body: { deleted: true, complete: true, erased: true, confirmed: false } },
    ] as (Answer | "network")[]) {
      const ui = load();
      ui.confirm(a);
      await ui.settle();
      expect(ui.cancel.disabled, JSON.stringify(a)).toBe(false);
      ui.dialog.dispatch("cancel");
      expect(ui.dialog.open && ui.location.href === "", JSON.stringify(a)).toBe(false);
    }
  });

  it("an unfinished deletion offers to finish, and closing its dialog does not reload", () => {
    const ui = load({ stage: "started" });
    ui.open.dispatch("click");
    ui.cancel.dispatch("click");
    expect(ui.location.reloads).toBe(0);
    const html = renderDeleteAccountPage({ locale: "en", user: USER, authServerUrl: AUTH, stage: "started" });
    expect(html).toContain(MESSAGES.en.deleteAccountFinishButton);
  });
});
