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
import AuditLogs from "../app/routes/audit";
import SessionsPage from "../app/routes/sessions";
import ClientsPage from "../app/routes/clients";

export type PageName = "deleted" | "users" | "passkeys" | "audit" | "sessions" | "clients";

const PAGES = {
  deleted: { path: "deleted", Component: RecentlyDeleted },
  users: { path: "users", Component: Users },
  passkeys: { path: "users/:id/passkeys", Component: UserPasskeys },
  audit: { path: "audit", Component: AuditLogs },
  sessions: { path: "sessions", Component: SessionsPage },
  clients: { path: "clients", Component: ClientsPage },
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
      { kind: "user", id: "u-1", label: "deleted@example.com", name: "Amina Yusuf", deletedAt: NOW - 3 * DAY, deletedBy: "self", deletedByEmail: null, reason: null, purgeAt: NOW + 27 * DAY, purgeRequestedAt: null, lastError: null },
      { kind: "user", id: "u-2", label: "old@example.com", deletedAt: NOW - 28 * DAY, deletedBy: "admin-1", deletedByEmail: "admin@example.com", deletedByName: "Omar Saleh", reason: "رسائل مزعجة متكررة", purgeAt: NOW + 2 * DAY, purgeRequestedAt: null, lastError: null },
    ],
  },
  users: {
    users: [
      { id: "u-10", email: "yusuf.rahman@example.com", name: "Yusuf Rahman", created_at: new Date(NOW - 40 * DAY).toISOString(), roles: [{ id: "r-1", name: "Admin" }] },
      { id: "u-12", email: "maryam.alhassan@example.com", name: "مريم الحسن", created_at: new Date(NOW - 12 * DAY).toISOString(), roles: [{ id: "r-2", name: "Moderator" }] },
      { id: "u-11", name: "", email: "khadija.noor@example.com", created_at: new Date(NOW - 2 * DAY).toISOString(), roles: [] },
    ],
    allRoles: [{ id: "r-1", name: "Admin", is_system: true }, { id: "r-2", name: "Moderator", is_system: false }],
    user: ADMIN,
    authServerUrl: "",
    systemAccounts: [{ id: "system-1", email: "system@example.com", name: null, status: "active", deleted_at: null, roles: [] }],
  },
  passkeys: {
    user: ADMIN,
    authServerUrl: "",
    self: false,
    targetId: "u-10",
    targetEmail: "yusuf.rahman@example.com",
    passkeys: [{ id: "pk-1", name: "Laptop", createdAt: NOW - 10 * DAY, lastUsedAt: NOW - DAY, synced: true, removedAt: null }],
    staff: true,
  },
  audit: {
    events: [
      { id: 1, timestamp: new Date(NOW - 3_600_000).toISOString(), event_type: "auth.login.success", severity: "info", user_id: "u-10", ip_address: "203.0.113.7", user_agent: null, success: true, error_message: null, metadata: {} },
      { id: 2, timestamp: new Date(NOW - 7_200_000).toISOString(), event_type: "auth.login.failure", severity: "warning", user_id: "u-gone", ip_address: "198.51.100.4", user_agent: null, success: false, error_message: null, metadata: {} },
    ],
    pagination: { page: 1, limit: 50, total: 120, pages: 3 },
    filters: {},
    user: ADMIN,
    authServerUrl: "",
    names: { "u-10": "Amina Yusuf" },
  },
  sessions: {
    sessions: [
      { id: "s-1", userId: "u-10", email: "yusuf.rahman@example.com", authenticatedAt: (NOW - DAY) / 1000, lastUsed: (NOW - 600_000) / 1000, isActive: true, device: { ipAddress: "203.0.113.7", userAgent: "Mozilla/5.0 (Macintosh)" }, lastActivity: (NOW - 600_000) / 1000 },
      { id: "s-2", userId: "u-11", email: "khadija.noor@example.com", authenticatedAt: (NOW - 3 * DAY) / 1000, lastUsed: (NOW - 2 * DAY) / 1000, isActive: false, device: { ipAddress: "198.51.100.4", userAgent: "Mozilla/5.0 (iPhone)" }, lastActivity: (NOW - 2 * DAY) / 1000 },
    ],
    stats: { totalSessions: 1250, activeSessions: 37, loginsLast24h: 412, uniqueUsers: 900 },
    suspicious: { multipleIPsInShortTime: [{ userId: "u-11", email: "khadija.noor@example.com", ipCount: 4, ipAddresses: ["198.51.100.4", "198.51.100.9"] }], failedThenSuccessfulLogins: [] },
    total: 1250,
    user: ADMIN,
    authServerUrl: "",
  },
  clients: {
    clients: [
      { id: "c-1", client_id: "1448ed27-39a6-417d-b4c8-07f881e81269", name: "Accounts admin", client_type: "confidential", allowed_grants: ["authorization_code", "refresh_token"], redirect_uris: ["https://admin.example.com/auth/callback", "https://admin.example.com/b", "https://admin.example.com/c"], scopes: ["openid", "profile", "email", "offline_access"], metadata: {}, enabled: true, created_at: (NOW - 30 * DAY) / 1000 },
    ],
    user: ADMIN,
    authServerUrl: "",
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
