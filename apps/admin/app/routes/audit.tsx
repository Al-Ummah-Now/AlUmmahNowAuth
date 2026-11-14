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
import { langOf } from "../lib/deletion-copy";
import {
  getAuditLogs,
  isErrorResponse,
  type ActingUser,
} from "../lib/admin-api.server";

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
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as {
    AUTH_STORAGE: KVNamespace;
    AUTH_SERVER_URL?: string;
    ADMIN_CLIENT_ID?: string;
    ADMIN_CLIENT_SECRET?: string;
  };
  const ctx = context?.cloudflare?.ctx as ExecutionContext;

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
  const { events, pagination, filters, user, authServerUrl } = useLoaderData<LoaderData>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [showFilters, setShowFilters] = useState(false);

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
    return new Date(timestamp).toLocaleString();
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
    <AdminLayout user={user} authServerUrl={authServerUrl}>
      <div className="mb-6">
        <h2 className="text-3xl font-bold text-[var(--color-foreground)] mb-2">Audit Logs</h2>
        <p className="text-[var(--color-muted-foreground)]">
          View system audit logs and security events
        </p>
      </div>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Audit Events</CardTitle>
                <CardDescription>
                  View and filter system audit logs and security events
                </CardDescription>
              </div>
              <Button
                variant={showFilters ? "default" : "outline"}
                onClick={() => setShowFilters(!showFilters)}
              >
                <Filter className="h-4 w-4 mr-2" />
                {showFilters ? "Hide Filters" : "Show Filters"}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {/* Filters Section */}
            {showFilters && (
              <div className="mb-6 p-4 border border-[var(--color-border)] rounded-lg bg-[var(--color-muted)]/20">
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  <div className="grid gap-2">
                    <Label htmlFor="event_type">Event Type</Label>
                    <Input
                      id="event_type"
                      placeholder="e.g., auth.login.success"
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
                    <Label htmlFor="severity">Severity</Label>
                    <Select value={severityFilter} onValueChange={setSeverityFilter}>
                      <SelectTrigger id="severity">
                        <SelectValue placeholder="All severities" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All severities</SelectItem>
                        <SelectItem value="debug">Debug</SelectItem>
                        <SelectItem value="info">Info</SelectItem>
                        <SelectItem value="warning">Warning</SelectItem>
                        <SelectItem value="error">Error</SelectItem>
                        <SelectItem value="critical">Critical</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* The loader filters this by user_id: a user picker, by name or email */}
                  <UserAutocomplete
                    key={filters.search ?? ""}
                    mode="pick"
                    label="User"
                    defaultValue={filters.search ?? ""}
                    onChange={(id) => setSearchQuery(id)}
                    testId="audit-user"
                  />

                  <div className="grid gap-2">
                    <Label htmlFor="start_date">Start Date</Label>
                    <Input
                      id="start_date"
                      type="datetime-local"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="end_date">End Date</Label>
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
                    <Search className="h-4 w-4 mr-2" />
                    Apply Filters
                  </Button>
                  {hasActiveFilters && (
                    <Button variant="outline" onClick={clearFilters}>
                      <X className="h-4 w-4 mr-2" />
                      Clear Filters
                    </Button>
                  )}
                </div>
              </div>
            )}

            {/* Active Filters Display */}
            {hasActiveFilters && !showFilters && (
              <div className="mb-4 flex flex-wrap gap-2 items-center">
                <span className="text-sm text-[var(--color-muted-foreground)]">Active filters:</span>
                {eventTypeFilter && (
                  <Badge variant="outline">
                    Event: {eventTypeFilter}
                  </Badge>
                )}
                {severityFilter && severityFilter !== "all" && (
                  <Badge variant="outline">
                    Severity: {severityFilter}
                  </Badge>
                )}
                {searchQuery && (
                  <Badge variant="outline">
                    User: {searchQuery}
                  </Badge>
                )}
                {startDate && (
                  <Badge variant="outline">
                    From: {new Date(startDate).toLocaleDateString()}
                  </Badge>
                )}
                {endDate && (
                  <Badge variant="outline">
                    To: {new Date(endDate).toLocaleDateString()}
                  </Badge>
                )}
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  <X className="h-3 w-3" />
                </Button>
              </div>
            )}

            {/* Events Table */}
            {events.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <FileText className="h-12 w-12 text-[var(--color-muted-foreground)] mb-4" />
                <h3 className="text-lg font-semibold mb-2">No audit events found</h3>
                <p className="text-sm text-[var(--color-muted-foreground)] mb-4">
                  {hasActiveFilters
                    ? "Try adjusting your filters to see more results."
                    : "Audit events will appear here as they occur."}
                </p>
                {hasActiveFilters && (
                  <Button variant="outline" onClick={clearFilters}>
                    Clear Filters
                  </Button>
                )}
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <Table aria-label="Audit events">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Timestamp</TableHead>
                        <TableHead>Event Type</TableHead>
                        <TableHead>Severity</TableHead>
                        <TableHead>User ID</TableHead>
                        <TableHead>IP Address</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {events.map((event) => (
                        <TableRow key={event.id}>
                          <TableCell className="font-mono text-xs">
                            <div className="flex items-center gap-2">
                              <Calendar className="h-4 w-4 text-[var(--color-muted-foreground)]" />
                              {formatTimestamp(event.timestamp)}
                            </div>
                          </TableCell>
                          <TableCell>
                            <code className="text-xs bg-[var(--color-muted)] px-2 py-1 rounded">
                              {event.event_type}
                            </code>
                          </TableCell>
                          <TableCell>
                            <Badge variant={getSeverityColor(event.severity)}>
                              {event.severity}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {event.user_id && isSystemUserId(event.user_id) ? (
                              <span title={event.user_id}>{actorLabel(event.user_id, langOf(searchParams))}</span>
                            ) : (
                              event.user_id || <span className="text-[var(--color-muted-foreground)]">-</span>
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {event.ip_address || (
                              <span className="text-[var(--color-muted-foreground)]">-</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant={event.success ? "secondary" : "destructive"}>
                              {event.success ? "Success" : "Failed"}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {/* Pagination */}
                {pagination.pages > 1 && (
                  <div className="flex items-center justify-between mt-6 pt-6 border-t border-[var(--color-border)]">
                    <div className="text-sm text-[var(--color-muted-foreground)]">
                      Page {pagination.page} of {pagination.pages}{pagination.capped ? "+" : ""} ({pagination.total}{pagination.capped ? "+" : ""} total events)
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => goToPage(pagination.page - 1)}
                        disabled={pagination.page === 1}
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => goToPage(pagination.page + 1)}
                        disabled={pagination.page === pagination.pages}
                      >
                        Next
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
