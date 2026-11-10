import { describe, expect, it } from "vitest";
import { APP_CATALOG, appsForUser, canSeeApp, normalizeRole, resolveAppEnv, type AppEntry } from "./apps";

const ids = (roles: string[], env: Parameters<typeof appsForUser>[1] = "production") =>
  appsForUser(roles, env, "en").map((a) => a.id);

describe("normalizeRole", () => {
  it("maps token display names to snake_case ids", () => {
    expect(normalizeRole("Super Admin")).toBe("super_admin");
    expect(normalizeRole(" Admin ")).toBe("admin");
    expect(normalizeRole("super-admin")).toBe("super_admin");
    expect(normalizeRole("MODERATOR")).toBe("moderator");
  });
});

describe("role filtering", () => {
  it("a regular member sees only Al Ummah Now and Profile", () => {
    expect(ids(["Member"])).toEqual(["www", "videos", "profile"]);
  });

  it("a signed-out visitor (no roles) sees only public apps", () => {
    expect(ids([])).toEqual(["www", "videos", "profile"]);
  });

  it("Admin and Super Admin see both admin apps", () => {
    expect(ids(["Admin", "Member"])).toEqual(["www", "videos", "profile", "content-admin", "cms", "auth-admin"]);
    expect(ids(["Super Admin"])).toEqual(["www", "videos", "profile", "content-admin", "cms", "auth-admin"]);
  });

  it("a Moderator sees the content admin and the CMS but not the auth admin (matches each app's guard)", () => {
    expect(ids(["Moderator"])).toEqual(["www", "videos", "profile", "content-admin", "cms"]);
  });

  it("a member never sees the CMS; every allowed role does", () => {
    expect(ids(["Member"])).not.toContain("cms");
    for (const role of ["Super Admin", "Admin", "Moderator", "Scholar"]) expect(ids([role])).toContain("cms");
  });

  it("a Scholar sees the CMS (to write articles) but neither admin app", () => {
    expect(ids(["Scholar", "Member"])).toEqual(["www", "videos", "profile", "cms"]);
  });

  it("does not emit disabled admin entries for users without access", () => {
    const apps = appsForUser(["Member"], "production", "en");
    expect(apps.some((a) => a.category === "admin")).toBe(false);
  });

  it("canSeeApp treats an empty requiredRoles list as public", () => {
    const pub = { requiredRoles: [] } as unknown as AppEntry;
    expect(canSeeApp(pub, [])).toBe(true);
  });
});

describe("environment URLs", () => {
  const url = (env: "production" | "qa" | "local", id: string) =>
    appsForUser(["Super Admin"], env, "en").find((a) => a.id === id)?.url;

  it("production links to production hosts", () => {
    expect(url("production", "videos")).toBe("https://videos.alummahnow.net");
    expect(url("production", "content-admin")).toBe("https://admin.alummahnow.net");
    expect(url("production", "auth-admin")).toBe("https://admin.auth.alummahnow.net");
    expect(url("production", "www")).toBe("https://www.alummahnow.net");
    expect(url("production", "cms")).toBe("https://cms.alummahnow.net");
  });

  it("QA links only to QA hosts", () => {
    expect(url("qa", "videos")).toBe("https://videos.qa.alummahnow.net");
    expect(url("qa", "content-admin")).toBe("https://admin.qa.alummahnow.net");
    expect(url("qa", "auth-admin")).toBe("https://admin.auth.qa.alummahnow.net");
    expect(url("qa", "www")).toBe("https://www.qa.alummahnow.net");
    expect(url("qa", "cms")).toBe("https://cms.qa.alummahnow.net");
    for (const app of appsForUser(["Super Admin"], "qa", "en")) {
      if (!app.current) expect(app.url).toMatch(/^https:\/\/[a-z.]+\.qa\.alummahnow\.net$/);
    }
  });

  it("every catalog entry defines a URL for every environment, and QA never reuses a prod URL", () => {
    for (const app of APP_CATALOG) {
      expect(app.urls.production).toMatch(/^https:\/\//);
      expect(app.urls.qa).toMatch(/\.qa\.alummahnow\.net$/);
      expect(app.urls.local).toMatch(/^http:\/\/localhost:\d+$/);
      expect(app.urls.qa).not.toBe(app.urls.production);
      if (app.urls.stage !== null) expect(app.urls.stage).toMatch(/\.stage\.alummahnow\.net$/);
    }
  });

  it("stage lists only apps deployed on stage (no dead links, no prod fallback)", () => {
    const stage = appsForUser(["Super Admin"], "stage", "en");
    expect(stage.map((a) => a.id)).toEqual(["www", "profile", "cms", "auth-admin"]);
    expect(stage.find((a) => a.id === "auth-admin")?.url).toBe("https://admin.auth.stage.alummahnow.net");
    expect(resolveAppEnv("stage", "profile.auth.stage.alummahnow.net")).toBe("stage");
  });

  it("the current app (profile) links to its own root and is marked current", () => {
    const profile = appsForUser([], "production", "en").find((a) => a.id === "profile");
    expect(profile).toMatchObject({ url: "/", current: true });
    expect(appsForUser([], "production", "en").filter((a) => a.current)).toHaveLength(1);
  });

  it("resolveAppEnv: localhost is local, APP_ENV picks production/qa, anything else fails closed", () => {
    expect(resolveAppEnv(undefined, "localhost")).toBe("local");
    expect(resolveAppEnv("production", "127.0.0.1")).toBe("local");
    expect(resolveAppEnv("production", "profile.auth.alummahnow.net")).toBe("production");
    expect(resolveAppEnv("qa", "profile.auth.qa.alummahnow.net")).toBe("qa");
    expect(resolveAppEnv(undefined, "profile.auth.qa.alummahnow.net")).toBeNull();
    expect(resolveAppEnv("staging", "x.workers.dev")).toBeNull();
  });

  it("with no resolvable environment only the current app is listed (no prod fallback)", () => {
    expect(appsForUser(["Super Admin"], null, "en").map((a) => a.id)).toEqual(["profile"]);
  });
});

describe("localization", () => {
  it("returns Arabic names and descriptions for ar", () => {
    const ar = appsForUser(["Admin"], "qa", "ar");
    expect(ar.find((a) => a.id === "videos")?.name).toBe("الأمة الآن");
    for (const app of ar) {
      expect(app.name).toMatch(/[؀-ۿ]/);
      expect(app.description).toMatch(/[؀-ۿ]/);
    }
  });

  it("every catalog entry has non-empty en and ar strings", () => {
    for (const app of APP_CATALOG) {
      for (const loc of ["en", "ar"] as const) {
        expect(app.name[loc].trim()).not.toBe("");
        expect(app.description[loc].trim()).not.toBe("");
      }
    }
  });
});
