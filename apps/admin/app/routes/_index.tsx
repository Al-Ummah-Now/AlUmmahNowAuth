import type { MetaFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { Users, ShieldCheck, Activity, Database, Shield } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { AdminLayout } from "../components/admin-layout";
import { getUserStats, getRoleStats, getUsersByRole, isErrorResponse } from "../lib/admin-api.server";
import { redirectToLogin, requireAuth } from "../lib/auth.server";
import { getAuthServerUrl, getAppUrl } from "../lib/config";
import { logger } from "../lib/logger.server";

export const meta: MetaFunction = () => {
  return [
    { title: "Al Ummah Now - Admin Dashboard" },
    { name: "description", content: "User management and administration" },
  ];
};

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as {
    AUTH_STORAGE: KVNamespace;
    AUTH_SERVER_URL?: string;
    APP_URL?: string;
    ADMIN_CLIENT_ID?: string;
    ADMIN_CLIENT_SECRET?: string;
  };
  const ctx = context?.cloudflare?.ctx as ExecutionContext;

  // Initialize logger
  logger.setDatabase(null, false);
  if (ctx) logger.setContext(ctx);

  logger.logLoader('index', request);

  // Get auth server URL and app URL from request
  const authServerUrl = getAuthServerUrl(request, env);
  const appUrl = getAppUrl(request, env);

  logger.debug('Configuration loaded', { authServerUrl, appUrl });

  // No landing page: without a usable admin session requireAuth throws a
  // redirect into sign-in (silent when the browser is signed in to Al Ummah Now)
  let user: { id: string; email: string; roles: string[] } | null = null;
  try {
    user = await requireAuth(request, env, true);
    logger.logAuth('User authenticated', { userId: user.id, email: user.email });
  } catch (error) {
    if (error instanceof Response) throw error;
    throw redirectToLogin(request);
  }

  // If authenticated, return dashboard data
  // requireAuth returned a user, so this only guards the type
  if (!user) {
    logger.error('User is null despite isAuthenticated being true');
    return {
      isAuthenticated: true,
      user: null,
      totalUsers: 0,
      adminUsers: 0,
      totalRoles: 0,
      systemRoles: 0,
      customRoles: 0,
      usersByRole: [],
      authServerUrl,
      appUrl,
      authorizeUrl: "",
    };
  }

  try {
    // Build acting user context for API calls
    const actingUser = {
      id: user.id,
      email: user.email,
      roles: user.roles || [],
    };

    logger.info('Loading dashboard stats via API', { userId: user.id });

    // Call stats APIs (pass request for localhost detection)
    const stats = await getUserStats(env, actingUser, request);
    const roleStats = await getRoleStats(env, actingUser);
    const usersByRoleResult = await getUsersByRole(env, actingUser, 5, request);

    // Handle errors gracefully
    if (isErrorResponse(stats)) {
      logger.error('Error loading user stats', { error: stats.error });
      return {
        isAuthenticated: true,
        user: { id: user.id, email: user.email },
        totalUsers: 0,
        adminUsers: 0,
        totalRoles: 0,
        systemRoles: 0,
        customRoles: 0,
        usersByRole: [],
        authServerUrl,
        appUrl,
        authorizeUrl: "",
        error: stats.error,
      };
    }

    if (isErrorResponse(roleStats)) {
      logger.error('Error loading role stats', { error: roleStats.error });
    }

    if (isErrorResponse(usersByRoleResult)) {
      logger.error('Error loading users by role', { error: usersByRoleResult.error });
    }

    const usersByRole = isErrorResponse(usersByRoleResult) ? [] : usersByRoleResult;

    logger.info('Dashboard data loaded via API', {
      totalUsers: stats.totalUsers,
      adminUsers: stats.adminUsers,
      totalRoles: isErrorResponse(roleStats) ? 0 : roleStats.totalRoles,
    });

    return {
      isAuthenticated: true,
      user: { id: user.id, email: user.email },
      totalUsers: stats.totalUsers,
      adminUsers: stats.adminUsers,
      totalRoles: isErrorResponse(roleStats) ? 0 : roleStats.totalRoles,
      systemRoles: isErrorResponse(roleStats) ? 0 : roleStats.systemRoles,
      customRoles: isErrorResponse(roleStats) ? 0 : roleStats.customRoles,
      usersByRole,
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
      user: user ? { id: user.id, email: user.email } : null,
      totalUsers: 0,
      adminUsers: 0,
      totalRoles: 0,
      systemRoles: 0,
      customRoles: 0,
      usersByRole: [],
      authServerUrl,
      appUrl,
      authorizeUrl: "",
    };
  }
}

export default function Index() {
  const data = useLoaderData<typeof loader>();

  // Show dashboard if authenticated
  return (
    <AdminLayout user={data.user} authServerUrl={data.authServerUrl}>
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-[rgb(var(--color-foreground))] mb-2">Dashboard</h2>
        <p className="text-[rgb(var(--color-muted-foreground))]">
          Welcome to the Al Ummah Now administration panel
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 mb-8">
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
            <CardTitle className="text-sm font-medium">Total Roles</CardTitle>
            <Shield className="h-4 w-4 text-[rgb(var(--color-muted-foreground))]" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.totalRoles}</div>
            <p className="text-xs text-[rgb(var(--color-muted-foreground))]">
              {data.systemRoles} system / {data.customRoles} custom
            </p>
          </CardContent>
        </Card>

        <Link to="/sessions" className="block hover:opacity-80 transition-opacity">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Sessions</CardTitle>
              <Activity className="h-4 w-4 text-[rgb(var(--color-muted-foreground))]" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">-</div>
              <p className="text-xs text-[rgb(var(--color-muted-foreground))]">
                Click to manage sessions
              </p>
            </CardContent>
          </Card>
        </Link>

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

      {/* Users by Role */}
      {data.usersByRole && data.usersByRole.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Users by Role</CardTitle>
            <CardDescription>
              Distribution of users across roles
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {data.usersByRole.map((role) => (
                <div key={role.name} className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium text-[rgb(var(--color-foreground))]">
                      {role.name}
                    </span>
                    <span className="text-[rgb(var(--color-muted-foreground))]">
                      {role.user_count} {role.user_count === 1 ? 'user' : 'users'}
                    </span>
                  </div>
                  <div className="h-2 bg-[rgb(var(--color-muted))] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[rgb(var(--color-primary))] rounded-full"
                      style={{
                        width: `${data.totalUsers > 0 ? (role.user_count / data.totalUsers) * 100 : 0}%`
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </AdminLayout>
  );
}
