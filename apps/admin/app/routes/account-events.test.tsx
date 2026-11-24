// @vitest-environment happy-dom
/** Admin > Account events (AlUmmahNowAuth#507): off, the loader and action, and the page. */
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorOf, accountEventsCopy } from "../lib/account-events-copy";
import type { AccountEventsView } from "../lib/admin-api.server";
import { cloudflareLoadContext } from "../lib/cloudflare-context";

const api = { getAccountEvents: vi.fn(), resendAccountEvent: vi.fn() };
vi.mock("../lib/auth.server", () => ({ requireAuth: async () => ({ id: "adm", email: "adm@example.com", roles: ["Admin"] }), requireStepUp: vi.fn() }));
vi.mock("../lib/admin-api.server", async (original) => ({
  ...(await original<typeof import("../lib/admin-api.server")>()),
  getAccountEvents: (...a: unknown[]) => api.getAccountEvents(...a),
  resendAccountEvent: (...a: unknown[]) => api.resendAccountEvent(...a),
}));
vi.mock("../lib/user-names.server", () => ({ userNames: async () => ({ usr_1: "Yusuf Rahman" }) }));
const { default: Page, action, loader } = await import("./account-events");

const JTI = "0f6f4f0e-5b0b-4d1c-9a51-000000000001";
const delivery = (over = {}) => ({ jti: JTI, seq: 1, clientId: "videos", type: "account-disabled", reason: "deleted", userId: "usr_1", status: "failed" as const, attempts: 7, error: "503", createdAt: 1_700_000_000_000, settledAt: 1_700_000_100_000, ...over });
const view = (over: Partial<AccountEventsView> = {}): AccountEventsView => ({
  clients: [{ clientId: "videos", name: "Videos", uri: "https://videos.example.com/events", types: ["account-disabled", "verification"], lastDeliveredAt: null, pending: 0, failed: 1000 }],
  status: "failed",
  deliveries: [delivery()],
  next: null,
  countLimit: 1000,
  ...over,
});
const args = (path: string, init: RequestInit = {}, on = "on") =>
  ({ request: new Request(`https://admin.example.com/account-events${path}`, init), context: cloudflareLoadContext({ ACCOUNT_EVENTS: on }, undefined), params: {} }) as never;
const post = (jti: string) => ({ method: "POST", body: new URLSearchParams({ jti }) });

beforeEach(() => {
  api.getAccountEvents.mockReset().mockResolvedValue(view());
  api.resendAccountEvent.mockReset().mockResolvedValue({ queued: true });
});
afterEach(cleanup);

describe("loader and action", () => {
  it.each(["off", ""])("ACCOUNT_EVENTS %j: 404, and Auth is not asked", async (on) => {
    await expect(loader(args("", {}, on))).rejects.toMatchObject({ status: 404 });
    await expect(action(args("", post(JTI), on))).rejects.toMatchObject({ status: 404 });
    expect(api.getAccountEvents).not.toHaveBeenCalled();
    expect(api.resendAccountEvent).not.toHaveBeenCalled();
  });
  it("off on the Auth server only: 404 too", async () => {
    api.getAccountEvents.mockResolvedValue({ error: "feature_off" });
    await expect(loader(args(""))).rejects.toMatchObject({ status: 404 });
  });
  it("failed ones first; a hand-edited link falls back instead of failing", async () => {
    await loader(args("?status=everything&client=a'b&before=x"));
    expect(api.getAccountEvents.mock.calls[0]![2]).toEqual({ status: "failed", client: undefined, before: undefined });
    const cursor = `1700000000000_${JTI}`;
    const data = await loader(args(`?status=delivered&client=videos&before=${cursor}`));
    expect(api.getAccountEvents.mock.calls[1]![2]).toEqual({ status: "delivered", client: "videos", before: cursor });
    expect(data.names).toEqual({ usr_1: "Yusuf Rahman" });
  });
  it("sends one delivery again, by its id", async () => {
    expect(await action(args("", post(JTI)))).toEqual({ ok: true, error: null });
    expect(api.resendAccountEvent.mock.calls[0]![2]).toBe(JTI);
    expect(await action(args("", post("x")))).toEqual({ ok: false, error: "generic" });
    expect(api.resendAccountEvent).toHaveBeenCalledTimes(1);
    api.resendAccountEvent.mockResolvedValue({ error: "not_failed" });
    expect(await action(args("", post(JTI)))).toEqual({ ok: false, error: "not_failed" });
  });
});

describe("the page", () => {
  // <dialog> is not modal in happy-dom
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };
  const show = (data: object, url = "/account-events", onSubmit = vi.fn(async () => ({ ok: true, error: null }))) => {
    const Stub = createRoutesStub([{ id: "root", path: "/", children: [{ id: "page", path: "account-events", Component: Page, loader: () => base(data), action: onSubmit as never }] }]);
    render(<Stub initialEntries={[url]} hydrationData={{ loaderData: { page: base(data) } }} />);
    return onSubmit;
  };
  const base = (data: object) => ({ user: { id: "adm", email: "adm@example.com" }, authServerUrl: "", status: "failed", view: view(), names: { usr_1: "Yusuf Rahman" }, ...data });
  const table = () => within(screen.getByTestId("account-events-deliveries"));

  it("the app's counts lead to its deliveries; past the limit the count says so", () => {
    show({});
    const links = screen.getAllByRole("link", { name: "Failed, Videos: 1,000+" });
    expect(links[0]!.getAttribute("href")).toContain("status=failed&client=videos");
    expect(table().getByText("Yusuf Rahman").closest("a")!.getAttribute("href")).toContain("/users?q=usr_1");
    expect(table().getByText("503")).toBeTruthy();
    expect(table().getByText("Deleted, can still be restored")).toBeTruthy();
  });
  it("an erased account by its id, a connection check by no account", () => {
    show({ view: view({ deliveries: [delivery({ userId: "usr_gone" }), delivery({ jti: `${JTI.slice(0, -1)}2`, userId: "", type: "verification", reason: null })] }) });
    expect(table().getByText("usr_gone").closest("a")).toBeNull();
    expect(table().getByText("No account")).toBeTruthy();
  });
  it("asks first, then sends exactly that delivery", async () => {
    const submitted = show({});
    fireEvent.click(table().getByRole("button", { name: /Send again/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("“Account disabled” is sent to Videos again");
    expect(submitted).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(table().getByRole("button", { name: /Send again/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Send again" }));
    expect((await screen.findByTestId("account-events-result")).textContent).toContain("Queued");
    expect(submitted).toHaveBeenCalledTimes(1);
  });
  it("says why it was not sent", async () => {
    show({}, "/account-events", vi.fn(async () => ({ ok: false, error: "not_subscribed" })) as never);
    fireEvent.click(table().getByRole("button", { name: /Send again/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Send again" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The app no longer receives this event, so it was not sent.");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Apps", "Deliveries"]);
  });
  it("Send again only on failed ones", () => {
    show({ status: "delivered", view: view({ status: "delivered", deliveries: [delivery({ status: "delivered", error: null })] }) });
    expect(screen.queryByRole("button", { name: /Send again/ })).toBeNull();
  });
  it("pages and filters keep the language; nothing to show says so", () => {
    show({ client: "videos", before: "1_x", view: view({ next: `5_${JTI}` }) }, "/account-events?client=videos&lang=ar");
    expect(screen.getByRole("link", { name: "الأقدم" }).getAttribute("href")).toContain(`status=failed&client=videos&before=5_${JTI}&lang=ar`);
    expect(screen.getByRole("link", { name: "الأحدث" }).getAttribute("href")).not.toContain("before");
    expect(screen.getByRole("link", { name: "عرض كل التطبيقات" }).getAttribute("href")).not.toContain("client");
    expect(screen.getAllByRole("link", { name: /١٠٠٠ أو أكثر/ }).length).toBeGreaterThan(0);
    cleanup();
    show({ view: view({ clients: [], deliveries: [] }) });
    expect(screen.getByText("No app receives account events yet.")).toBeTruthy();
    expect(screen.getByTestId("account-events-empty").textContent).toBe("Nothing failed.");
  });
});

it("says why a delivery failed", () => {
  const t = accountEventsCopy("en");
  expect(errorOf(t, null)).toBeNull();
  expect(errorOf(t, "400 invalid_key")).toEqual({ text: "The app answered", code: "400 invalid_key" });
  for (const error of ["timeout", "network error", "not subscribed", "could not be sent after every retry"]) expect(errorOf(t, error)!.text).not.toBe(t.errors.generic);
  expect(errorOf(t, "toString")!.text).toBe(t.errors.generic);
});
