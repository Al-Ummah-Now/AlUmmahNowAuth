/**
 * App catalog for the profile app's app switcher ("launcher") and the
 * "Your apps" section on the profile home.
 *
 * Adding an app is one entry in APP_CATALOG. Each entry carries its own
 * per-environment URLs; the environment is chosen by the APP_ENV var in
 * wrangler.json / wrangler.qa.json (never inferred from a hard-coded prod URL).
 *
 * Possible future source: the auth server already stores OAuth client metadata
 * (name, redirect_uris, metadata JSON). Launcher fields could live there and be
 * served to this app, but this catalog is deliberately self-contained for now.
 */

export type AppEnv = "production" | "qa" | "stage" | "local";

export type Locale = "en" | "ar";

export type AppId = "www" | "videos" | "content-admin" | "cms" | "auth-admin" | "profile";

export interface AppEntry {
  id: AppId;
  /** "app" = product apps everyone can use; "admin" = staff tools */
  category: "app" | "admin";
  name: Record<Locale, string>;
  description: Record<Locale, string>;
  /** null = the app has no deployment in that environment, so it is hidden there */
  urls: Record<AppEnv, string | null>;
  /**
   * Roles allowed to see the app, as normalized role ids (see normalizeRole).
   * An empty list means every visitor sees it. These mirror each app's own
   * access guard, so we never show a link the user would be bounced from.
   */
  requiredRoles: readonly string[];
}

/** Names and order are the shared "Al Ummah Now apps" list (AlUmmahNow docs/design/NAV.md). */
export const APP_CATALOG: readonly AppEntry[] = [
  {
    id: "www",
    category: "app",
    name: { en: "Website", ar: "الموقع" },
    description: {
      en: "Articles, pages and what we do",
      ar: "المقالات والصفحات وما نقوم به",
    },
    urls: {
      production: "https://www.alummahnow.net",
      qa: "https://www.qa.alummahnow.net",
      stage: "https://www.stage.alummahnow.net",
      local: "http://localhost:4321",
    },
    requiredRoles: [],
  },
  {
    id: "videos",
    category: "app",
    name: { en: "Videos", ar: "المرئيات" },
    description: {
      en: "Watch and share videos",
      ar: "شاهد المرئيات وشاركها",
    },
    urls: {
      production: "https://videos.alummahnow.net",
      qa: "https://videos.qa.alummahnow.net",
      stage: null,
      local: "http://localhost:3001",
    },
    requiredRoles: [],
  },
  {
    id: "profile",
    category: "app",
    name: { en: "Your profile", ar: "ملفك الشخصي" },
    description: {
      en: "Your account and sessions",
      ar: "حسابك وجلساتك",
    },
    urls: {
      production: "https://profile.auth.alummahnow.net",
      qa: "https://profile.auth.qa.alummahnow.net",
      stage: "https://profile.auth.stage.alummahnow.net",
      local: "http://localhost:3302",
    },
    requiredRoles: [],
  },
  {
    id: "cms",
    category: "admin",
    name: { en: "Content management", ar: "إدارة المحتوى" },
    description: {
      en: "Edit the website: pages, articles and featured videos",
      ar: "تحرير الموقع: الصفحات والمقالات والمرئيات المختارة",
    },
    urls: {
      production: "https://cms.alummahnow.net",
      qa: "https://cms.qa.alummahnow.net",
      stage: "https://cms.stage.alummahnow.net",
      local: "http://localhost:8585",
    },
    // AlUmmahNowCMS docs/SPEC.md §3 (allowed roles; Scholar = CMS "writer", own articles only)
    requiredRoles: ["super_admin", "admin", "moderator", "scholar"],
  },
  {
    id: "content-admin",
    category: "admin",
    name: { en: "Videos admin", ar: "إدارة المرئيات" },
    description: {
      en: "Moderate videos, channels and reports",
      ar: "الإشراف على المرئيات والقنوات والبلاغات",
    },
    urls: {
      production: "https://admin.alummahnow.net",
      qa: "https://admin.qa.alummahnow.net",
      stage: null,
      local: "http://localhost:3091",
    },
    // AlUmmahNow apps/admin-web/src/lib/roles.ts ADMIN_ROLES; reviewers see only the review queue there
    requiredRoles: ["super_admin", "admin", "moderator", "content_reviewer", "senior_reviewer"],
  },
  {
    id: "auth-admin",
    category: "admin",
    name: { en: "Accounts admin", ar: "إدارة الحسابات" },
    description: {
      en: "Users, roles and sign-in clients",
      ar: "المستخدمون والأدوار وتطبيقات الدخول",
    },
    urls: {
      production: "https://admin.auth.alummahnow.net",
      qa: "https://admin.auth.qa.alummahnow.net",
      stage: "https://admin.auth.stage.alummahnow.net",
      local: "http://localhost:3303",
    },
    // apps/admin/app/lib/auth.server.ts hasAdminRole
    requiredRoles: ["super_admin", "admin"],
  },
];

/** The app this worker serves; marked as current in the launcher. */
export const CURRENT_APP_ID: AppId = "profile";

/**
 * Normalize a role from the token ("Super Admin", "super-admin", "admin")
 * to a snake_case id ("super_admin"). Same rule as the content admin's roles.ts.
 */
export function normalizeRole(role: string): string {
  return role.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Pick the environment. Localhost always means local dev; otherwise APP_ENV
 * must be set explicitly. Unknown or missing values return null so callers
 * fail closed (no cross-app links) instead of silently linking to production.
 */
export function resolveAppEnv(appEnv: string | undefined, hostname: string): AppEnv | null {
  if (hostname === "localhost" || hostname === "127.0.0.1") return "local";
  if (appEnv === "production" || appEnv === "qa" || appEnv === "stage") return appEnv;
  return null;
}

export function canSeeApp(app: AppEntry, roles: readonly string[]): boolean {
  if (app.requiredRoles.length === 0) return true;
  const normalized = new Set(roles.map(normalizeRole));
  return app.requiredRoles.some((r) => normalized.has(r));
}

export interface VisibleApp {
  id: AppId;
  category: AppEntry["category"];
  name: string;
  description: string;
  url: string;
  current: boolean;
}

/**
 * Apps a user may see, localized and resolved to the environment's URLs.
 * Admin apps the user lacks a role for are omitted, never shown disabled.
 * With no resolvable environment only the current app is returned.
 */
export function appsForUser(
  roles: readonly string[],
  env: AppEnv | null,
  locale: Locale,
  catalog: readonly AppEntry[] = APP_CATALOG,
  currentId: AppId = CURRENT_APP_ID,
): VisibleApp[] {
  return catalog
    .filter((app) =>
      app.id === currentId || (env !== null && app.urls[env] !== null && canSeeApp(app, roles)),
    )
    .map((app) => ({
      id: app.id,
      category: app.category,
      name: app.name[locale],
      description: app.description[locale],
      // The current app links to its own root so a misconfigured env can't
      // send the user elsewhere.
      url: app.id === currentId ? "/" : (app.urls[env as AppEnv] as string),
      current: app.id === currentId,
    }));
}
