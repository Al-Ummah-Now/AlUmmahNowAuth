// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflareLoadContext } from "../lib/cloudflare-context";
import Invites, { action, loader } from "./invites";

const { listInvites, revokeInvite, requireAuth, requireStepUp } = vi.hoisted(() => ({
  listInvites: vi.fn(), revokeInvite: vi.fn(), requireAuth: vi.fn(), requireStepUp: vi.fn(),
}));
vi.mock("../lib/auth.server", () => ({ requireAuth, requireStepUp }));
vi.mock("../lib/admin-api.server", async (original) => ({
  ...(await original<typeof import("../lib/admin-api.server")>()), listInvites, revokeInvite,
}));
vi.mock("../components/admin-layout", () => ({
  AdminLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const user = { id: "admin", email: "admin@example.com", roles: ["Admin"] };
const invite = {
  id: "inv_one", name: "Mariam", email: "invitee@example.com", invitedByUserId: "inviter",
  invitedByEmail: "inviter@example.com", status: "pending", clientName: "Videos", clientId: "videos",
  createdAt: Date.UTC(2026, 10, 15, 9, 30), expiresAt: Date.UTC(2026, 10, 29, 9, 30),
};
const context = cloudflareLoadContext({}, undefined);
const data = { user, invites: [invite], authServerUrl: "", nextCursor: "123|inv_one" };
const show = (lang: string, loadError?: string) => {
  const payload = loadError ? { ...data, invites: [], nextCursor: null, loadError } : data;
  const Stub = createRoutesStub([{
    id: "invites", path: "/invites", Component: Invites, loader: () => payload,
    action: (args) => action({ ...args, context } as Parameters<typeof action>[0]),
  }]);
  render(<Stub initialEntries={[`/invites?lang=${lang}&status=pending`]} hydrationData={{ loaderData: { invites: payload } }} />);
};

beforeEach(() => {
  vi.resetAllMocks();
  requireAuth.mockResolvedValue(user);
  listInvites.mockResolvedValue(data);
  revokeInvite.mockResolvedValue({ success: true });
});
afterEach(cleanup);

describe("Invites", () => {
  it.each([["en", "Invites", "Pending", /2026/, "ltr"], ["ar", "الدعوات", "قيد الانتظار", /٢٠٢٦/, "rtl"]])(
    "renders names, invite details and localized dates in %s",
    (lang, title, status, year, dir) => {
      show(lang);
      expect(screen.getByRole("heading", { name: title }).closest("[dir]")?.getAttribute("dir")).toBe(dir);
      expect(screen.getByText("Mariam")).toBeTruthy();
      expect(screen.getByText(invite.invitedByEmail)).toBeTruthy();
      expect(screen.getByText(invite.clientName)).toBeTruthy();
      const row = screen.getByRole("listitem");
      expect(within(row).getByText(status)).toBeTruthy();
      expect(row.querySelector("time")?.textContent).toMatch(year);
      expect(screen.getByRole("link").getAttribute("href")).toContain(`lang=${lang}&status=pending&cursor=`);
    },
  );

  it("loads filters with an authenticated admin and carries API failures into a load banner", async () => {
    listInvites.mockResolvedValue({ error: "Auth API unavailable" });
    const url = new URL("https://admin.example.com/invites?lang=en&search=mariam&status=pending&cursor=123");
    const result = await loader({ context, params: {}, request: new Request(url), url, pattern: "/invites" });
    expect(requireAuth).toHaveBeenCalledWith(expect.any(Request), expect.anything(), true);
    expect(listInvites.mock.calls[0]?.[2].toString()).toBe("search=mariam&status=pending&cursor=123");
    show("en", result.loadError);
    expect(screen.getByRole("alert").textContent).toContain("Auth API unavailable");
    expect(screen.queryByText("No invites match these filters.")).toBeNull();
  });

  it("only requests a revoke after confirmation and checks step-up first", async () => {
    show("en");
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(revokeInvite).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(revokeInvite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Invite revoked."));
    expect(requireStepUp).toHaveBeenCalledWith(user, expect.any(Request));
    expect(revokeInvite).toHaveBeenCalledWith(expect.anything(), user, invite.id, expect.any(Request));
    expect(requireStepUp.mock.invocationCallOrder[0]).toBeLessThan(revokeInvite.mock.invocationCallOrder[0]!);
  });

  it("stops a revoke when step-up redirects", async () => {
    const url = new URL("https://admin.example.com/invites?lang=ar");
    const redirect = Response.redirect("https://admin.example.com/login");
    requireStepUp.mockImplementation(() => { throw redirect; });
    const request = new Request(url, { method: "POST", body: new URLSearchParams({ id: invite.id, intent: "revoke" }) });
    await expect(action({ context, params: {}, request, url, pattern: "/invites" })).rejects.toBe(redirect);
    expect(revokeInvite).not.toHaveBeenCalled();
  });
});
