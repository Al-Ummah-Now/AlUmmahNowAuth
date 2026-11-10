import type { MetaFunction, LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import * as v from "valibot";
import {
  Users,
  Monitor,
  Activity,
  AlertTriangle,
  Clock,
  Globe,
  Trash2,
  RefreshCw,
  Search,
  HelpCircle,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { Badge } from "../components/ui/badge";
import { AdminLayout } from "../components/admin-layout";
import { ConfirmDialog } from "../components/confirm-dialog";
import { requireAuth, getAuthenticatedUser } from "../lib/auth.server";
import { getAuthServerUrl } from "../lib/config";
import { logger } from "../lib/logger.server";
import {
  listSessions,
  getSessionStats,
  getSuspiciousActivity,
  terminateSession,
  terminateAllUserSessions,
  isErrorResponse,
  type Session,
  type SessionStats,
  type SuspiciousActivity,
} from "../lib/admin-api.server";
import { useState } from "react";

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * Schema for validating session list query parameters
 * - limit: 1-100, defaults to 50
 * - offset: non-negative integer, defaults to 0
 * - user_id: valid UUID format if provided
 */
const SessionQuerySchema = v.object({
  limit: v.optional(
    v.pipe(
      v.string(),
      v.transform((s) => parseInt(s, 10)),
      v.integer("Limit must be an integer"),
      v.minValue(1, "Limit must be at least 1"),
      v.maxValue(100, "Limit cannot exceed 100")
    )
  ),
  offset: v.optional(
    v.pipe(
      v.string(),
      v.transform((s) => parseInt(s, 10)),
      v.integer("Offset must be an integer"),
      v.minValue(0, "Offset cannot be negative")
    )
  ),
  user_id: v.optional(v.pipe(v.string(), v.uuid("Invalid user ID format"))),
});

export const meta: MetaFunction = () => {
  return [
    { title: "Session Management - Al Ummah Now Admin" },
    { name: "description", content: "Monitor and manage active user sessions" },
  ];
};

type LoaderData = {
  sessions: Session[];
  stats: SessionStats;
  suspicious: SuspiciousActivity;
  total: number;
  error?: string;
  user: { id: string; email: string } | null;
  authServerUrl: string;
};

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as {
    AUTH_STORAGE: KVNamespace;
    AUTH_SERVER_URL?: string;
    ADMIN_CLIENT_ID?: string;
    ADMIN_CLIENT_SECRET?: string;
  };
  const ctx = context?.cloudflare?.ctx as ExecutionContext;

  logger.setDatabase(null, false);
  if (ctx) logger.setContext(ctx);

  logger.logLoader('sessions', request);

  await requireAuth(request, env, true);
  const sessionData = await getAuthenticatedUser(request, env);

  if (!sessionData) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const user = sessionData.user;
  const authServerUrl = getAuthServerUrl(request, env);

  const actingUser = {
    id: user.id,
    email: user.email,
    roles: user.roles || [],
  };

  // Parse and validate URL params for filtering
  const url = new URL(request.url);
  const queryParams: Record<string, string> = {};
  
  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');
  const userIdParam = url.searchParams.get('user_id');
  
  if (limitParam) queryParams.limit = limitParam;
  if (offsetParam) queryParams.offset = offsetParam;
  if (userIdParam) queryParams.user_id = userIdParam;

  let validatedParams: v.InferOutput<typeof SessionQuerySchema>;
  try {
    validatedParams = v.parse(SessionQuerySchema, queryParams);
  } catch (error) {
    if (error instanceof v.ValiError) {
      const errorDetails = error.issues.map((issue) => ({
        field: issue.path?.map((p: { key: string | number }) => p.key).join('.') || 'unknown',
        message: issue.message,
      }));
      logger.warn('Invalid session query parameters', { errors: errorDetails });
      return {
        sessions: [],
        stats: {
          totalSessions: 0,
          activeSessions: 0,
          loginsLast24h: 0,
          uniqueUsers: 0,
        },
        suspicious: {
          multipleIPsInShortTime: [],
          failedThenSuccessfulLogins: [],
        },
        total: 0,
        error: `Invalid query parameters: ${errorDetails.map(e => `${e.field}: ${e.message}`).join(', ')}`,
        user: { id: user.id, email: user.email },
        authServerUrl,
      };
    }
    throw error;
  }

  const limit = validatedParams.limit ?? 50;
  const offset = validatedParams.offset ?? 0;
  const userId = validatedParams.user_id;

  // Fetch data in parallel
  const [sessionsResult, statsResult, suspiciousResult] = await Promise.all([
    listSessions(env, actingUser, { limit, offset, user_id: userId }),
    getSessionStats(env, actingUser),
    getSuspiciousActivity(env, actingUser),
  ]);

  const defaultStats: SessionStats = {
    totalSessions: 0,
    activeSessions: 0,
    loginsLast24h: 0,
    uniqueUsers: 0,
  };

  const defaultSuspicious: SuspiciousActivity = {
    multipleIPsInShortTime: [] as SuspiciousActivity['multipleIPsInShortTime'],
    failedThenSuccessfulLogins: [] as SuspiciousActivity['failedThenSuccessfulLogins'],
  };

  if (isErrorResponse(sessionsResult)) {
    logger.error('Failed to load sessions', { error: sessionsResult.error });
    return {
      sessions: [],
      stats: isErrorResponse(statsResult) ? defaultStats : statsResult,
      suspicious: isErrorResponse(suspiciousResult) ? defaultSuspicious : suspiciousResult,
      total: 0,
      error: sessionsResult.error,
      user: { id: user.id, email: user.email },
      authServerUrl,
    };
  }

  return {
    sessions: sessionsResult.sessions,
    stats: isErrorResponse(statsResult) ? defaultStats : statsResult,
    suspicious: isErrorResponse(suspiciousResult) ? defaultSuspicious : suspiciousResult,
    total: sessionsResult.total,
    user: { id: user.id, email: user.email },
    authServerUrl,
  };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context?.cloudflare?.env as {
    AUTH_STORAGE: KVNamespace;
    AUTH_SERVER_URL?: string;
    ADMIN_CLIENT_ID?: string;
    ADMIN_CLIENT_SECRET?: string;
  };

  await requireAuth(request, env, true);
  const sessionData = await getAuthenticatedUser(request, env);

  if (!sessionData) {
    return { success: false, error: "Unauthorized" };
  }

  const user = sessionData.user;
  const actingUser = {
    id: user.id,
    email: user.email,
    roles: user.roles || [],
  };

  const formData = await request.formData();
  const action = formData.get('_action') as string;
  const userId = formData.get('userId') as string;
  const sessionId = formData.get('sessionId') as string;

  if (action === 'terminate') {
    const result = await terminateSession(env, actingUser, userId, sessionId);
    if (isErrorResponse(result)) {
      return { success: false, error: result.error };
    }
    return { success: true };
  }

  if (action === 'terminateAll') {
    const result = await terminateAllUserSessions(env, actingUser, userId);
    if (isErrorResponse(result)) {
      return { success: false, error: result.error };
    }
    return { success: true };
  }

  return { success: false, error: "Unknown action" };
}

function formatDate(dateValue: string | number) {
  if (!dateValue) return 'N/A';
  try {
    const date = typeof dateValue === 'number'
      ? new Date(dateValue * 1000)  // Unix seconds to milliseconds
      : new Date(dateValue);
    return date.toLocaleString();
  } catch {
    return String(dateValue);
  }
}

export default function SessionsPage() {
  const { sessions, stats, suspicious, total, error, user, authServerUrl } = useLoaderData<LoaderData>();
  const fetcher = useFetcher();
  const [terminating, setTerminating] = useState<{ id: string; userId: string; email: string } | null>(null);
  const [searchUserId, setSearchUserId] = useState('');

  const suspiciousCount =
    (suspicious?.multipleIPsInShortTime?.length || 0) +
    (suspicious?.failedThenSuccessfulLogins?.length || 0);

  return (
    <AdminLayout user={user} authServerUrl={authServerUrl}>
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-[rgb(var(--color-foreground))] mb-2">Session Management</h2>
        <p className="text-[rgb(var(--color-muted-foreground))]">
          Monitor and manage active user sessions across all devices
        </p>
      </div>

        {error && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-500">
            Error loading sessions: {error}
          </div>
        )}

        {/* Stats Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-8">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Sessions</CardTitle>
              <Users className="h-4 w-4 text-[rgb(var(--color-muted-foreground))]" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.totalSessions}</div>
              <p className="text-xs text-[rgb(var(--color-muted-foreground))]">
                Active sessions across all users
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Now</CardTitle>
              <Activity className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">{stats.activeSessions}</div>
              <p className="text-xs text-[rgb(var(--color-muted-foreground))]">
                Used in the last hour
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Logins (24h)</CardTitle>
              <Clock className="h-4 w-4 text-[rgb(var(--color-muted-foreground))]" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.loginsLast24h}</div>
              <p className="text-xs text-[rgb(var(--color-muted-foreground))]">
                New logins in the last 24 hours
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Suspicious</CardTitle>
              <AlertTriangle className={`h-4 w-4 ${suspiciousCount > 0 ? 'text-yellow-500' : 'text-[rgb(var(--color-muted-foreground))]'}`} />
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${suspiciousCount > 0 ? 'text-yellow-500' : ''}`}>
                {suspiciousCount}
              </div>
              <p className="text-xs text-[rgb(var(--color-muted-foreground))]">
                Flagged for review
              </p>
            </CardContent>
          </Card>
        </div>


        {/* Suspicious Activity Alert */}
        {suspiciousCount > 0 && (
          <Card className="mb-8 border-yellow-500/50">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2 text-yellow-500">
                <AlertTriangle className="h-5 w-5" />
                Suspicious Activity Detected
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {suspicious.multipleIPsInShortTime.length > 0 && (
                <div>
                  <h4 className="font-medium mb-2">Multiple IPs in Short Time</h4>
                  <div className="space-y-2">
                    {suspicious.multipleIPsInShortTime.map((item, i) => (
                      <div key={i} className="text-sm p-2 bg-yellow-500/10 rounded">
                        <span className="font-medium">{item.email}</span> - {item.ipCount} different IPs
                        <div className="text-xs text-[rgb(var(--color-muted-foreground))]">
                          IPs: {Array.isArray(item.ipAddresses) ? item.ipAddresses.join(', ') : item.ipAddresses}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {suspicious.failedThenSuccessfulLogins.length > 0 && (
                <div>
                  <h4 className="font-medium mb-2">Failed Then Successful Logins</h4>
                  <div className="space-y-2">
                    {suspicious.failedThenSuccessfulLogins.map((item, i) => (
                      <div key={i} className="text-sm p-2 bg-yellow-500/10 rounded">
                        <span className="font-medium">{item.email}</span> - {item.failedAttempts} failed attempts before success
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Sessions Table */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Active Sessions</CardTitle>
                <CardDescription>
                  {total} total sessions
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <form method="get" className="flex items-center gap-2">
                  <Input
                    name="user_id"
                    placeholder="Filter by User ID..."
                    value={searchUserId}
                    onChange={(e) => setSearchUserId(e.target.value)}
                    className="w-64"
                  />
                  <Button type="submit" variant="outline" size="icon">
                    <Search className="h-4 w-4" />
                  </Button>
                </form>
                <Button variant="outline" size="icon" onClick={() => window.location.reload()}>
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {sessions.length === 0 ? (
              <div className="text-center py-8 text-[rgb(var(--color-muted-foreground))]">
                <HelpCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No active sessions found</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Device</TableHead>
                    <TableHead>IP Address</TableHead>
                    <TableHead>Last Used</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.map((session) => (
                    <TableRow key={session.id}>
                      <TableCell>
                        <div>
                          <div className="font-medium">{session.email}</div>
                          <div className="text-xs text-[rgb(var(--color-muted-foreground))]">
                            {session.userId}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Monitor className="h-4 w-4" />
                          <span>Device</span>
                        </div>
                        {session.device?.userAgent && (
                          <div className="text-xs text-[rgb(var(--color-muted-foreground))] max-w-[200px] truncate" title={session.device.userAgent}>
                            {session.device.userAgent}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Globe className="h-3 w-3" />
                          {session.device?.ipAddress || 'N/A'}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div>{formatDate(session.lastUsed)}</div>
                        <div className="text-xs text-[rgb(var(--color-muted-foreground))]">
                          Auth: {formatDate(session.authenticatedAt)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={session.isActive ? "default" : "secondary"}>
                          {session.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-red-500 hover:text-red-600 hover:bg-red-500/10"
                          disabled={fetcher.state !== 'idle'}
                          title="End this session"
                          aria-label={`End session of ${session.email}`}
                          onClick={() => setTerminating({ id: session.id, userId: session.userId, email: session.email })}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      <ConfirmDialog
        open={!!terminating}
        cancelLabel="Cancel"
        onCancel={() => setTerminating(null)}
        title="End this session?"
        description={terminating ? `${terminating.email} is signed out on that device and has to sign in again there.` : ""}
        confirmLabel="End session"
        onConfirm={() => {
          if (terminating) {
            fetcher.submit({ _action: "terminate", userId: terminating.userId, sessionId: terminating.id }, { method: "post" });
          }
          setTerminating(null);
        }}
      />
    </AdminLayout>
  );
}
