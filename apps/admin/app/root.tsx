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

import "./tailwind.css";

export const links: LinksFunction = () => [
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
  return { shellCss: await fetchShellTheme(getAuthServerUrl(request, env), getOAuthClientId(env)) };
}

// The theme changes rarely: fetch it on full loads and after admin actions, not on every navigation
export const shouldRevalidate: ShouldRevalidateFunction = ({ formMethod, defaultShouldRevalidate }) =>
  !!formMethod && formMethod !== "GET" && defaultShouldRevalidate;

export function Layout({ children }: { children: React.ReactNode }) {
  const shellCss = useRouteLoaderData<typeof loader>("root")?.shellCss;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
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
