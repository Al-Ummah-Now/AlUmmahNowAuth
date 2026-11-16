/**
 * The admin pages the WebKit hydration check renders: each real route component inside a
 * React Router stub, with fixed loader data. The server (Node) renders it to HTML and the browser
 * hydrates the same tree, so any value that formats differently in Node and in the browser (plain
 * `ar` gives 0–9 in Node and ٠–٩ in WebKit) shows up as a hydration error (React #418).
 */
import { createRoutesStub, Outlet } from "react-router";
import RecentlyDeleted from "../app/routes/deleted";
import UserPasskeys from "../app/routes/users.$id.passkeys";
import Users from "../app/routes/users._index";

export type PageName = "deleted" | "users" | "passkeys";

const PAGES = {
  deleted: { path: "deleted", Component: RecentlyDeleted },
  users: { path: "users", Component: Users },
  passkeys: { path: "users/:id/passkeys", Component: UserPasskeys },
} as const;

// Fixed instants, so the server render and the browser agree on every date
const NOW = Date.UTC(2026, 10, 15, 9, 30);
const DAY = 86_400_000;
const ADMIN = { id: "admin-1", email: "admin@example.com" };

export const FIXTURES: Record<PageName, unknown> = {
  deleted: {
    kind: "user",
    now: NOW,
    user: ADMIN,
    authServerUrl: "",
    items: [
      { kind: "user", id: "u-1", label: "deleted@example.com", deletedAt: NOW - 3 * DAY, deletedBy: "self", deletedByEmail: null, reason: null, purgeAt: NOW + 27 * DAY, purgeRequestedAt: null, lastError: null },
      { kind: "user", id: "u-2", label: "old@example.com", deletedAt: NOW - 28 * DAY, deletedBy: "admin-1", deletedByEmail: "admin@example.com", reason: "Spam", purgeAt: NOW + 2 * DAY, purgeRequestedAt: null, lastError: null },
    ],
  },
  users: {
    users: [
      { id: "u-10", email: "first@example.com", name: "First", created_at: new Date(NOW - 40 * DAY).toISOString(), roles: [{ id: "r-1", name: "Admin" }] },
      { id: "u-11", email: "second@example.com", created_at: new Date(NOW - 2 * DAY).toISOString(), roles: [] },
    ],
    allRoles: [{ id: "r-1", name: "Admin", is_system: true }],
    user: ADMIN,
    authServerUrl: "",
    systemAccounts: [{ id: "system-1", email: "system@example.com", name: null, status: "active", deleted_at: null, roles: [] }],
  },
  passkeys: {
    user: ADMIN,
    authServerUrl: "",
    self: false,
    targetId: "u-10",
    targetEmail: "first@example.com",
    passkeys: [{ id: "pk-1", name: "Laptop", createdAt: NOW - 10 * DAY, lastUsedAt: NOW - DAY, synced: true, removedAt: null }],
    staff: true,
  },
};

const STUBS = Object.fromEntries(
  (Object.keys(PAGES) as PageName[]).map((name) => {
    const { path, Component } = PAGES[name];
    return [name, createRoutesStub([{ id: "root", path: "/", Component: Outlet, children: [{ id: "page", path, Component }] }])];
  }),
) as Record<PageName, ReturnType<typeof createRoutesStub>>;

export function PageApp({ page, url }: { page: PageName; url: string }) {
  const Stub = STUBS[page];
  return <Stub initialEntries={[url]} hydrationData={{ loaderData: { root: null, page: FIXTURES[page] } }} />;
}
