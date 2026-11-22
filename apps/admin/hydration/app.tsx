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
import Dashboard from "../app/routes/_index";
import Roles from "../app/routes/roles._index";
import RoleDetail from "../app/routes/roles.$id";
import ModerationRequests from "../app/routes/moderation._index";
import ModerationRequest from "../app/routes/moderation.$id";
import Themes from "../app/routes/themes._index";
import ThemeBuilder from "../app/routes/themes.$id";
import Security from "../app/routes/security";
import SigningKeys from "../app/routes/signing-keys";
import { BUILTIN_IDS, builtinPackage } from "../../../packages/ui/src/auth-theme/builtin.ts";
import type { AuthThemeJson } from "../../../packages/ui/src/auth-theme/types.ts";
import { swatchesOf } from "../app/lib/theme-builder";

export type PageName =
  | "deleted" | "users" | "passkeys" | "audit" | "sessions" | "clients"
  | "dashboard" | "roles" | "role" | "moderation" | "moderation-request" | "themes" | "theme" | "security" | "signing-keys";

/** Every page's path in the admin (with ?lang= added by the server). */
export const PAGE_PATHS: Record<PageName, string> = {
  deleted: "/deleted", users: "/users", passkeys: "/users/u-10/passkeys", audit: "/audit", sessions: "/sessions", clients: "/clients",
  dashboard: "/", roles: "/roles", role: "/roles/r-2", moderation: "/moderation", "moderation-request": "/moderation/mr-1",
  themes: "/themes", theme: "/themes/fawanees", security: "/security", "signing-keys": "/signing-keys",
};

const PAGES = {
  deleted: { path: "deleted", Component: RecentlyDeleted },
  users: { path: "users", Component: Users },
  passkeys: { path: "users/:id/passkeys", Component: UserPasskeys },
  audit: { path: "audit", Component: AuditLogs },
  sessions: { path: "sessions", Component: SessionsPage },
  clients: { path: "clients", Component: ClientsPage },
  dashboard: { path: "", Component: Dashboard },
  roles: { path: "roles", Component: Roles },
  role: { path: "roles/:id", Component: RoleDetail },
  moderation: { path: "moderation", Component: ModerationRequests },
  "moderation-request": { path: "moderation/:id", Component: ModerationRequest },
  themes: { path: "themes", Component: Themes },
  theme: { path: "themes/:id", Component: ThemeBuilder },
  security: { path: "security", Component: Security },
  "signing-keys": { path: "signing-keys", Component: SigningKeys },
} as const;

// Fixed instants, so the server render and the browser agree on every date
const NOW = Date.UTC(2026, 10, 15, 9, 30);
const DAY = 86_400_000;
/** An instant before NOW, at irregular times like real data: ago(3, 2, 17, 43) is 3 days 2h 17m 43s ago */
const ago = (days: number, hours = 0, minutes = 0, seconds = 0) => NOW - (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;

// Sessions page 1 of 25 (1,250 sessions, 50 a page): rows made by a fixed generator, so the
// server render and the browser agree, newest activity first, the active ones used in the last hour.
const PEOPLE = [
  ["u-10", "yusuf.rahman"], ["u-11", "khadija.noor"], ["u-12", "maryam.alhassan"], ["u-13", "ibrahim.saeed"],
  ["u-14", "fatima.zahra"], ["u-15", "bilal.hamdan"], ["u-16", "aisha.karim"], ["u-17", "zaid.mansour"],
  ["u-18", "huda.qasim"], ["u-19", "tariq.aziz"], ["u-20", "safiya.omar"], ["u-21", "idris.farouk"],
] as const;
const DEVICES = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0",
];
let seed = 20261115;
// The high bits: an LCG's low bits repeat in short cycles
const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), Math.floor(seed / 65536) % n);
const SESSION_ROWS = Array.from({ length: 50 }, (_, i) => {
  const [userId, handle] = PEOPLE[rand(PEOPLE.length)];
  // i 0–9 within the last hour, then further back
  const lastUsed = i < 10 ? ago(0, 0, i * 5 + rand(5), rand(60)) : ago(Math.floor(i / 8), rand(24), rand(60), rand(60));
  const signedIn = lastUsed - (rand(3) * DAY + rand(86_400) * 1000);
  return {
    id: `s-${100 + i}`, userId, email: `${handle}@mail.alummahnow.net`,
    authenticatedAt: Math.floor(signedIn / 1000), lastUsed: Math.floor(lastUsed / 1000), lastActivity: Math.floor(lastUsed / 1000),
    isActive: lastUsed >= NOW - 3_600_000,
    device: { ipAddress: i % 2 ? `198.51.100.${10 + rand(200)}` : `203.0.113.${10 + rand(200)}`, userAgent: DEVICES[rand(DEVICES.length)] },
  };
}).sort((x, y) => y.lastUsed - x.lastUsed);
const NAMES: Record<string, string> = {
  "u-10": "Yusuf Rahman", "u-11": "Khadija Noor", "u-12": "مريم الحسن", "u-13": "Ibrahim Saeed", "u-14": "Fatima Zahra", "u-15": "Bilal Hamdan",
  "u-16": "Aisha Karim", "u-17": "Zaid Mansour", "u-18": "Huda Qasim", "u-19": "Tariq Aziz", "u-20": "Safiya Omar", "u-21": "Idris Farouk",
};
// Everyone who signed in within 24h was active since, so all of them are on this newest-first page
const LOGINS_24H = SESSION_ROWS.filter((r) => r.authenticatedAt * 1000 >= NOW - DAY).length;
// The audit's sign-in is the newest session's sign-in: same person, time and IP
const NEWEST_SIGN_IN = SESSION_ROWS.reduce((a, b) => (b.authenticatedAt > a.authenticatedAt ? b : a));
const ADMIN = { id: "admin-1", email: "omar.saleh@mail.alummahnow.net" };

export const FIXTURES: Record<string, unknown> = {
  deleted: {
    kind: "user",
    now: NOW,
    user: ADMIN,
    authServerUrl: "",
    items: [
      { kind: "user", id: "u-1", label: "amina.yusuf@mail.alummahnow.net", name: "Amina Yusuf", deletedAt: ago(3, 4, 12, 37), deletedBy: "self", deletedByEmail: null, reason: null, purgeAt: ago(3, 4, 12, 37) + 30 * DAY, purgeRequestedAt: null, lastError: null },
      { kind: "user", id: "u-2", label: "hamza.idris@mail.alummahnow.net", name: "Hamza Idris", deletedAt: ago(27, 19, 48, 5), deletedBy: "admin-1", deletedByEmail: "omar.saleh@mail.alummahnow.net", deletedByName: "Omar Saleh", reason: "رسائل مزعجة متكررة", purgeAt: ago(27, 19, 48, 5) + 30 * DAY, purgeRequestedAt: null, lastError: null },
    ],
  },
  users: {
    users: [
      { id: "admin-1", email: "omar.saleh@mail.alummahnow.net", name: "Omar Saleh", created_at: new Date(ago(71, 4, 22, 9)).toISOString(), roles: [{ id: "r-1", name: "Admin" }] },
      { id: "u-10", email: "yusuf.rahman@mail.alummahnow.net", name: "Yusuf Rahman", created_at: new Date(ago(40, 6, 3, 51)).toISOString(), roles: [{ id: "r-1", name: "Admin" }] },
      { id: "u-12", email: "maryam.alhassan@mail.alummahnow.net", name: "مريم الحسن", created_at: new Date(ago(12, 2, 44, 18)).toISOString(), roles: [{ id: "r-2", name: "Moderator" }] },
      { id: "u-11", name: "Khadija Noor", email: "khadija.noor@mail.alummahnow.net", created_at: new Date(ago(19, 11, 26, 9)).toISOString(), roles: [] },
      { id: "u-13", name: "Ibrahim Saeed", email: "ibrahim.saeed@mail.alummahnow.net", created_at: new Date(ago(22, 8, 14, 3)).toISOString(), roles: [] },
      { id: "u-14", name: "Fatima Zahra", email: "fatima.zahra@mail.alummahnow.net", created_at: new Date(ago(25, 1, 37, 55)).toISOString(), roles: [] },
      { id: "u-15", name: "Bilal Hamdan", email: "bilal.hamdan@mail.alummahnow.net", created_at: new Date(ago(31, 14, 2, 41)).toISOString(), roles: [] },
      { id: "u-16", name: "Aisha Karim", email: "aisha.karim@mail.alummahnow.net", created_at: new Date(ago(33, 9, 51, 17)).toISOString(), roles: [] },
      { id: "u-17", name: "Zaid Mansour", email: "zaid.mansour@mail.alummahnow.net", created_at: new Date(ago(36, 20, 8, 29)).toISOString(), roles: [] },
      { id: "u-18", name: "Huda Qasim", email: "huda.qasim@mail.alummahnow.net", created_at: new Date(ago(44, 3, 45, 12)).toISOString(), roles: [] },
      { id: "u-19", name: "Tariq Aziz", email: "tariq.aziz@mail.alummahnow.net", created_at: new Date(ago(51, 17, 19, 48)).toISOString(), roles: [] },
      { id: "u-20", name: "Safiya Omar", email: "safiya.omar@mail.alummahnow.net", created_at: new Date(ago(58, 6, 33, 6)).toISOString(), roles: [] },
      { id: "u-21", name: "Idris Farouk", email: "idris.farouk@mail.alummahnow.net", created_at: new Date(ago(63, 12, 57, 34)).toISOString(), roles: [] },
    ],
    allRoles: [{ id: "r-1", name: "Admin", is_system: true }, { id: "r-2", name: "Moderator", is_system: false }],
    user: ADMIN,
    authServerUrl: "",
    systemAccounts: [{ id: "system-1", email: "notifications@mail.alummahnow.net", name: "Al Ummah Now notifications", status: "active", deleted_at: null, roles: [] }],
  },
  passkeys: {
    user: ADMIN,
    authServerUrl: "",
    self: false,
    targetId: "u-10",
    targetEmail: "yusuf.rahman@mail.alummahnow.net",
    passkeys: [{ id: "pk-1", name: "Laptop", createdAt: ago(10, 3, 51, 22), lastUsedAt: ago(1, 1, 7, 46), synced: true, removedAt: null }],
    staff: true,
    // passkey.add_failed audit events (the loader maps them), newest first: the times render in the browser's zone
    failures: [
      { id: 412, at: new Date(ago(10, 4, 2, 9)).toISOString(), reason: "cancelled", browser: "Safari", os: "iOS" },
      { id: 409, at: new Date(ago(10, 4, 5, 31)).toISOString(), reason: "network", browser: "Chrome", os: "Android" },
    ],
  },
  audit: {
    events: [
      { id: 1, timestamp: new Date(NEWEST_SIGN_IN.authenticatedAt * 1000).toISOString(), event_type: "auth.login.success", severity: "info", user_id: NEWEST_SIGN_IN.userId, ip_address: NEWEST_SIGN_IN.device.ipAddress, user_agent: null, success: true, error_message: null, metadata: {} },
      { id: 2, timestamp: new Date(ago(0, 2, 13, 38)).toISOString(), event_type: "auth.login.failure", severity: "warning", user_id: "u-11", ip_address: "198.51.100.4", user_agent: null, success: false, error_message: null, metadata: {} },
    ].sort((x, y) => Date.parse(y.timestamp) - Date.parse(x.timestamp)),
    pagination: { page: 1, limit: 50, total: 2, pages: 1 },
    filters: {},
    user: ADMIN,
    authServerUrl: "",
    names: NAMES,
  },
  sessions: {
    sessions: SESSION_ROWS,
    stats: { totalSessions: 1250, activeSessions: 10, loginsLast24h: LOGINS_24H, uniqueUsers: 900 },
    suspicious: { multipleIPsInShortTime: [{ userId: "u-11", email: "khadija.noor@mail.alummahnow.net", ipCount: 4, ipAddresses: ["198.51.100.4", "198.51.100.9", "203.0.113.58", "203.0.113.121"] }], failedThenSuccessfulLogins: [] },
    total: 1250,
    limit: 50,
    offset: 0,
    user: ADMIN,
    authServerUrl: "",
  },
  clients: {
    clients: [
      { id: "c-1", client_id: "1448ed27-39a6-417d-b4c8-07f881e81269", name: "Accounts admin", client_type: "confidential", allowed_grants: ["authorization_code", "refresh_token"], redirect_uris: ["https://admin.auth.alummahnow.net/auth/callback", "https://admin.auth.stage.alummahnow.net/auth/callback", "https://admin.auth.qa.alummahnow.net/auth/callback"], scopes: ["openid", "profile", "email", "offline_access"], metadata: {}, enabled: true, created_at: Math.floor(ago(30, 5, 9, 14) / 1000) },
    ],
    user: ADMIN,
    authServerUrl: "",
  },
};


// ---------------------------------------------------------------- the other admin pages

const iso = (ms: number) => new Date(ms).toISOString();
const sec = (ms: number) => Math.floor(ms / 1000);
const PERMS = [
  ["p-1", "users:read", "users", "read", "See user accounts"],
  ["p-2", "users:write", "users", "write", "Change user accounts"],
  ["p-3", "content:moderate", "content", "moderate", "Hide and restore content"],
  ["p-4", "audit:read", "audit", "read", "Read the audit log"],
  ["p-5", "roles:read", "roles", "read", "See roles"],
].map(([id, name, resource, action, description]) => ({ id, name, resource, action, description, is_system: true, created_at: sec(ago(200)) }));
const byResource = (list: typeof PERMS) => list.reduce<Record<string, typeof PERMS>>((m, p) => ((m[p.resource] ??= []).push(p), m), {});

const MOD_REQUEST = {
  id: "mr-1", status: "pending", subject_user_id: "u-17", action: "suspend_account", reason_category: "spam",
  reason: "Posts the same link under many videos every few minutes.", evidence: [{ url: "https://videos.alummahnow.net/watch/abc123", label: "Comment thread" }],
  requested_by: { id: "mod-7", display_name: "Huda Qasim" }, decision_note: null, decided_at: null, actioned_at: null,
  created_at: iso(ago(0, 3, 12, 40)), updated_at: iso(ago(0, 3, 12, 40)), client_id: "videos", client_name: "Videos", decided_by: null, action_result: null,
  action_error: null, execution: { status: null, attempts: 0, needs_attention: false },
  history: [{ id: "h-1", type: "created", actor_type: "client", actor_id: "videos", actor_name: "Huda Qasim", note: null, metadata: null, at: iso(ago(0, 3, 12, 40)) }],
};
const MOD_FAILED = {
  ...MOD_REQUEST, id: "mr-2", status: "approved", subject_user_id: "u-19", action: "revoke_sessions", reason_category: "compromised_account",
  reason: "حساب مخترق: تسجيلات دخول من بلدان عدة خلال ساعة.", created_at: iso(ago(1, 6, 2, 9)), action_error: "auth service timed out",
  execution: { status: "failed", attempts: 3, needs_attention: true },
};
const MOD_DONE = { ...MOD_REQUEST, id: "mr-3", status: "actioned", subject_user_id: "u-17", action: "require_password_reset", reason_category: "fraud", created_at: iso(ago(9, 2, 30, 0)) };

const themeSummary = (id: string, i: number) => {
  const pkg = builtinPackage(id)!;
  return {
    id, name: pkg.theme.name, kind: "builtin" as const, status: "published" as const, version: pkg.theme.version, draftVersion: null, basedOn: null,
    isAuthDefault: id === "fawanees", clientIds: i === 1 ? ["videos"] : [], updatedAt: null, updatedBy: null, publishedAt: null,
    swatches: swatchesOf(pkg.theme as AuthThemeJson),
  };
};
const FAWANEES = builtinPackage("fawanees")!;

Object.assign(FIXTURES, {
  dashboard: {
    isAuthenticated: true, user: ADMIN, totalUsers: 45230, adminUsers: 41, totalRoles: 6, systemRoles: 4, customRoles: 2,
    usersByRole: [{ name: "Member", user_count: 45000 }, { name: "Admin", user_count: 40 }, { name: "Creator", user_count: 12 }, { name: "Moderator", user_count: 3 }, { name: "Super Admin", user_count: 1 }],
    authServerUrl: "", appUrl: "", authorizeUrl: "",
  },
  roles: {
    user: ADMIN, authServerUrl: "",
    roles: [
      { id: "r-0", name: "super_admin", description: "Administrative access", is_system_role: true, created_at: sec(ago(300)), updated_at: sec(ago(300)), user_count: 1 },
      { id: "r-1", name: "Admin", description: "Administrative access", is_system_role: true, created_at: sec(ago(300)), updated_at: sec(ago(300)), user_count: 40 },
      { id: "r-2", name: "Moderator", description: "Video platform content moderation", is_system_role: true, created_at: sec(ago(300)), updated_at: sec(ago(300)), user_count: 3 },
      { id: "r-3", name: "Member", description: "Basic member access", is_system_role: true, created_at: sec(ago(300)), updated_at: sec(ago(300)), user_count: 45000 },
      { id: "r-4", name: "Translator", description: "مراجعة الترجمات", is_system_role: false, created_at: sec(ago(20)), updated_at: sec(ago(4)), user_count: 12 },
    ],
  },
  role: {
    user: ADMIN, authServerUrl: "",
    role: { id: "r-4", name: "Translator", description: "مراجعة الترجمات", is_system_role: false, created_at: sec(ago(20, 3)), updated_at: sec(ago(4, 7)), permissions: PERMS.slice(2, 4) },
    allPermissions: byResource(PERMS),
    usersWithRole: [
      { id: "u-12", email: "maryam.alhassan@mail.alummahnow.net", assigned_at: sec(ago(4, 7, 12)), assigned_by: "admin-1" },
      { id: "u-20", email: "safiya.omar@mail.alummahnow.net", assigned_at: sec(ago(2, 1, 40)), assigned_by: "system" },
    ],
  },
  moderation: {
    user: ADMIN, authServerUrl: "", page: 1,
    filters: { status: "pending", client_id: "", action: "", from: "", to: "", needs_attention: "" },
    queue: { requests: [MOD_REQUEST, MOD_FAILED], total: 1250, open: 37, needs_attention: 2, limit: 25, offset: 0, clients: [{ id: "videos", name: "Videos" }, { id: "cms", name: "CMS" }] },
  },
  "moderation-request": {
    user: ADMIN, authServerUrl: "",
    detail: {
      request: { ...MOD_FAILED, history: [...MOD_REQUEST.history, { id: "h-2", type: "approved", actor_type: "admin", actor_id: "admin-1", actor_name: "Omar Saleh", note: null, metadata: null, at: iso(ago(1, 5)) }, { id: "h-3", type: "action_failed", actor_type: "system", actor_id: "moderation-actions", actor_name: null, note: "auth service timed out", metadata: { attempts: 3 }, at: iso(ago(1, 4, 50)) }] },
      subject: { id: "u-19", email: "tariq.aziz@mail.alummahnow.net", name: "Tariq Aziz", status: "active", password_reset_required: false, created_at: ago(51, 17, 19, 48) },
      prior_requests: [MOD_DONE],
    },
  },
  themes: {
    user: ADMIN, authServerUrl: "",
    themes: BUILTIN_IDS.map(themeSummary),
    authDefault: "fawanees",
    clientDefaults: { videos: BUILTIN_IDS[1] },
    clients: [{ id: "videos", name: "Videos" }, { id: "cms", name: "CMS" }, { id: "profile", name: "Profile" }],
  },
  theme: {
    user: ADMIN, authServerUrl: "",
    detail: {
      summary: themeSummary("fawanees", 0),
      theme: FAWANEES.theme,
      assets: FAWANEES.assets,
      assetUrls: Object.fromEntries(Object.entries(FAWANEES.assets).map(([path, a]) => [path, `/themes/assets/${(a as { hash: string }).hash}`])),
    },
  },
  security: {
    user: ADMIN, authServerUrl: "", canChange: true, passkeyGraceUntil: undefined, loadError: undefined,
    settings: {
      enforced: true, enforcedAt: ago(3, 2), graceDays: 7, staff: 46, capped: false, actorHasPasskey: true,
      withoutPasskey: [{ id: "u-17", email: "zaid.mansour@mail.alummahnow.net" }, { id: "u-18", email: "huda.qasim@mail.alummahnow.net" }],
    },
  },
  "signing-keys": {
    user: ADMIN, authServerUrl: "", passkeyGraceUntil: undefined, loadError: undefined,
    view: {
      keys: [
        { id: "k-2026-11", alg: "ES256", created: ago(12, 3), activates: ago(10, 3), state: "active" },
        { id: "k-2026-10", alg: "ES256", created: ago(42, 3), activates: ago(40, 3), expired: ago(10, 3), state: "previous" },
      ],
      policy: { publishLeadMs: 2 * DAY, rotateEveryMs: 30 * DAY, retireAfterMs: 14 * DAY, scheduled: true },
      status: { lastRunAt: ago(0, 5, 2), lastTrigger: "schedule", queuedAt: null, error: null, errorAt: null, attempts: 0 },
      canRotate: true,
    },
  },
});

const STUBS = Object.fromEntries(
  (Object.keys(PAGES) as PageName[]).map((name) => {
    const { path, Component } = PAGES[name];
    return [name, createRoutesStub([{ id: "root", path: "/", Component: Outlet, children: [path ? { id: "page", path, Component } : { id: "page", index: true, Component }] }])];
  }),
) as Record<PageName, ReturnType<typeof createRoutesStub>>;

/**
 * `authServerUrl` (screenshots only): the admin is signed in, so the header shows the account menu,
 * filled from the server's /session/accounts.
 */
export function PageApp({ page, url, authServerUrl }: { page: PageName; url: string; authServerUrl?: string }) {
  const Stub = STUBS[page];
  const data = authServerUrl ? { ...(FIXTURES[page] as object), authServerUrl } : FIXTURES[page];
  return <Stub initialEntries={[url]} hydrationData={{ loaderData: { root: null, page: data } }} />;
}
