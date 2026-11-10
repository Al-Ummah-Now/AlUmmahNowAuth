/**
 * The Auth admin's theme pages: what each action asks Auth's theme API to
 * do, the preview and export resources, and that the list and the builder
 * render (built-in read-only, custom editable).
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinPackage } from "../../../../packages/ui/src/auth-theme/builtin.ts";
import type { ThemeDetail, ThemeSummary } from "../lib/themes.server";

const api = {
  list: vi.fn(),
  get: vi.fn(),
  duplicate: vi.fn(),
  saveDraft: vi.fn(),
  publish: vi.fn(),
  remove: vi.fn(),
  setAuthDefault: vi.fn(),
  setClientDefault: vi.fn(),
  uploadAsset: vi.fn(),
  removeAsset: vi.fn(),
  importZip: vi.fn(),
  exportZip: vi.fn(),
  preview: vi.fn(),
};

vi.mock("../lib/themes.server", async (original) => ({
  ...(await original<typeof import("../lib/themes.server")>()),
  themeActor: async () => ({ id: "usr_admin", email: "admin@example.com", roles: ["Admin"] }),
  themesApi: () => api,
}));
vi.mock("../lib/admin-api.server", async (original) => ({
  ...(await original<typeof import("../lib/admin-api.server")>()),
  listClients: async () => ({ clients: [{ id: "c1", client_id: "c1", name: "Profile" }] }),
}));
vi.mock("../lib/auth.server", async (original) => ({
  ...(await original<typeof import("../lib/auth.server")>()),
  getAuthenticatedUser: async () => ({ user: { id: "usr_admin", email: "admin@example.com" } }),
}));

const list = await import("./themes._index");
const builder = await import("./themes.$id");
const preview = await import("./themes.$id.preview");
const exporter = await import("./themes.$id.export");

const APP = "https://admin.auth.example";
const env = { AUTH_STORAGE: {}, AUTH_SERVER_URL: "https://auth.example" };

function args(path: string, init?: RequestInit, params: Record<string, string> = {}) {
  return { request: new Request(new URL(path, APP), init), params, context: { cloudflare: { env, ctx: undefined } } } as never;
}

function form(fields: Record<string, string | Blob>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return { method: "POST", body: fd };
}

const summary = (over: Partial<ThemeSummary> = {}): ThemeSummary => ({
  id: "nahas",
  name: { en: "Nahas", ar: "نحاس" },
  kind: "builtin",
  status: "published",
  version: "1.0.0",
  draftVersion: null,
  basedOn: null,
  isAuthDefault: false,
  clientIds: [],
  updatedAt: null,
  updatedBy: null,
  publishedAt: null,
  ...over,
});

const detail = (over: Partial<ThemeSummary> = {}): ThemeDetail => {
  const pkg = builtinPackage("nahas")!;
  return {
    summary: summary(over),
    theme: { ...pkg.theme, id: over.id ?? "nahas" },
    assets: pkg.assets,
    assetUrls: Object.fromEntries(Object.entries(pkg.assets).map(([p, a]) => [p, `https://auth.example/themes/assets/${a.hash}`])),
  };
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

describe("list actions", () => {
  it("duplicating opens the new theme", async () => {
    api.duplicate.mockResolvedValue(summary({ id: "eid", kind: "custom", status: "draft" }));
    const res = (await list.action(args("/themes", form({ intent: "duplicate", from: "nahas", id: " eid ", name_en: "Eid", name_ar: "عيد" })))) as Response;
    expect(api.duplicate).toHaveBeenCalledWith("nahas", "eid", { en: "Eid", ar: "عيد" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/themes/eid");
  });

  it("an empty app default means the Auth default", async () => {
    await list.action(args("/themes", form({ intent: "set-client-default", clientId: "c1", themeId: "" })));
    expect(api.setClientDefault).toHaveBeenCalledWith("c1", null);
    await list.action(args("/themes", form({ intent: "set-client-default", clientId: "c1", themeId: "eid" })));
    expect(api.setClientDefault).toHaveBeenLastCalledWith("c1", "eid");
  });

  it("Auth's refusal is shown, not thrown", async () => {
    api.remove.mockRejectedValue(new Error("Theme is in use"));
    expect(await list.action(args("/themes", form({ intent: "delete", themeId: "eid" })))).toEqual({ error: "Theme is in use", intent: "delete" });
  });

  it("imports a zip", async () => {
    api.importZip.mockResolvedValue(summary({ id: "imported", kind: "custom", status: "draft" }));
    const zip = new File([new Uint8Array([80, 75, 3, 4])], "t.zip", { type: "application/zip" });
    const res = (await list.action(args("/themes", form({ intent: "import", file: zip, id: "", replace: "on" })))) as Response;
    expect(api.importZip).toHaveBeenCalledWith(expect.any(ArrayBuffer), { id: undefined, replace: true });
    expect(res.headers.get("Location")).toBe("/themes/imported");
  });
});

describe("builder actions", () => {
  const p = { id: "eid" };

  it("publishing saves the edited theme first", async () => {
    api.saveDraft.mockResolvedValue({ ...summary(), contrast: [] });
    api.publish.mockResolvedValue(summary({ version: "1.1.0" }));
    const out = await builder.action(args("/themes/eid", form({ intent: "publish", theme: JSON.stringify({ id: "eid" }) }), p));
    expect(api.saveDraft).toHaveBeenCalledWith("eid", { id: "eid" });
    expect(api.publish).toHaveBeenCalledWith("eid");
    expect(out.ok).toMatch(/Published version 1\.1\.0/);
  });

  it("a saved draft reports its contrast problems", async () => {
    const contrast = [{ path: "tokens.color.light.textPrimary", message: "4.1:1 on background (needs 4.5:1, WCAG AA)" }];
    api.saveDraft.mockResolvedValue({ ...summary(), contrast });
    const out = await builder.action(args("/themes/eid", form({ intent: "save", theme: "{}" }), p));
    expect(api.publish).not.toHaveBeenCalled();
    expect(out.contrast).toEqual(contrast);
  });

  it("uploads under assets/ (fonts under assets/fonts/), with a safe name", async () => {
    api.uploadAsset.mockResolvedValue({});
    const svg = new File(["<svg/>"], "My Header (1).SVG", { type: "image/svg+xml" });
    const out = await builder.action(args("/themes/eid", form({ intent: "upload", file: svg, target: "headerGraphic" }), p));
    expect(api.uploadAsset).toHaveBeenCalledWith("eid", "assets/my-header-1-.svg", expect.any(ArrayBuffer), "image/svg+xml");
    expect(out.uploaded).toEqual({ path: "assets/my-header-1-.svg", target: "headerGraphic" });
    await builder.action(args("/themes/eid", form({ intent: "upload", file: new File(["x"], "Font.woff2", { type: "font/woff2" }) }), p));
    expect(api.uploadAsset).toHaveBeenLastCalledWith("eid", "assets/fonts/font.woff2", expect.any(ArrayBuffer), "font/woff2");
  });

  it("validation details come back with the error", async () => {
    const details = [{ path: "tokens.color.light.primary", message: "is not a colour" }];
    api.saveDraft.mockRejectedValue(Object.assign(new Error("Invalid theme"), { status: 400, details }));
    expect(await builder.action(args("/themes/eid", form({ intent: "save", theme: "{}" }), p))).toEqual({ error: "Invalid theme", details });
  });
});

describe("resources", () => {
  it("the preview is sandboxed HTML from Auth, for the language and scheme asked", async () => {
    api.preview.mockResolvedValue("<!doctype html><title>x</title>");
    const res = await preview.action(
      args("/themes/eid/preview", { method: "POST", body: JSON.stringify({ theme: { id: "eid" }, page: "register", lang: "ar", scheme: "evil" }) }, { id: "eid" })
    );
    expect(api.preview).toHaveBeenCalledWith({ theme: { id: "eid" }, themeId: "eid", page: "register", lang: "ar", scheme: "light" });
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(res.headers.get("Content-Security-Policy")).toMatch(/^sandbox;/);
    expect(await res.text()).toContain("<title>x</title>");
  });

  it("the export streams Auth's zip as a download", async () => {
    api.exportZip.mockResolvedValue(new Response(new Uint8Array([80, 75]), { headers: { "Content-Disposition": 'attachment; filename="eid-1.0.0.zip"' } }));
    const res = await exporter.loader(args("/themes/eid/export?source=draft", undefined, { id: "eid" }));
    expect(api.exportZip).toHaveBeenCalledWith("eid", "draft");
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="eid-1.0.0.zip"');
  });
});

async function render(path: string, routes: Parameters<typeof createStaticHandler>[0]) {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(new URL(path, APP)));
  if (context instanceof Response) throw new Error(`redirected to ${context.headers.get("Location")}`);
  return renderToString(createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
}

describe("pages render", () => {
  it("the list shows every theme and the app defaults", async () => {
    api.list.mockResolvedValue({
      themes: [summary({ isAuthDefault: true, id: "fawanees", name: { en: "Fawanees", ar: "فوانيس" } }), summary(), summary({ id: "eid", kind: "custom", status: "draft", clientIds: ["c1"] })],
      authDefault: "fawanees",
      clientDefaults: { c1: "eid" },
    });
    api.get.mockImplementation(async (id: string) => detail({ id }));
    const html = await render("/themes", [{ path: "/themes", loader: (a) => list.loader({ ...a, context: { cloudflare: { env } } } as never), Component: list.default }]);
    expect(html).toContain('data-testid="theme-fawanees"');
    expect(html).toContain('data-testid="theme-eid"');
    expect(html).toContain('data-testid="client-default-c1"');
    expect(html).toContain("Auth default");
  });

  it("a built-in opens read-only, with the live preview", async () => {
    api.get.mockResolvedValue(detail());
    const html = await render("/themes/nahas", [{ path: "/themes/:id", loader: (a) => builder.loader({ ...a, context: { cloudflare: { env } } } as never), Component: builder.default }]);
    expect(html).toContain("Built-in themes can&#x27;t be changed");
    expect(html).toContain('data-testid="theme-preview"');
    expect(html).not.toContain(">Save draft<");
  });

  it("a custom theme opens editable", async () => {
    api.get.mockResolvedValue(detail({ id: "eid", kind: "custom", status: "draft" }));
    const html = await render("/themes/eid", [{ path: "/themes/:id", loader: (a) => builder.loader({ ...a, context: { cloudflare: { env } } } as never), Component: builder.default }]);
    expect(html).toContain("Save draft");
    expect(html).toContain("Not published yet");
    expect(html).toContain('aria-label="primary value (light)"');
  });
});
