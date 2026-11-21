import { formatDateMs, formatDateTimeMs } from "../lib/date-utils";
import { useState } from "react";
import type { MetaFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams, useNavigate } from "react-router";
import { FileText, Calendar, Filter, X, Search } from "lucide-react";
import { AdminLayout } from "../components/admin-layout";
import { UserAutocomplete } from "../components/autocomplete";
import { getAuthServerUrl } from "../lib/config";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { requireAuth } from "../lib/auth.server";
import { logger } from "../lib/logger.server";
import { actorLabel, isSystemUserId } from "../lib/system-accounts";
import { dirOf, langOf } from "../lib/deletion-copy";
import { pagesCopy } from "../lib/pages-copy";
import { userNames } from "../lib/user-names.server";
import {
  getAuditLogs,
  isErrorResponse,
  type ActingUser,
} from "../lib/admin-api.server";
import { getCloudflare } from "../lib/cloudflare-context";

export const meta: MetaFunction = () => {
  return [
    { title: "Audit Logs - Al Ummah Now Admin" },
    { name: "description", content: "View system audit logs and security events" },
  ];
};

interface LoaderData {
  events: Array<{
    id: number;
    timestamp: string;
    event_type: string;
    severity: string;
    user_id: string | null;
    ip_address: string | null;
    user_agent: string | null;
    success: boolean;
    error_message: string | null;
    metadata: Record<string, unknown>;
  }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
    /** The total stopped counting at a cap: more events exist. */
    capped?: boolean;
  };
  filters: {
    event_type?: string;
    severity?: string;
    search?: string;
    start_date?: string;
    end_date?: string;
  };
  user: { id: string; email: string } | null;
  authServerUrl: string;
  /** user id → name (display name, else email) for the events on this page and the user filter */
  names?: Record<string, string>;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getCloudflare(context).env as {
    AUTH_DB?: D1Database;
    AUTH_STORAGE: KVNamespace;
    AUTH_SERVER_URL?: string;
    ADMIN_CLIENT_ID?: string;
    ADMIN_CLIENT_SECRET?: string;
  };
  const ctx = getCloudflare(context).ctx as ExecutionContext;

  // Initialize logger
  logger.setDatabase(null, false);
  if (ctx) logger.setContext(ctx);

  // Always require admin authentication
  let currentUser: { id: string; email: string; roles?: string[] };
  try {
    currentUser = await requireAuth(request, env, true) as { id: string; email: string; roles?: string[] };
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }
    throw new Response(null, {
      status: 302,
      headers: {
        Location: "/login",
      },
    });
  }

  const authServerUrl = getAuthServerUrl(request, env);
  const user = { id: currentUser.id, email: currentUser.email };

  // Construct acting user for M2M API calls
  const actingUser: ActingUser = {
    id: currentUser.id,
    email: currentUser.email,
    roles: currentUser.roles || [],
  };

  try {
    // Get query parameters
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get("page") || "1");
    const limit = parseInt(url.searchParams.get("limit") || "50");
    const event_type = url.searchParams.get("event_type") || undefined;
    const severity = url.searchParams.get("severity") || undefined;
    const search = url.searchParams.get("search") || undefined;
    const start_date = url.searchParams.get("start_date") || undefined;
    const end_date = url.searchParams.get("end_date") || undefined;

    // Call the audit logs API
    const response = await getAuditLogs(env, actingUser, {
      page,
      limit,
      event_type,
      severity,
      user_id: search, // Search is used for user_id filtering
      start_date,
      end_date,
    });

    if (isErrorResponse(response)) {
      logger.error("Error loading audit logs", { error: response.error });
      return {
        events: [],
        pagination: { page: 1, limit: 50, total: 0, pages: 0 },
        filters: { event_type, severity, search, start_date, end_date },
        user,
        authServerUrl,
      };
    }

    // The API already returns properly formatted events
    const events = response.data.map((event) => ({
      ...event,
      // Ensure metadata is an object
      metadata: typeof event.metadata === "string"
        ? JSON.parse(event.metadata || "{}")
        : event.metadata || {},
    }));

    return {
      events,
      pagination: response.pagination,
      filters: { event_type, severity, search, start_date, end_date },
      user,
      authServerUrl,
      names: await userNames(env.AUTH_DB, [...events.map((e) => e.user_id), search]),
    };
  } catch (error) {
    logger.error("Error loading audit logs", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      events: [],
      pagination: { page: 1, limit: 50, total: 0, pages: 0 },
      filters: {},
      user,
      authServerUrl,
    };
  }
}

/** Sign-in theme changes, offered as event filters. */
const THEME_EVENTS = [
  "theme.created",
  "theme.draft_saved",
  "theme.asset_uploaded",
  "theme.asset_removed",
  "theme.published",
  "theme.default_set",
  "theme.client_default_set",
  "theme.deleted",
  "theme.imported",
];

/** Refused attempts on system accounts (auth security/system-accounts.ts), offered as event filters. */
const SYSTEM_ACCOUNT_EVENTS = ["security.system_account.sign_in_refused", "security.system_account.role_grant_refused"];

/** Admin invites (docs/USER_INVITES.md), offered as event filters. */
const INVITE_EVENTS = [
  "user.invited",
  "user.invite.resent",
  "user.invite.link_created",
  "user.invite.opened",
  "user.invite.accepted",
  "user.invite.revoked",
  "user.invite.restored",
  "user.invite.purge_requested",
  "user.invite.purged",
];

export default function AuditLogs() {
  const { events, pagination, filters, user, authServerUrl, names = {} } = useLoaderData<LoaderData>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [showFilters, setShowFilters] = useState(false);
  const lang = langOf(searchParams);
  const t = pagesCopy(lang).audit;

  // Local state for filter form
  const [eventTypeFilter, setEventTypeFilter] = useState(filters.event_type || "");
  const [severityFilter, setSeverityFilter] = useState(filters.severity || "all");
  const [searchQuery, setSearchQuery] = useState(filters.search || "");
  const [startDate, setStartDate] = useState(filters.start_date || "");
  const [endDate, setEndDate] = useState(filters.end_date || "");

  const applyFilters = () => {
    const params = new URLSearchParams();
    if (eventTypeFilter) params.set("event_type", eventTypeFilter);
    if (severityFilter && severityFilter !== "all") params.set("severity", severityFilter);
    if (searchQuery) params.set("search", searchQuery);
    if (startDate) params.set("start_date", startDate);
    if (endDate) params.set("end_date", endDate);
    params.set("page", "1"); // Reset to first page when filters change
    navigate(`/audit?${params.toString()}`);
  };

  const clearFilters = () => {
    setEventTypeFilter("");
    setSeverityFilter("all");
    setSearchQuery("");
    setStartDate("");
    setEndDate("");
    navigate("/audit");
  };

  const goToPage = (page: number) => {
    const params = new URLSearchParams(searchParams);
    params.set("page", page.toString());
    navigate(`/audit?${params.toString()}`);
  };

  const formatTimestamp = (timestamp: string) => {
    return formatDateTimeMs(timestamp, lang);
  };

  const getSeverityColor = (severity: string) => {
    switch (severity.toLowerCase()) {
      case "critical":
        return "destructive";
      case "error":
        return "destructive";
      case "warning":
        return "default";
      case "info":
        return "secondary";
      case "debug":
        return "outline";
      default:
        return "secondary";
    }
  };

  const hasActiveFilters = eventTypeFilter || (severityFilter && severityFilter !== "all") || searchQuery || startDate || endDate;

  return (
    <AdminLayout user={user} authServerUrl={authServerUrl} localized>
      <div className="mb-6">
        <h2 className="text-3xl font-bold text-[var(--color-foreground)] mb-2">{t.title}</h2>
        <p className="text-[var(--color-muted-foreground)]">{t.intro}</p>
      </div>
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>{t.tableTitle}</CardTitle>
                <CardDescription>{t.tableIntro}</CardDescription>
              </div>
              <Button
                variant={showFilters ? "default" : "outline"}
                onClick={() => setShowFilters(!showFilters)}
              >
                <Filter className="h-4 w-4 me-2" aria-hidden="true" />
                {showFilters ? t.hideFilters : t.showFilters}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {/* Filters Section */}
            {showFilters && (
              <div className="mb-6 p-4 border border-[var(--color-border)] rounded-lg bg-[var(--color-muted)]/20">
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  <div className="grid gap-2">
                    <Label htmlFor="event_type">{t.eventType}</Label>
                    <Input
                      id="event_type"
                      dir="ltr"
                      placeholder={t.eventPlaceholder}
                      list="event-type-suggestions"
                      value={eventTypeFilter}
                      onChange={(e) => setEventTypeFilter(e.target.value)}
                    />
                    <datalist id="event-type-suggestions">
                      {THEME_EVENTS.map((t) => <option key={t} value={t} />)}
                      {INVITE_EVENTS.map((t) => <option key={t} value={t} />)}
                      {SYSTEM_ACCOUNT_EVENTS.map((t) => <option key={t} value={t} />)}
                    </datalist>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="severity">{t.severity}</Label>
                    <Select value={severityFilter} onValueChange={setSeverityFilter}>
                      <SelectTrigger id="severity">
                        <SelectValue placeholder={t.allSeverities} />
                      </SelectTrigger>
                      <SelectContent dir={dirOf(lang)}>
                        <SelectItem value="all">{t.allSeverities}</SelectItem>
                        {["debug", "info", "warning", "error", "critical"].map((level) => (
                          <SelectItem key={level} value={level}>{t.severities[level]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* The loader filters this by user_id: a user picker, by name or email */}
                  <UserAutocomplete
                    key={filters.search ?? ""}
                    mode="pick"
                    label={t.user}
                    lang={lang}
                    defaultValue={filters.search ?? ""}
                    onChange={(id) => setSearchQuery(id)}
                    testId="audit-user"
                  />

                  <div className="grid gap-2">
                    <Label htmlFor="start_date">{t.from}</Label>
                    <Input
                      id="start_date"
                      type="datetime-local"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="end_date">{t.to}</Label>
                    <Input
                      id="end_date"
                      type="datetime-local"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                    />
                  </div>
                </div>

                <div className="flex gap-2 mt-4">
                  <Button onClick={applyFilters}>
                    <Search className="h-4 w-4 me-2" aria-hidden="true" />
                    {t.apply}
                  </Button>
                  {hasActiveFilters && (
                    <Button variant="outline" onClick={clearFilters}>
                      <X className="h-4 w-4 me-2" aria-hidden="true" />
                      {t.clear}
                    </Button>
                  )}
                </div>
              </div>
            )}

            {/* Active Filters Display */}
            {hasActiveFilters && !showFilters && (
              <div className="mb-4 flex flex-wrap gap-2 items-center">
                <span className="text-sm text-[var(--color-muted-foreground)]">{t.active}</span>
                {eventTypeFilter && (
                  <Badge variant="outline">
                    {t.eventChip("")}<bdi>{eventTypeFilter}</bdi>
                  </Badge>
                )}
                {severityFilter && severityFilter !== "all" && (
                  <Badge variant="outline">
                    {t.severityChip(t.severities[severityFilter] ?? severityFilter)}
                  </Badge>
                )}
                {searchQuery && (
                  <Badge variant="outline">
                    {t.userChip("")}<bdi>{names[searchQuery] ?? searchQuery}</bdi>
                  </Badge>
                )}
                {startDate && (
                  <Badge variant="outline">
                    {t.fromChip(formatDateMs(startDate, lang))}
                  </Badge>
                )}
                {endDate && (
                  <Badge variant="outline">
                    {t.toChip(formatDateMs(endDate, lang))}
                  </Badge>
                )}
                <Button variant="ghost" size="sm" onClick={clearFilters} aria-label={t.clear} title={t.clear}>
                  <X className="h-3 w-3" aria-hidden="true" />
                </Button>
              </div>
            )}

            {/* Events Table */}
            {events.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <FileText className="h-12 w-12 text-[var(--color-muted-foreground)] mb-4" />
                <h3 className="text-lg font-semibold mb-2">{t.emptyTitle}</h3>
                <p className="text-sm text-[var(--color-muted-foreground)] mb-4">{hasActiveFilters ? t.emptyFiltered : t.emptyAll}</p>
                {hasActiveFilters && (
                  <Button variant="outline" onClick={clearFilters}>
                    {t.clear}
                  </Button>
                )}
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <Table aria-label={t.tableTitle}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t.time}</TableHead>
                        <TableHead>{t.eventCol}</TableHead>
                        <TableHead>{t.severityCol}</TableHead>
                        <TableHead>{t.userCol}</TableHead>
                        <TableHead>{t.ip}</TableHead>
                        <TableHead>{t.status}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {events.map((event) => (
                        <TableRow key={event.id}>
                          <TableCell className="text-xs whitespace-nowrap">
                            <div className="flex items-center gap-2">
                              <Calendar className="h-4 w-4 text-[var(--color-muted-foreground)]" aria-hidden="true" />
                              {formatTimestamp(event.timestamp)}
                            </div>
                          </TableCell>
                          <TableCell>
                            <code className="text-xs bg-[var(--color-muted)] px-2 py-1 rounded" dir="ltr">
                              {event.event_type}
                            </code>
                          </TableCell>
                          <TableCell>
                            <Badge variant={getSeverityColor(event.severity)}>
                              {t.severities[event.severity.toLowerCase()] ?? event.severity}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs" data-user-id={event.user_id ?? undefined}>
                            {event.user_id && isSystemUserId(event.user_id) ? (
                              <span>{actorLabel(event.user_id, lang)}</span>
                            ) : event.user_id ? (
                              // A person by name; an id only when the account no longer exists
                              <bdi className={names[event.user_id] ? undefined : "font-mono"}>{names[event.user_id] ?? event.user_id}</bdi>
                            ) : (
                              <span className="text-[var(--color-muted-foreground)]">—</span>
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {event.ip_address ? <bdi>{event.ip_address}</bdi> : (
                              <span className="text-[var(--color-muted-foreground)]">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant={event.success ? "secondary" : "destructive"}>
                              {event.success ? t.success : t.failed}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {/* Pagination */}
                {pagination.pages > 1 && (
                  <div className="flex flex-wrap items-center justify-between gap-3 mt-6 pt-6 border-t border-[var(--color-border)]">
                    <div className="text-sm text-[var(--color-muted-foreground)]">
                      {t.page(pagination.page, pagination.pages, !!pagination.capped)} {t.totalEvents(pagination.total, !!pagination.capped)}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => goToPage(pagination.page - 1)}
                        disabled={pagination.page === 1}
                      >
                        {pagesCopy(lang).common.previous}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => goToPage(pagination.page + 1)}
                        disabled={pagination.page === pagination.pages}
                      >
                        {pagesCopy(lang).common.next}
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
    </AdminLayout>
  );
}
