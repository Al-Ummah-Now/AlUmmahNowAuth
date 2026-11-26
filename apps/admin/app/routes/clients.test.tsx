// @vitest-environment happy-dom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CLIENT_SCOPES } from "../../../../packages/auth-contract/client-scopes";
import { cloudflareLoadContext } from "../lib/cloudflare-context";
import { pagesCopy } from "../lib/pages-copy";
import ClientsPage, { action } from "./clients";

const api = vi.hoisted(() => ({ createClient: vi.fn(), updateClient: vi.fn() }));
const admin = { id: "admin", email: "admin@example.com", roles: ["Admin"] };
const client = {
  client_id: "videos",
  name: "Videos",
  allowed_grants: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
  redirect_uris: ["alummahnow://auth/callback"],
  scopes: ["account-events:receive", "moderation:request", "legacy:custom"],
  metadata: {},
};

vi.mock("../lib/auth.server", () => ({ requireAuth: async () => admin }));
vi.mock("../lib/admin-api.server", async (original) => ({
  ...(await original<typeof import("../lib/admin-api.server")>()),
  ...api,
}));
vi.mock("../components/admin-layout", () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const context = cloudflareLoadContext({}, undefined);
const show = (lang: "en" | "ar") => {
  const data = { clients: [client], user: admin, authServerUrl: "" };
  const Stub = createRoutesStub([{
    id: "clients", path: "/clients", Component: ClientsPage, loader: () => data,
    action: (args) => action({ ...args, context } as Parameters<typeof action>[0]),
  }]);
  render(<Stub initialEntries={[`/clients?lang=${lang}`]} hydrationData={{ loaderData: { clients: data } }} />);
};
const scopeCheckbox = (dialog: ReturnType<typeof within>, name: string) =>
  dialog.getByRole("checkbox", { name, exact: true }) as HTMLInputElement;

beforeEach(() => {
  vi.resetAllMocks();
  api.createClient.mockResolvedValue({ client_id: "new", client_secret: "fake-test-secret" });
  api.updateClient.mockResolvedValue({ success: true });
});
afterEach(cleanup);

it.each(["en", "ar"] as const)("offers the full catalog with localized hints in %s", (lang) => {
  const t = pagesCopy(lang).clients;
  show(lang);
  fireEvent.click(screen.getByRole("button", { name: t.add }));
  const dialog = within(screen.getByRole("dialog"));

  for (const scope of CLIENT_SCOPES) {
    expect(scopeCheckbox(dialog, scope).closest("label")?.title).toBe(t.scopeHints[scope]);
    expect(t.scopeHints[scope]).toBeTruthy();
  }
  expect(Object.keys(t.scopeHints).sort()).toEqual([...CLIENT_SCOPES].sort());
});

it("creates a client with any of the Auth service scopes", async () => {
  show("en");
  const t = pagesCopy("en").clients;
  fireEvent.click(screen.getByRole("button", { name: t.add }));
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.change(dialog.getByRole("textbox", { name: t.nameLabel }), { target: { value: "Service Client" } });

  const serviceScopes = ["account-events:receive", "account-exports:write", "moderation:request", "invites:provision", "tokens:revoke"];
  for (const scope of serviceScopes) {
    fireEvent.click(scopeCheckbox(dialog, scope));
  }
  fireEvent.click(dialog.getByRole("button", { name: t.createButton }));

  await waitFor(() => expect(api.createClient).toHaveBeenCalledWith(expect.anything(), admin, expect.objectContaining({
    name: "Service Client",
    scopes: ["openid", "profile", "email", ...serviceScopes],
  })));
});

it("shows saved scopes and supports adding and removing them in the edit dialog", async () => {
  show("en");
  const t = pagesCopy("en").clients;
  fireEvent.click(screen.getAllByRole("button", { name: t.editOf(client.name) })[0]!);
  const dialog = within(screen.getByRole("dialog"));
  expect(scopeCheckbox(dialog, "account-events:receive").checked).toBe(true);
  expect(scopeCheckbox(dialog, "moderation:request").checked).toBe(true);
  expect(scopeCheckbox(dialog, "legacy:custom").checked).toBe(true);
  expect(scopeCheckbox(dialog, "account-exports:write").checked).toBe(false);

  fireEvent.click(scopeCheckbox(dialog, "moderation:request"));
  fireEvent.click(scopeCheckbox(dialog, "account-exports:write"));
  fireEvent.click(dialog.getByRole("button", { name: t.saveChanges }));

  await waitFor(() => expect(api.updateClient).toHaveBeenCalledWith(expect.anything(), admin, client.client_id, expect.objectContaining({
    scopes: ["account-events:receive", "legacy:custom", "account-exports:write"],
    grant_types: undefined,
    redirect_uris: undefined,
  })));
});
