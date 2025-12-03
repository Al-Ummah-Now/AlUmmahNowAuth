import type { MetaFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link } from "react-router";
import {
  Users,
  Monitor,
  Smartphone,
  Tablet,
  Activity,
  AlertTriangle,
  Clock,
  Globe,
  ArrowLeft,
  ExternalLink
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { requireAuth } from "../lib/auth.server";
import { getAuthServerUrl, getAppUrl } from "../lib/config";
import { logger } from "../lib/logger.server";

export const meta: MetaFunction = () => {
  return [
    { title: "Session Management - Al Ummah Now Admin" },
    { name: "description", content: "Monitor and manage active user sessions" },
  ];
};

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as {
    AUTH_DB: D1Database;
    AUTH_STORAGE: KVNamespace;
    AUTH_SERVER_URL?: string;
    APP_URL?: string;
  };
  const ctx = context?.cloudflare?.ctx as ExecutionContext;

  // Initialize logger
  if (env?.AUTH_DB) {
    logger.setDatabase(env.AUTH_DB, true);
    if (ctx) logger.setContext(ctx);
  }

  logger.logLoader('sessions', request);

  // Check authentication - requireAuth throws redirect if not authenticated
  await requireAuth(request, env);

  const authServerUrl = getAuthServerUrl(request, env);

  // The actual session data will be loaded from the auth server's admin dashboard
  // This page serves as an entry point that redirects to the auth server's session management UI
  return {
    authServerUrl,
    dashboardUrl: `${authServerUrl}/admin/sessions/dashboard`,
  };
}

export default function SessionsPage() {
  const { authServerUrl, dashboardUrl } = useLoaderData<typeof loader>();

  return (
    <div className="min-h-screen bg-[rgb(var(--color-background))]">
      {/* Navigation */}
      <nav className="border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-card))]">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <Link to="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
              <img
                src="https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png"
                alt="Al Ummah Now"
                className="h-10 w-10 rounded-lg"
              />
              <div>
                <h1 className="text-xl font-bold text-[rgb(var(--color-foreground))]">Al Ummah Now</h1>
                <p className="text-sm text-[rgb(var(--color-muted-foreground))]">Admin Dashboard</p>
              </div>
            </Link>
            <div className="flex items-center gap-2">
              <Button variant="outline" asChild>
                <Link to="/">
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back to Dashboard
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h2 className="text-3xl font-bold text-[rgb(var(--color-foreground))] mb-2">Session Management</h2>
          <p className="text-[rgb(var(--color-muted-foreground))]">
            Monitor and manage active user sessions across all devices
          </p>
        </div>

        {/* Info Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-8">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Browser Sessions</CardTitle>
              <Monitor className="h-4 w-4 text-[rgb(var(--color-muted-foreground))]" />
            </CardHeader>
            <CardContent>
              <p className="text-xs text-[rgb(var(--color-muted-foreground))]">
                Track active browser sessions per user
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Multi-Account</CardTitle>
              <Users className="h-4 w-4 text-[rgb(var(--color-muted-foreground))]" />
            </CardHeader>
            <CardContent>
              <p className="text-xs text-[rgb(var(--color-muted-foreground))]">
                Up to 3 accounts per browser session
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Device Types</CardTitle>
              <Smartphone className="h-4 w-4 text-[rgb(var(--color-muted-foreground))]" />
            </CardHeader>
            <CardContent>
              <p className="text-xs text-[rgb(var(--color-muted-foreground))]">
                Desktop, Mobile, Tablet tracking
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Security</CardTitle>
              <AlertTriangle className="h-4 w-4 text-[rgb(var(--color-muted-foreground))]" />
            </CardHeader>
            <CardContent>
              <p className="text-xs text-[rgb(var(--color-muted-foreground))]">
                Force logout and session revocation
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Main Action Card */}
        <Card className="max-w-2xl mx-auto">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              <div className="h-16 w-16 rounded-full bg-[rgb(var(--color-primary))]/10 flex items-center justify-center">
                <Activity className="h-8 w-8 text-[rgb(var(--color-primary))]" />
              </div>
            </div>
            <CardTitle className="text-2xl">Session Dashboard</CardTitle>
            <CardDescription className="text-base">
              Access the full session management dashboard to monitor active sessions,
              view device breakdowns, detect suspicious activity, and manage user sessions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-[rgb(var(--color-muted))]/30 rounded-lg p-4">
              <h4 className="font-medium mb-2">Available Actions:</h4>
              <ul className="space-y-2 text-sm text-[rgb(var(--color-muted-foreground))]">
                <li className="flex items-center gap-2">
                  <Globe className="h-4 w-4" />
                  View all active sessions across users
                </li>
                <li className="flex items-center gap-2">
                  <Monitor className="h-4 w-4" />
                  See device type breakdown (Desktop/Mobile/Tablet)
                </li>
                <li className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  Monitor suspicious activity alerts
                </li>
                <li className="flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  Track login patterns and session duration
                </li>
                <li className="flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  Terminate individual or all user sessions
                </li>
              </ul>
            </div>

            <Button asChild className="w-full" size="lg">
              <a href={dashboardUrl} target="_blank" rel="noopener noreferrer">
                <Activity className="h-5 w-5 mr-2" />
                Open Session Dashboard
                <ExternalLink className="h-4 w-4 ml-2" />
              </a>
            </Button>

            <p className="text-center text-xs text-[rgb(var(--color-muted-foreground))]">
              Opens in a new tab on the authentication server
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
