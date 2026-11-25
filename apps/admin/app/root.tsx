import { useEffect } from "react";
import type { LinksFunction, LoaderFunctionArgs, ShouldRevalidateFunction } from "react-router";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useLocation,
  useRouteLoaderData,
} from "react-router";
import { getAuthServerUrl, getOAuthClientId } from "./lib/config";
import { fetchShellTheme } from "./lib/shell-theme";
import { MODE_SCRIPT } from "./lib/color-mode";
import { scheduleKeepTypedBeforeHydration, TYPED_RECORDER_SCRIPT } from "./lib/keep-typed-before-hydration";
import { dirOf, langOf } from "./lib/deletion-copy";
import { NAV_CSS } from "../../../packages/ui/src/nav/aun-nav.generated";
import { PAGE_HEADER_CSS } from "../../../packages/ui/src/nav/page-header.ts";
import { STREET_CSS_PATH, STREET_JS_PATH, streetOn } from "../../../packages/ui/src/fanous-street/index.ts";
import { environmentOfHost, tabIconLinks } from "../../../packages/ui/src/app-icons/serve";

import "./tailwind.css";
import { getCloudflare } from "./lib/cloudflare-context";

export const links: LinksFunction = () => [
  // The owner's accounts-admin art (lantern in a double gold octagon), cropped and downscaled by AlUmmahNow
  // packages/app-icons into public/. The rel="icon" links depend on the host, so Layout renders them.
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  { rel: "manifest", href: "/site.webmanifest" },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap",
  },
];

/** The admin shell's look from Auth's theme for this app (empty keeps the admin's own). */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getCloudflare(context).env as { AUTH_SERVER_URL?: string; ADMIN_CLIENT_ID?: string; OAUTH_CLIENT_ID?: string; ACCOUNT_EVENTS?: string } | undefined;
  return {
    shellCss: await fetchShellTheme(getAuthServerUrl(request, env), getOAuthClientId(env), fetch, new URL(request.url).searchParams.get("theme")),
    // QA and stage tabs get a corner dot (SVG) and the header a QA / STAGE badge; production the
    // ICO and exact-size PNGs. One build serves stage and production, so read the host
    tabIcons: tabIconLinks(environmentOfHost(new URL(request.url).hostname)),
    environment: environmentOfHost(new URL(request.url).hostname),
    accountEvents: env?.ACCOUNT_EVENTS === "on",
  };
}

// The theme changes rarely: fetch it on full loads and after admin actions, not on every navigation
export const shouldRevalidate: ShouldRevalidateFunction = ({ formMethod, defaultShouldRevalidate }) =>
  !!formMethod && formMethod !== "GET" && defaultShouldRevalidate;

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<typeof loader>("root");
  const shellCss = data?.shellCss;
  // English unless the link asks for Arabic (?lang=ar), the admin's language switch for its dialogs
  const lang = langOf(useLocation().search);
  return (
    // The light/dark class on <html> belongs to MODE_SCRIPT (lib/color-mode.ts), never to React
    <html lang={lang} dir={dirOf(lang)} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Light or dark before first paint: the saved choice, else the device */}
        <script dangerouslySetInnerHTML={{ __html: MODE_SCRIPT }} />
        {/* Text typed before hydration is kept (#1462 in AlUmmahNow, lib/keep-typed-before-hydration.ts) */}
        <script dangerouslySetInnerHTML={{ __html: TYPED_RECORDER_SCRIPT }} />
        <Meta />
        <Links />
        {(data?.tabIcons ?? tabIconLinks("production")).map((l) => (
          <link key={l.href} rel="icon" href={l.href} type={l.type} sizes={l.sizes} />
        ))}
        <meta name="theme-color" content="#09273a" />
        {/* The shared header, its account button and menus (AlUmmahNow docs/design/NAV.md "Header") */}
        <style data-nav dangerouslySetInnerHTML={{ __html: NAV_CSS + PAGE_HEADER_CSS }} />
        {shellCss ? <style data-shell-theme dangerouslySetInnerHTML={{ __html: shellCss }} /> : null}
        {/* The Fanous lantern street (shared module, served by this app's worker) when the theme switches it on */}
        {/* Its script starts after hydration (App), so its drawing never meets React's markup check */}
        {shellCss && streetOn(shellCss) ? <link rel="stylesheet" href={STREET_CSS_PATH} data-fanous-street="" /> : null}
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const shellCss = useRouteLoaderData<typeof loader>("root")?.shellCss;
  const street = !!shellCss && streetOn(shellCss);
  useEffect(() => scheduleKeepTypedBeforeHydration(), []);
  useEffect(() => {
    if (!street || document.querySelector("script[data-fanous-street]")) return;
    const script = document.createElement("script");
    script.type = "module";
    script.src = STREET_JS_PATH;
    script.dataset.fanousStreet = "";
    document.head.appendChild(script);
  }, [street]);
  return <Outlet />;
}

/**
 * What React Router shows when a root route has no boundary, without its console.error of the error object: an unknown
 * URL (bots' .php probes) printed "[object Object]" as an error (185 in 3 h, production 2026-11-25). Real faults are
 * logged once by handleError (entry.server.tsx). Never the error's own text: it can hold internals.
 */
export function ErrorBoundary({ error }: { error?: unknown }) {
  const known = isRouteErrorResponse(error) ? error : null;
  const title = known ? `${known.status} ${known.statusText}`.trim() : "Application Error";
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1 style={{ fontSize: "24px" }}>{title}</h1>
    </main>
  );
}
