import { formatDateTime } from "../lib/date-utils";
import type { MetaFunction, LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { UserAutocomplete } from "../components/autocomplete";
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
import { confirmCopy, dirOf, langOf } from "../lib/confirm-copy";
import { pagesCopy } from "../lib/pages-copy";
import { formatNumber } from "../../../../packages/ui/src/format.ts";
import type { AdminLang } from "../lib/deletion-copy";
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

function formatDate(dateValue: string | number, lang: AdminLang, missing: string) {
  if (!dateValue) return missing;
  try {
    return formatDateTime(dateValue, lang);
  } catch {
    return String(dateValue);
  }
}

export default function SessionsPage() {
  const { sessions, stats, suspicious, total, error, user, authServerUrl } = useLoaderData<LoaderData>();
  const fetcher = useFetcher();
  const [searchParams] = useSearchParams();
  const lang = langOf(searchParams);
  const copy = confirmCopy(lang);
  const t = pagesCopy(lang).sessions;
  const c = pagesCopy(lang).common;
  const num = (value: number) => formatNumber(value, lang);
  const when = (value: string | number) => formatDate(value, lang, t.notAvailable);
  const [terminating, setTerminating] = useState<{ id: string; userId: string; email: string } | null>(null);
  const currentUserId = searchParams.get('user_id') ?? '';

  const suspiciousCount =
    (suspicious?.multipleIPsInShortTime?.length || 0) +
    (suspicious?.failedThenSuccessfulLogins?.length || 0);

  const endButton = (session: (typeof sessions)[number]) => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="text-[var(--color-destructive-text)] hover:bg-[var(--color-accent)]"
      disabled={fetcher.state !== 'idle'}
      title={copy.endSessionButton}
      aria-label={copy.endSessionAria(session.email)}
      onClick={() => setTerminating({ id: session.id, userId: session.userId, email: session.email })}
    >
      <Trash2 className="h-4 w-4" aria-hidden="true" />
    </Button>
  );

  return (
    <AdminLayout user={user} authServerUrl={authServerUrl} localized>
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-[var(--color-foreground)] mb-2">{t.title}</h2>
        <p className="text-[var(--color-muted-foreground)]">{t.intro}</p>
      </div>

        {error && (
          <div className="mb-6 p-4 ui-alert-error rounded-lg">
            {t.loadError(error)}
          </div>
        )}

        {/* Stats Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-8">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{t.total}</CardTitle>
              <Users className="h-4 w-4 text-[var(--color-muted-foreground)]" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{num(stats.totalSessions)}</div>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                {t.totalHint}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{t.activeNow}</CardTitle>
              <Activity className="h-4 w-4 text-[var(--color-success-text)]" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-[var(--color-success-text)]">{num(stats.activeSessions)}</div>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                {t.activeHint}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{t.logins(24)}</CardTitle>
              <Clock className="h-4 w-4 text-[var(--color-muted-foreground)]" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{num(stats.loginsLast24h)}</div>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                {t.loginsHint(24)}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{t.suspicious}</CardTitle>
              <AlertTriangle className={`h-4 w-4 ${suspiciousCount > 0 ? 'text-[var(--color-warning-text)]' : 'text-[var(--color-muted-foreground)]'}`} />
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${suspiciousCount > 0 ? 'text-[var(--color-warning-text)]' : ''}`}>
                {num(suspiciousCount)}
              </div>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                {t.suspiciousHint}
              </p>
            </CardContent>
          </Card>
        </div>


        {/* Suspicious Activity Alert */}
        {suspiciousCount > 0 && (
          <Card className="mb-8 ui-alert-warning">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2 text-[var(--color-warning-text)]">
                <AlertTriangle className="h-5 w-5" />
                {t.suspiciousTitle}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {suspicious.multipleIPsInShortTime.length > 0 && (
                <div>
                  <h4 className="font-medium mb-2">{t.manyIps}</h4>
                  <div className="space-y-2">
                    {suspicious.multipleIPsInShortTime.map((item, i) => (
                      <div key={i} className="text-sm p-2 rounded bg-[var(--color-card)] text-[var(--color-foreground)]">
                        <span className="font-medium"><bdi>{item.email}</bdi></span> — {t.manyIpsLine(item.ipCount)}
                        <div className="text-xs text-[var(--color-muted-foreground)]">
                          {t.ips} <bdi>{Array.isArray(item.ipAddresses) ? item.ipAddresses.join(', ') : item.ipAddresses}</bdi>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {suspicious.failedThenSuccessfulLogins.length > 0 && (
                <div>
                  <h4 className="font-medium mb-2">{t.failedThenOk}</h4>
                  <div className="space-y-2">
                    {suspicious.failedThenSuccessfulLogins.map((item, i) => (
                      <div key={i} className="text-sm p-2 rounded bg-[var(--color-card)] text-[var(--color-foreground)]">
                        <span className="font-medium"><bdi>{item.email}</bdi></span> — {t.failedLine(item.failedAttempts)}
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
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>{t.tableTitle}</CardTitle>
                <CardDescription>{t.count(total)}</CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <form method="get" className="flex items-end gap-2">
                  <UserAutocomplete
                    key={currentUserId}
                    mode="pick"
                    name="user_id"
                    label={t.user}
                    lang={lang}
                    defaultValue={currentUserId}
                    submitOnChange
                    className="w-full sm:w-72"
                    testId="sessions-user"
                  />
                  <Button type="submit" variant="outline" size="icon" aria-label={t.showUser} title={t.showUser}>
                    <Search className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </form>
                <Button variant="outline" size="icon" onClick={() => window.location.reload()} aria-label={c.refresh} title={c.refresh}>
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {sessions.length === 0 ? (
              <div className="text-center py-8 text-[var(--color-muted-foreground)]">
                <HelpCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>{t.empty}</p>
              </div>
            ) : (
              <>
                {/* Phone: a card per session; a table from md up */}
                <ul className="space-y-3 md:hidden" data-testid="session-cards">
                  {sessions.map((session) => (
                    <li key={session.id} className="rounded-lg border border-[var(--color-border)] p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-medium min-w-0 break-words"><bdi>{session.email}</bdi></div>
                        {endButton(session)}
                      </div>
                      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                        <dt className="text-[var(--color-muted-foreground)]">{t.ip}</dt>
                        <dd><bdi>{session.device?.ipAddress || t.notAvailable}</bdi></dd>
                        <dt className="text-[var(--color-muted-foreground)]">{t.lastUsed}</dt>
                        <dd>{when(session.lastUsed)}</dd>
                        <dt className="text-[var(--color-muted-foreground)]">{t.status}</dt>
                        <dd>
                          <Badge variant={session.isActive ? "default" : "secondary"}>{session.isActive ? t.active : t.inactive}</Badge>
                        </dd>
                      </dl>
                    </li>
                  ))}
                </ul>
                <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.user}</TableHead>
                    <TableHead>{t.device}</TableHead>
                    <TableHead>{t.ip}</TableHead>
                    <TableHead>{t.lastUsed}</TableHead>
                    <TableHead>{t.status}</TableHead>
                    <TableHead className="text-end">{c.actions}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.map((session) => (
                    <TableRow key={session.id}>
                      <TableCell>
                        <div className="font-medium"><bdi>{session.email}</bdi></div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Monitor className="h-4 w-4" aria-hidden="true" />
                          <span>{t.device}</span>
                        </div>
                        {session.device?.userAgent && (
                          <div className="text-xs text-[var(--color-muted-foreground)] max-w-[200px] truncate" dir="ltr" title={session.device.userAgent}>
                            {session.device.userAgent}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Globe className="h-3 w-3" aria-hidden="true" />
                          <bdi>{session.device?.ipAddress || t.notAvailable}</bdi>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div>{when(session.lastUsed)}</div>
                        <div className="text-xs text-[var(--color-muted-foreground)]">
                          {t.signedIn(when(session.authenticatedAt))}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={session.isActive ? "default" : "secondary"}>
                          {session.isActive ? t.active : t.inactive}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-end">{endButton(session)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      <ConfirmDialog
        open={!!terminating}
        cancelLabel={copy.cancel}
        onCancel={() => setTerminating(null)}
        title={copy.endSession.title}
        description={terminating ? copy.endSession.body(terminating.email) : ""}
        confirmLabel={copy.endSession.confirm}
        dir={dirOf(lang)}
        lang={lang}
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
