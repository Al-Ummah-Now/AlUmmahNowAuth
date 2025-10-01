import type { MetaFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { Users, ShieldCheck, Activity, Database } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { getUserStats } from "~/lib/db.server";
import { requireAuth } from "~/lib/auth.server";
import { getAuthServerUrl, getAppUrl, config } from "~/lib/config";
import { getOpenAuthClient } from "~/lib/openauth.client.server";
import { logger } from "~/lib/logger.server";

export const meta: MetaFunction = () => {
  return [
    { title: "Al Ummah Now - Admin Dashboard" },
    { name: "description", content: "User management and administration" },
  ];
};

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as { AUTH_DB: D1Database; AUTH_STORAGE: KVNamespace; AUTH_SERVER_URL?: string };
  const ctx = context?.cloudflare?.ctx as ExecutionContext;

  // Initialize logger
  if (env?.AUTH_DB) {
    logger.setDatabase(env.AUTH_DB, true);
    if (ctx) logger.setContext(ctx);
  }

  logger.logLoader('index', request);

  // Get auth server URL and app URL from request
  const authServerUrl = getAuthServerUrl(request, env);
  const appUrl = getAppUrl(request, env);

  logger.debug('Configuration loaded', { authServerUrl, appUrl });

  // Get OpenAuth client
  const client = getOpenAuthClient(request, env);

  // Generate authorize URL
  logger.debug('Generating authorize URL');
  const { url: authorizeUrl } = await client.authorize(`${appUrl}/auth/callback`, "code");
  logger.debug('Authorize URL generated', { authorizeUrl });

  // Check if user is authenticated
  let isAuthenticated = false;
  let user = null;

  try {
    logger.debug('Checking authentication');
    user = await requireAuth(request, env, true);
    isAuthenticated = true;
    logger.logAuth('User authenticated', { userId: user.id, email: user.email });
  } catch (error) {
    // Not authenticated - show welcome page
    isAuthenticated = false;
    logger.debug('User not authenticated');
  }

  // If not authenticated, return data for welcome page
  if (!isAuthenticated) {
    logger.info('Returning welcome page data');
    return {
      isAuthenticated: false,
      totalUsers: 0,
      adminUsers: 0,
      authServerUrl,
      appUrl,
      authorizeUrl,
    };
  }

  // If authenticated, return dashboard data
  try {
    if (!env?.AUTH_DB) {
      logger.warn("AUTH_DB not available in development mode");
      return {
        isAuthenticated: true,
        totalUsers: 0,
        adminUsers: 0,
        authServerUrl,
        appUrl,
        authorizeUrl: "",
      };
    }
    logger.logDB('Loading user stats');
    const stats = await getUserStats(env.AUTH_DB);
    logger.info('Dashboard data loaded', { totalUsers: stats.totalUsers, adminUsers: stats.adminUsers });
    return {
      isAuthenticated: true,
      ...stats,
      authServerUrl,
      appUrl,
      authorizeUrl: "",
    };
  } catch (error) {
    logger.error("Error loading stats", {
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      isAuthenticated: true,
      totalUsers: 0,
      adminUsers: 0,
      authServerUrl,
      appUrl,
    };
  }
}

export default function Index() {
  const data = useLoaderData<typeof loader>();

  // Show welcome page if not authenticated
  if (!data.isAuthenticated) {
    return (
      <div className="min-h-screen bg-[rgb(var(--color-background))]">
        {/* Navigation */}
        <nav className="border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-card))]">
          <div className="container mx-auto px-4 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <img
                  src="https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png"
                  alt="Al Ummah Now"
                  className="h-10 w-10 rounded-lg"
                />
                <div>
                  <h1 className="text-xl font-bold text-[rgb(var(--color-foreground))]">Al Ummah Now</h1>
                  <p className="text-sm text-[rgb(var(--color-muted-foreground))]">Admin Dashboard</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button asChild>
                  <a href={data.authorizeUrl}>Sign In</a>
                </Button>
              </div>
            </div>
          </div>
        </nav>

        {/* Welcome Content */}
        <main className="container mx-auto px-4 py-16">
          <div className="max-w-4xl mx-auto text-center">
            {/* Hero Section */}
            <div className="mb-12">
              <div className="flex justify-center mb-6">
                <div className="relative">
                  <div className="absolute inset-0 bg-[rgb(var(--color-primary))] opacity-20 blur-3xl rounded-full"></div>
                  <img
                    src="https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png"
                    alt="Al Ummah Now"
                    className="h-24 w-24 rounded-2xl relative z-10"
                  />
                </div>
              </div>
              <h1 className="text-5xl font-bold mb-4 bg-gradient-to-r from-[rgb(var(--color-primary))] to-[rgb(var(--color-accent))] bg-clip-text text-transparent">
                Welcome to Al Ummah Now
              </h1>
              <p className="text-xl text-[rgb(var(--color-muted-foreground))] mb-8 max-w-2xl mx-auto">
                Secure authentication and user management system for the Muslim community.
                Manage users, roles, and access with confidence.
              </p>
              <div className="flex justify-center gap-4">
                <Button size="lg" asChild>
                  <a href={data.authorizeUrl}>
                    <ShieldCheck className="h-5 w-5 mr-2" />
                    Admin Sign In
                  </a>
                </Button>
                <Button size="lg" variant="outline" asChild>
                  <a href={data.authServerUrl} target="_blank" rel="noopener noreferrer">
                    Auth Portal
                  </a>
                </Button>
              </div>
            </div>

            {/* Features Grid */}
            <div className="grid md:grid-cols-3 gap-6 mt-16">
              <Card>
                <CardHeader>
                  <div className="flex justify-center mb-4">
                    <div className="h-12 w-12 rounded-lg bg-[rgb(var(--color-primary))]/10 flex items-center justify-center">
                      <Users className="h-6 w-6 text-[rgb(var(--color-primary))]" />
                    </div>
                  </div>
                  <CardTitle>User Management</CardTitle>
                  <CardDescription>
                    Create, update, and manage user accounts with full CRUD capabilities
                  </CardDescription>
                </CardHeader>
              </Card>

              <Card>
                <CardHeader>
                  <div className="flex justify-center mb-4">
                    <div className="h-12 w-12 rounded-lg bg-[rgb(var(--color-accent))]/10 flex items-center justify-center">
                      <ShieldCheck className="h-6 w-6 text-[rgb(var(--color-accent))]" />
                    </div>
                  </div>
                  <CardTitle>Role-Based Access</CardTitle>
                  <CardDescription>
                    Assign admin and user roles with granular permission control
                  </CardDescription>
                </CardHeader>
              </Card>

              <Card>
                <CardHeader>
                  <div className="flex justify-center mb-4">
                    <div className="h-12 w-12 rounded-lg bg-[rgb(var(--color-primary))]/10 flex items-center justify-center">
                      <Activity className="h-6 w-6 text-[rgb(var(--color-primary))]" />
                    </div>
                  </div>
                  <CardTitle>Real-Time Analytics</CardTitle>
                  <CardDescription>
                    Monitor user activity and system statistics in real-time
                  </CardDescription>
                </CardHeader>
              </Card>
            </div>

            {/* Info Section */}
            <div className="mt-16 bg-[rgb(var(--color-card))] border border-[rgb(var(--color-border))] rounded-xl p-8">
              <h2 className="text-2xl font-bold mb-4">Admin Access Required</h2>
              <p className="text-[rgb(var(--color-muted-foreground))] mb-6">
                This dashboard is restricted to administrators only. Sign in with your admin credentials
                to access user management features and system analytics.
              </p>
              <div className="flex items-center justify-center gap-2 text-sm text-[rgb(var(--color-muted-foreground))]">
                <Database className="h-4 w-4" />
                <span>Powered by OpenAuth • Cloudflare Workers • D1 Database</span>
              </div>
            </div>
          </div>
        </main>

        {/* Footer */}
        <footer className="border-t border-[rgb(var(--color-border))] mt-20">
          <div className="container mx-auto px-4 py-8">
            <p className="text-center text-sm text-[rgb(var(--color-muted-foreground))]">
              © 2025 Al Ummah Now. Built with React Router v7 and shadcn/ui.
            </p>
          </div>
        </footer>
      </div>
    );
  }

  // Show dashboard if authenticated
  return (
    <div className="min-h-screen bg-[rgb(var(--color-background))]">
      {/* Navigation */}
      <nav className="border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-card))]">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img
                src="https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png"
                alt="Al Ummah Now"
                className="h-10 w-10 rounded-lg"
              />
              <div>
                <h1 className="text-xl font-bold text-[rgb(var(--color-foreground))]">Al Ummah Now</h1>
                <p className="text-sm text-[rgb(var(--color-muted-foreground))]">Admin Dashboard</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" asChild>
                <Link to="/users">Manage Users</Link>
              </Button>
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h2 className="text-3xl font-bold text-[rgb(var(--color-foreground))] mb-2">Dashboard</h2>
          <p className="text-[rgb(var(--color-muted-foreground))]">
            Welcome to the Al Ummah Now administration panel
          </p>
        </div>

        {/* Stats Grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-8">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Users</CardTitle>
              <Users className="h-4 w-4 text-[rgb(var(--color-muted-foreground))]" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{data.totalUsers}</div>
              <p className="text-xs text-[rgb(var(--color-muted-foreground))]">
                Registered users
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Sessions</CardTitle>
              <Activity className="h-4 w-4 text-[rgb(var(--color-muted-foreground))]" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">-</div>
              <p className="text-xs text-[rgb(var(--color-muted-foreground))]">
                Current active sessions
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Admin Users</CardTitle>
              <ShieldCheck className="h-4 w-4 text-[rgb(var(--color-muted-foreground))]" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{data.adminUsers}</div>
              <p className="text-xs text-[rgb(var(--color-muted-foreground))]">
                Users with admin role
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Database</CardTitle>
              <Database className="h-4 w-4 text-[rgb(var(--color-muted-foreground))]" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">Connected</div>
              <p className="text-xs text-[rgb(var(--color-muted-foreground))]">
                D1 Database Status
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Quick Actions */}
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>User Management</CardTitle>
              <CardDescription>
                Create, edit, and manage user accounts
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild className="w-full">
                <Link to="/users">Go to Users</Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Authentication</CardTitle>
              <CardDescription>
                Manage authentication settings and providers
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" className="w-full" disabled>
                Coming Soon
              </Button>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
