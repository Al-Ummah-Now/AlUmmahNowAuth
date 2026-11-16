/**
 * The hydration check's server (CI job "Arabic hydration (WebKit)"; local: pnpm test:hydration).
 *
 * - /admin/<page>?lang=..: the admin route rendered in Node (Vite SSR) with fixed data, plus a
 *   client bundle (esbuild) that hydrates it. `.server` modules are stubbed in the browser bundle.
 * - /profile?lang=..: the Profile page HTML (apps/profile/src/page.ts), with its API calls answered
 *   from fixtures, so its in-browser dates and counts can be checked too.
 */
import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { createServer as createViteServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(here, "..");
const port = Number(process.env.HYDRATION_PORT || 4610);
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve("vite"))("esbuild");

const vite = await createViteServer({
  root: adminRoot,
  configFile: false,
  logLevel: "error",
  appType: "custom",
  server: { middlewareMode: true, hmr: false, watch: null },
  esbuild: { jsx: "automatic" },
  plugins: [tailwindcss()],
});

/** The admin's <head>: light/dark script, shared header CSS, the built-in theme's tokens, Tailwind. */
async function adminHead(origin) {
  const { MODE_SCRIPT } = await vite.ssrLoadModule(resolve(adminRoot, "app/lib/color-mode.ts"));
  const { shellThemeCss } = await vite.ssrLoadModule(resolve(adminRoot, "app/lib/shell-theme.ts"));
  const { NAV_CSS } = await vite.ssrLoadModule(resolve(adminRoot, "../../packages/ui/src/nav/aun-nav.generated.ts"));
  const { PAGE_HEADER_CSS } = await vite.ssrLoadModule(resolve(adminRoot, "../../packages/ui/src/nav/page-header.ts"));
  const { compileBuiltin } = await vite.ssrLoadModule(resolve(adminRoot, "../../packages/ui/src/auth-theme/builtin.ts"));
  const { BUILTIN_DEFAULT_THEME } = await vite.ssrLoadModule(resolve(adminRoot, "../../packages/ui/src/auth-theme/resolve.ts"));
  const shellCss = shellThemeCss(compileBuiltin(BUILTIN_DEFAULT_THEME, origin).tokensCss);
  return (
    `<meta name="viewport" content="width=device-width, initial-scale=1"><script>${MODE_SCRIPT}</script>` +
    `<style>${NAV_CSS + PAGE_HEADER_CSS}</style><style>${shellCss}</style><link rel="stylesheet" href="/app/tailwind.css?direct">`
  );
}

const stubServerModules = {
  name: "stub-server-modules",
  setup(build) {
    build.onResolve({ filter: /\.server(\.ts)?$/ }, (args) => ({ path: args.path, namespace: "server-stub" }));
    build.onLoad({ filter: /.*/, namespace: "server-stub" }, () => ({
      contents: "module.exports = new Proxy({}, { get: (_, k) => (k === '__esModule' ? false : function serverOnly() { throw new Error('server only'); }) });",
      loader: "js",
    }));
  },
};

const bundle = await esbuild.build({
  entryPoints: [resolve(here, "client.tsx")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [stubServerModules],
  logLevel: "error",
});
const clientJs = bundle.outputFiles[0].text;

const NOW = Date.UTC(2026, 10, 15, 9, 30);
const DAY = 86_400_000;
const json = (res, body) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = createHttpServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname === "/app/tailwind.css") return vite.middlewares(req, res);
    if (url.pathname === "/client.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      return res.end(clientJs);
    }
    const admin = /^\/admin\/(deleted|users|passkeys)$/.exec(url.pathname);
    if (admin) {
      const page = admin[1];
      const lang = url.searchParams.get("lang") === "ar" ? "ar" : "en";
      const pageUrl = (page === "passkeys" ? "/users/u-10/passkeys" : `/${page}`) + (lang === "ar" ? "?lang=ar" : "");
      const { renderToString } = await import("react-dom/server");
      const React = await import("react");
      const { PageApp } = await vite.ssrLoadModule(resolve(here, "app.tsx"));
      const body = renderToString(React.createElement(PageApp, { page, url: pageUrl }));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(
        `<!doctype html><html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8"><title>${page}</title>${await adminHead(`http://localhost:${port}`)}</head><body><div id="root">${body}</div>` +
          `<script>window.__page=${JSON.stringify({ page, url: pageUrl })}</script><script type="module" src="/client.js"></script></body></html>`,
      );
    }
    if (url.pathname === "/profile") {
      const { renderHomePage } = await vite.ssrLoadModule(resolve(adminRoot, "../profile/src/page.ts"));
      const locale = url.searchParams.get("lang") === "ar" ? "ar" : "en";
      const origin = `http://localhost:${port}`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(
        renderHomePage({ locale, apps: [], user: { id: "u-10", email: "first@example.com", roles: [] }, authServerUrl: origin, appUrl: origin, clientId: "profile", path: locale === "ar" ? "/profile?lang=ar" : "/profile" }),
      );
    }
    if (url.pathname === "/api/passkeys") return json(res, { passkeys: [{ id: "pk-1", name: "Laptop", synced: true, deviceType: "multiDevice", createdAt: NOW - 10 * DAY, lastUsedAt: NOW - DAY }], max: 10, staff: false, signedInWithPasskey: false });
    if (url.pathname === "/session/accounts") {
      const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
      return json(res, { accounts: [
        { userId: "u-10", email: "first@example.com", isActive: true, lastUsed: ago(0) },
        { userId: "u-11", email: "second@example.com", isActive: false, lastUsed: ago(25) },
        { userId: "u-12", email: "third@example.com", isActive: false, lastUsed: ago(60 * 30) },
      ] });
    }
    if (url.pathname === "/api/me") return json(res, { id: "u-10", email: "first@example.com", roles: [] });
    const asset = resolve(adminRoot, "public", "." + url.pathname);
    if (asset.startsWith(resolve(adminRoot, "public") + "/")) {
      const bytes = await readFile(asset).catch(() => null);
      if (bytes) {
        const type = { webp: "image/webp", png: "image/png", svg: "image/svg+xml", ico: "image/x-icon" }[asset.split(".").pop()] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": type });
        return res.end(bytes);
      }
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  } catch (error) {
    console.error(error);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal error (see the server log)");
  }
});
server.listen(port, () => console.log(`hydration server on http://localhost:${port}`));
