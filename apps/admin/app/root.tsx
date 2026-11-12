import type { LinksFunction, LoaderFunctionArgs, ShouldRevalidateFunction } from "react-router";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";
import { getAuthServerUrl, getOAuthClientId } from "./lib/config";
import { fetchShellTheme } from "./lib/shell-theme";
import { NAV_CSS } from "../../../packages/ui/src/nav/aun-nav.generated";
import { environmentOfHost, tabIconLinks } from "../../../packages/ui/src/app-icons/serve";

import "./tailwind.css";

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
  const env = context?.cloudflare?.env as { AUTH_SERVER_URL?: string; ADMIN_CLIENT_ID?: string; OAUTH_CLIENT_ID?: string } | undefined;
  return {
    shellCss: await fetchShellTheme(getAuthServerUrl(request, env), getOAuthClientId(env)),
    // QA and stage tabs get a corner dot (SVG); production the ICO and exact-size PNGs. One build
    // serves stage and production, so read the host
    tabIcons: tabIconLinks(environmentOfHost(new URL(request.url).hostname)),
  };
}

// The theme changes rarely: fetch it on full loads and after admin actions, not on every navigation
export const shouldRevalidate: ShouldRevalidateFunction = ({ formMethod, defaultShouldRevalidate }) =>
  !!formMethod && formMethod !== "GET" && defaultShouldRevalidate;

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<typeof loader>("root");
  const shellCss = data?.shellCss;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        {(data?.tabIcons ?? tabIconLinks("production")).map((l) => (
          <link key={l.href} rel="icon" href={l.href} type={l.type} sizes={l.sizes} />
        ))}
        <meta name="theme-color" content="#09273a" />
        {/* The shared header account button and menus (AlUmmahNow docs/design/NAV.md) */}
        <style data-nav dangerouslySetInnerHTML={{ __html: NAV_CSS }} />
        {shellCss ? <style data-shell-theme dangerouslySetInnerHTML={{ __html: shellCss }} /> : null}
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
  return <Outlet />;
}
