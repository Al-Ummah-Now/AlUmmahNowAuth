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

/** The admin's <head>: light/dark script, shared header CSS, a built-in theme's tokens (and its lantern street), Tailwind. */
async function adminHead(origin, themeId) {
  const { MODE_SCRIPT } = await vite.ssrLoadModule(resolve(adminRoot, "app/lib/color-mode.ts"));
  const { shellThemeCss } = await vite.ssrLoadModule(resolve(adminRoot, "app/lib/shell-theme.ts"));
  const { NAV_CSS } = await vite.ssrLoadModule(resolve(adminRoot, "../../packages/ui/src/nav/aun-nav.generated.ts"));
  const { PAGE_HEADER_CSS } = await vite.ssrLoadModule(resolve(adminRoot, "../../packages/ui/src/nav/page-header.ts"));
  const { compileBuiltin } = await vite.ssrLoadModule(resolve(adminRoot, "../../packages/ui/src/auth-theme/builtin.ts"));
  const { BUILTIN_DEFAULT_THEME } = await vite.ssrLoadModule(resolve(adminRoot, "../../packages/ui/src/auth-theme/resolve.ts"));
  const { STREET_CSS_PATH, STREET_JS_PATH, streetOn } = await vite.ssrLoadModule(resolve(adminRoot, "../../packages/ui/src/fanous-street/index.ts"));
  const compiled = compileBuiltin(themeId ?? BUILTIN_DEFAULT_THEME, origin) ?? compileBuiltin(BUILTIN_DEFAULT_THEME, origin);
  const shellCss = shellThemeCss(compiled.tokensCss);
  // The street as root.tsx adds it: its CSS in the head, its script after hydration (here: once the page is up)
  const street = streetOn(shellCss)
    ? `<link rel="stylesheet" href="${STREET_CSS_PATH}" data-fanous-street=""><script>addEventListener("load",()=>setTimeout(()=>{const s=document.createElement("script");s.type="module";s.src=${JSON.stringify(STREET_JS_PATH)};s.dataset.fanousStreet="";document.head.appendChild(s)},600))</script>`
    : "";
  return (
    `<meta name="viewport" content="width=device-width, initial-scale=1"><script>${MODE_SCRIPT}</script>` +
    `<style>${NAV_CSS + PAGE_HEADER_CSS}</style><style>${shellCss}</style>${street}<link rel="stylesheet" href="/app/tailwind.css?direct">`
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
    const street = await vite.ssrLoadModule(resolve(adminRoot, "../../packages/ui/src/fanous-street/index.ts"));
    const streetFile = street.streetAsset(url.pathname);
    if (streetFile) {
      res.writeHead(200, { "Content-Type": streetFile.type });
      return res.end(streetFile.body);
    }
    // A built-in theme's files (the theme builder's images)
    const blob = /^\/themes\/assets\/([\w-]+)$/.exec(url.pathname);
    if (blob) {
      const { builtinBlob, blobBytes } = await vite.ssrLoadModule(resolve(adminRoot, "../../packages/ui/src/auth-theme/builtin.ts"));
      const b = builtinBlob(blob[1]);
      if (b) {
        res.writeHead(200, { "Content-Type": b.type });
        return res.end(Buffer.from(blobBytes(b)));
      }
    }
    // The theme builder's live preview: Auth renders the real pages; here a stand-in card in the theme's colours
    if (/^\/themes\/[\w-]+\/preview$/.test(url.pathname) && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const { themeId, lang, scheme } = JSON.parse(raw || "{}");
      const { builtinPackage } = await vite.ssrLoadModule(resolve(adminRoot, "../../packages/ui/src/auth-theme/builtin.ts"));
      const c = builtinPackage(themeId)?.theme.tokens.color[scheme === "dark" ? "dark" : "light"] ?? {};
      const ar = lang === "ar";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(
        `<!doctype html><html lang="${ar ? "ar" : "en"}" dir="${ar ? "rtl" : "ltr"}"><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:${c.background};color:${c.textPrimary};font:16px system-ui">` +
          `<div style="width:340px;padding:32px;border-radius:16px;background:${c.surface}"><h1 style="margin:0 0 16px;font-size:22px">${ar ? "تسجيل الدخول" : "Sign in"}</h1>` +
          `<div style="height:40px;border-radius:8px;border:1px solid ${c.outline};margin-bottom:12px"></div><div style="height:40px;border-radius:8px;background:${c.primary};color:${c.onPrimary};display:grid;place-items:center">${ar ? "متابعة" : "Continue"}</div></div></body></html>`,
      );
    }
    const admin = /^\/admin\/([a-z-]+)$/.exec(url.pathname);
    const { PageApp, PAGE_PATHS } = admin ? await vite.ssrLoadModule(resolve(here, "app.tsx")) : {};
    if (admin && PAGE_PATHS[admin[1]]) {
      const page = admin[1];
      const lang = url.searchParams.get("lang") === "ar" ? "ar" : "en";
      const pageUrl = PAGE_PATHS[page] + (lang === "ar" ? "?lang=ar" : "");
      const origin = `http://localhost:${port}`;
      // ?signedIn=1 (screenshots): the header's account menu, from /session/accounts below
      const authServerUrl = url.searchParams.get("signedIn") === "1" ? origin : undefined;
      const { renderToString } = await import("react-dom/server");
      const React = await import("react");
      const body = renderToString(React.createElement(PageApp, { page, url: pageUrl, authServerUrl }));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(
        `<!doctype html><html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8"><title>${page}</title>${await adminHead(origin, url.searchParams.get("theme"))}</head><body><div id="root">${body}</div>` +
          `<script>window.__page=${JSON.stringify({ page, url: pageUrl, authServerUrl })}</script><script type="module" src="/client.js"></script></body></html>`,
      );
    }
    if (url.pathname === "/profile") {
      const { renderHomePage } = await vite.ssrLoadModule(resolve(adminRoot, "../profile/src/page.ts"));
      const locale = url.searchParams.get("lang") === "ar" ? "ar" : "en";
      const origin = `http://localhost:${port}`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(
        renderHomePage({ locale, apps: [], user: { id: "u-10", email: "yusuf.rahman@mail.alummahnow.net", roles: [] }, authServerUrl: origin, appUrl: origin, clientId: "profile", path: locale === "ar" ? "/profile?lang=ar" : "/profile" }),
      );
    }
    if (url.pathname === "/api/passkeys") return json(res, { passkeys: [{ id: "pk-1", name: "Laptop", synced: true, deviceType: "multiDevice", createdAt: NOW - 10 * DAY, lastUsedAt: NOW - DAY }], max: 10, staff: false, signedInWithPasskey: false });
    if (url.pathname === "/session/accounts") {
      const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
      return json(res, { accounts: [
        { userId: "u-10", email: "yusuf.rahman@mail.alummahnow.net", name: "Yusuf Rahman", isActive: true, lastUsed: ago(0) },
        { userId: "u-11", email: "khadija.noor@mail.alummahnow.net", name: "Khadija Noor", isActive: false, lastUsed: ago(25) },
        { userId: "u-12", email: "maryam.alhassan@mail.alummahnow.net", name: "مريم الحسن", isActive: false, lastUsed: ago(60 * 30) },
      ] });
    }
    if (url.pathname === "/api/me") return json(res, { id: "u-10", email: "yusuf.rahman@mail.alummahnow.net", roles: [] });
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
