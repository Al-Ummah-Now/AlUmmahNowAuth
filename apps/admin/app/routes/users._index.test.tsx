// @vitest-environment happy-dom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflareLoadContext } from "../lib/cloudflare-context";
import { pagesCopy } from "../lib/pages-copy";
import Users, { action, loader } from "./users._index";

const { api, requireStepUp } = vi.hoisted(() => ({
  api: {
    listUsers: vi.fn(),
    listRoles: vi.fn(),
    createUser: vi.fn(),
    updateUser: vi.fn(),
    getUserRoles: vi.fn(),
    assignUserRole: vi.fn(),
    removeUserRole: vi.fn(),
  },
  requireStepUp: vi.fn(),
}));
const admin = { id: "admin", email: "admin@example.com", roles: ["Admin"] };
const alice = {
  id: "alice",
  email: "alice@example.com",
  status: "invited",
  created_at: 1_700_000_000_000,
  roles: [{ id: "member", name: "Member" }, { id: "editor", name: "Editor" }],
};
const assignedRoles = alice.roles.map((role) => ({ ...role, expires_at: null }));
const allRoles = [...alice.roles, { id: "reviewer", name: "Reviewer" }, { id: "viewer", name: "Viewer" }];

vi.mock("../lib/auth.server", () => ({ requireAuth: async () => admin, requireStepUp }));
vi.mock("../lib/admin-api.server", async (original) => ({
  ...(await original<typeof import("../lib/admin-api.server")>()),
  ...api,
}));
vi.mock("../components/admin-layout", () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const context = cloudflareLoadContext({}, undefined);
const usersUrl = new URL("https://admin.example.com/users");
const post = (fields: Array<[string, string]>) =>
  action({
    context,
    params: {},
    url: usersUrl,
    pattern: "/users",
    request: new Request(usersUrl, { method: "POST", body: new URLSearchParams(fields) }),
  });
const edit = (...fields: Array<[string, string]>) => post([["intent", "editUser"], ["userId", alice.id], ...fields]);
const show = (lang = "en", users = [alice], roles = allRoles, query = "") => {
  const data = { users, allRoles: roles, user: admin, authServerUrl: "" };
  const Stub = createRoutesStub([{
    id: "users", path: "/users", Component: Users, loader: () => data,
    action: (args) => action({ ...args, context } as Parameters<typeof action>[0]),
  }]);
  render(<Stub initialEntries={[`/users?lang=${lang}${query}`]} hydrationData={{ loaderData: { users: data } }} />);
};
const editDialog = () => {
  fireEvent.click(screen.getAllByTitle(`Edit ${alice.email}`)[0]!);
  return within(screen.getByRole("dialog"));
};
const save = (dialog: ReturnType<typeof within>) => fireEvent.click(dialog.getByRole("button", { name: "Save" }));
const checked = (dialog: ReturnType<typeof within>, name: string) =>
  (dialog.getByRole("checkbox", { name }) as HTMLInputElement).checked;

beforeEach(() => {
  vi.resetAllMocks();
  api.createUser.mockResolvedValue({ id: alice.id });
  api.updateUser.mockResolvedValue({ id: alice.id });
  api.getUserRoles.mockResolvedValue({ roles: assignedRoles });
  api.assignUserRole.mockResolvedValue({ success: true });
  api.removeUserRole.mockResolvedValue({ success: true });
});
afterEach(cleanup);

describe("create user", () => {
  it.each([
    ["en", "No invitation email is sent."],
    ["ar", "لن تُرسل رسالة دعوة."],
  ] as const)("describes creation without an invitation in %s", (lang, sentence) => {
    show(lang);
    fireEvent.click(screen.getByRole("button", { name: pagesCopy(lang).users.create }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(sentence);
    expect(dialog.getAttribute("lang")).toBe(lang);
  });

  it("creates the account without sending an invitation and still assigns selected roles", async () => {
    expect(await post([["intent", "createUser"], ["email", alice.email], ["roleId", "member"], ["roleId", "editor"]]))
      .toEqual({ success: true, userId: alice.id });
    expect(api.createUser).toHaveBeenCalledWith(expect.anything(), admin, { email: alice.email, sendInvite: false });
    expect(api.assignUserRole.mock.calls.map((call) => call[3])).toEqual(["member", "editor"]);
  });
});

describe("edit user", () => {
  it("shows every assigned role and applies changes to more than the first role", async () => {
    show();
    const dialog = editDialog();
    expect(checked(dialog, "Member")).toBe(true);
    expect(checked(dialog, "Editor")).toBe(true);
    expect(checked(dialog, "Reviewer")).toBe(false);

    for (const name of ["Editor", "Reviewer", "Viewer"]) {
      fireEvent.click(dialog.getByRole("checkbox", { name }));
    }
    save(dialog);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.removeUserRole.mock.calls.map((call) => call[3])).toEqual(["editor"]);
    expect(api.assignUserRole.mock.calls.map((call) => call[3])).toEqual(["reviewer", "viewer"]);
    expect(api.updateUser).not.toHaveBeenCalled();
    expect(requireStepUp).toHaveBeenCalledWith(admin, expect.any(Request), "/users");
  });

  it("allows all roles to be removed in one save", async () => {
    show();
    const dialog = editDialog();
    fireEvent.click(dialog.getByRole("checkbox", { name: "Member" }));
    fireEvent.click(dialog.getByRole("checkbox", { name: "Editor" }));
    save(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.removeUserRole.mock.calls.map((call) => call[3])).toEqual(["member", "editor"]);
    expect(api.assignUserRole).not.toHaveBeenCalled();
  });

  it("preserves a roleless account and doesn't look up changes on an email-only save", async () => {
    show("en", [{ ...alice, roles: [] }]);
    const dialog = editDialog();
    expect(checked(dialog, "Member")).toBe(false);
    fireEvent.change(dialog.getByRole("textbox"), { target: { value: "new@example.com" } });
    save(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.updateUser).toHaveBeenCalledWith(expect.anything(), admin, alice.id, { email: "new@example.com" });
    expect(api.getUserRoles).not.toHaveBeenCalled();
    expect(api.assignUserRole).not.toHaveBeenCalled();
    expect(api.removeUserRole).not.toHaveBeenCalled();
  });

  it("shows each failed role operation and retries only the changes that did not save", async () => {
    api.removeUserRole.mockResolvedValueOnce({ error: "Removal temporarily unavailable" });
    api.assignUserRole.mockResolvedValueOnce({ error: "Assignment temporarily unavailable" });
    show();
    const dialog = editDialog();
    fireEvent.change(dialog.getByRole("textbox"), { target: { value: "new@example.com" } });
    for (const name of ["Editor", "Reviewer", "Viewer"]) {
      fireEvent.click(dialog.getByRole("checkbox", { name }));
    }
    save(dialog);

    const alert = await dialog.findByRole("alert");
    expect(alert.textContent).toContain("The email address was saved.");
    expect(alert.textContent).toContain("Couldn’t remove Editor");
    expect(alert.textContent).toContain("Couldn’t add Reviewer");
    expect(alert.textContent).not.toContain("Viewer");
    expect(checked(dialog, "Viewer")).toBe(true);
    expect(checked(dialog, "Editor")).toBe(false);

    api.getUserRoles.mockResolvedValue({ roles: [...assignedRoles, { id: "viewer", expires_at: null }, { id: "concurrent" }] });
    save(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(api.updateUser).toHaveBeenCalledTimes(1);
    expect(api.removeUserRole.mock.calls.map((call) => call[3])).toEqual(["editor", "editor"]);
    expect(api.assignUserRole.mock.calls.map((call) => call[3])).toEqual(["reviewer", "viewer", "reviewer"]);
  });

  it("keeps other changes intact if the email cannot be saved", async () => {
    api.updateUser.mockResolvedValue({ error: "Email already in use" });
    expect(await edit(["email", "taken@example.com"], ["addRoleId", "reviewer"], ["removeRoleId", "editor"]))
      .toEqual({ error: "Email already in use" });
    expect(api.assignUserRole).not.toHaveBeenCalled();
    expect(api.removeUserRole).not.toHaveBeenCalled();
  });

  it("reassigns a role when its previous assignment has expired", async () => {
    api.getUserRoles.mockResolvedValue({ roles: [{ id: "reviewer", expires_at: 1 }] });
    expect(await edit(["addRoleId", "reviewer"])).toEqual({ success: true });
    expect(api.assignUserRole).toHaveBeenCalledWith(expect.anything(), admin, alice.id, "reviewer");
  });

  it("skips role writes already applied by another request and deduplicates role IDs", async () => {
    api.getUserRoles.mockResolvedValue({ roles: [{ id: "viewer", expires_at: null }, { id: "concurrent" }] });
    expect(await edit(["addRoleId", "viewer"], ["addRoleId", "reviewer"], ["addRoleId", "reviewer"], ["removeRoleId", "editor"]))
      .toEqual({ success: true });
    expect(api.assignUserRole.mock.calls.map((call) => call[3])).toEqual(["reviewer"]);
    expect(api.removeUserRole).not.toHaveBeenCalled();
  });
});

it("passes the invited filter to Auth and shows the localized badge and Invites link", async () => {
  api.listUsers.mockResolvedValue({ users: [alice], pagination: {} });
  api.listRoles.mockResolvedValue([]);
  const url = new URL("https://admin.example.com/users?lang=ar&status=invited");
  const result = await loader({ context, params: {}, request: new Request(url), url, pattern: "/users" });
  expect(result.users[0]?.status).toBe("invited");
  expect(api.listUsers).toHaveBeenCalledWith(expect.anything(), admin, { skipCount: true, status: "invited" }, expect.any(Request));
  show("ar", [alice], allRoles, "&status=invited");
  expect(within(screen.getByRole("combobox", { name: "الحالة" })).getByRole("option", { selected: true }).getAttribute("value")).toBe("invited");
  expect(within(screen.getByTestId("user-card")).getByText("مدعو")).toBeTruthy();
  expect(screen.getByRole("link", { name: "عرض الدعوات" }).getAttribute("href")).toBe("/invites?lang=ar");
});
