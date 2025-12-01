import { useState } from "react";
import type { MetaFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useSearchParams, useNavigate } from "react-router";
import { ArrowLeft, FileText, Calendar, Filter, X, LogOut, Search } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { requireAuth } from "../lib/auth.server";
import { logger } from "../lib/logger.server";

export const meta: MetaFunction = () => {
  return [
    { title: "Audit Logs - Al Ummah Now Admin" },
    { name: "description", content: "View system audit logs and security events" },
  ];
};

interface AuditEvent {
  id: number;
  timestamp: string;
  event_type: string;
  severity: string;
  user_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
  metadata: string;
  success: number;
  error_message: string | null;
  created_at: string;
}

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
  };
  filters: {
    event_type?: string;
    severity?: string;
    search?: string;
    start_date?: string;
    end_date?: string;
  };
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as {
    AUTH_DB: D1Database;
    AUTH_STORAGE: KVNamespace;
    AUTH_SERVER_URL?: string;
  };
  const ctx = context?.cloudflare?.ctx as ExecutionContext;

  // Initialize logger
  if (env?.AUTH_DB) {
    logger.setDatabase(env.AUTH_DB, true);
    if (ctx) logger.setContext(ctx);
  }

  // Always require admin authentication
  try {
    await requireAuth(request, env, true);
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

    // Get AUTH_SERVER_URL
    const authServerUrl = env?.AUTH_SERVER_URL || `https://${url.host}`;

    // Build query params for the API call
    const apiUrl = new URL(`${authServerUrl}/admin/audit-logs`);
    apiUrl.searchParams.set("page", page.toString());
    apiUrl.searchParams.set("limit", limit.toString());
    if (event_type) apiUrl.searchParams.set("event_type", event_type);
    if (severity) apiUrl.searchParams.set("severity", severity);
    if (search) {
      // Search across user_id, client_id, ip_address
      apiUrl.searchParams.set("user_id", search);
    }
    if (start_date) apiUrl.searchParams.set("start_date", start_date);
    if (end_date) apiUrl.searchParams.set("end_date", end_date);

    // Get session cookie for auth
    const cookieHeader = request.headers.get("Cookie");

    // Call the auth server API
    const response = await fetch(apiUrl.toString(), {
      headers: {
        Cookie: cookieHeader || "",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch audit logs: ${response.statusText}`);
    }

    const data = await response.json() as {
      data?: AuditEvent[];
      pagination?: { page: number; limit: number; total: number; pages: number };
    };

    // Parse metadata JSON strings
    const events = (data.data || []).map((event: AuditEvent) => ({
      ...event,
      success: event.success === 1,
      metadata: typeof event.metadata === "string"
        ? JSON.parse(event.metadata || "{}")
        : event.metadata || {},
    }));

    return {
      events,
      pagination: data.pagination || { page: 1, limit: 50, total: 0, pages: 0 },
      filters: { event_type, severity, search, start_date, end_date },
    };
  } catch (error) {
    logger.error("Error loading audit logs", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      events: [],
      pagination: { page: 1, limit: 50, total: 0, pages: 0 },
      filters: {},
    };
  }
}

export default function AuditLogs() {
  const { events, pagination, filters } = useLoaderData<LoaderData>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [showFilters, setShowFilters] = useState(false);

  // Local state for filter form
  const [eventTypeFilter, setEventTypeFilter] = useState(filters.event_type || "");
  const [severityFilter, setSeverityFilter] = useState(filters.severity || "");
  const [searchQuery, setSearchQuery] = useState(filters.search || "");
  const [startDate, setStartDate] = useState(filters.start_date || "");
  const [endDate, setEndDate] = useState(filters.end_date || "");

  const applyFilters = () => {
    const params = new URLSearchParams();
    if (eventTypeFilter) params.set("event_type", eventTypeFilter);
    if (severityFilter) params.set("severity", severityFilter);
    if (searchQuery) params.set("search", searchQuery);
    if (startDate) params.set("start_date", startDate);
    if (endDate) params.set("end_date", endDate);
    params.set("page", "1"); // Reset to first page when filters change
    navigate(`/audit?${params.toString()}`);
  };

  const clearFilters = () => {
    setEventTypeFilter("");
    setSeverityFilter("");
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

  const hasActiveFilters = eventTypeFilter || severityFilter || searchQuery || startDate || endDate;

  return (
    <div className="min-h-screen bg-[rgb(var(--color-background))]">
      {/* Navigation */}
      <nav className="border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-card))]">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" asChild>
                <Link to="/">
                  <ArrowLeft className="h-5 w-5" />
                </Link>
              </Button>
              <Link to="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
                <img
                  src="https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png"
                  alt="Al Ummah Now"
                  className="h-10 w-10 rounded-lg"
                />
                <div>
                  <h1 className="text-xl font-bold text-[rgb(var(--color-foreground))]">Audit Logs</h1>
                  <p className="text-sm text-[rgb(var(--color-muted-foreground))]">Al Ummah Now Admin</p>
                </div>
              </Link>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" asChild>
                <Link to="/logout">
                  <LogOut className="h-5 w-5" />
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
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
              <div className="mb-6 p-4 border border-[rgb(var(--color-border))] rounded-lg bg-[rgb(var(--color-muted))]/20">
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  <div className="grid gap-2">
                    <Label htmlFor="event_type">Event Type</Label>
                    <Input
                      id="event_type"
                      placeholder="e.g., auth.login.success"
                      value={eventTypeFilter}
                      onChange={(e) => setEventTypeFilter(e.target.value)}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="severity">Severity</Label>
                    <Select value={severityFilter} onValueChange={setSeverityFilter}>
                      <SelectTrigger id="severity">
                        <SelectValue placeholder="All severities" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">All severities</SelectItem>
                        <SelectItem value="debug">Debug</SelectItem>
                        <SelectItem value="info">Info</SelectItem>
                        <SelectItem value="warning">Warning</SelectItem>
                        <SelectItem value="error">Error</SelectItem>
                        <SelectItem value="critical">Critical</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="search">Search</Label>
                    <Input
                      id="search"
                      placeholder="User ID, Client ID, or IP"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>

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
                <span className="text-sm text-[rgb(var(--color-muted-foreground))]">Active filters:</span>
                {eventTypeFilter && (
                  <Badge variant="outline">
                    Event: {eventTypeFilter}
                  </Badge>
                )}
                {severityFilter && (
                  <Badge variant="outline">
                    Severity: {severityFilter}
                  </Badge>
                )}
                {searchQuery && (
                  <Badge variant="outline">
                    Search: {searchQuery}
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
                <FileText className="h-12 w-12 text-[rgb(var(--color-muted-foreground))] mb-4" />
                <h3 className="text-lg font-semibold mb-2">No audit events found</h3>
                <p className="text-sm text-[rgb(var(--color-muted-foreground))] mb-4">
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
                  <Table>
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
                              <Calendar className="h-4 w-4 text-[rgb(var(--color-muted-foreground))]" />
                              {formatTimestamp(event.timestamp)}
                            </div>
                          </TableCell>
                          <TableCell>
                            <code className="text-xs bg-[rgb(var(--color-muted))] px-2 py-1 rounded">
                              {event.event_type}
                            </code>
                          </TableCell>
                          <TableCell>
                            <Badge variant={getSeverityColor(event.severity)}>
                              {event.severity}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {event.user_id || (
                              <span className="text-[rgb(var(--color-muted-foreground))]">-</span>
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {event.ip_address || (
                              <span className="text-[rgb(var(--color-muted-foreground))]">-</span>
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
                  <div className="flex items-center justify-between mt-6 pt-6 border-t border-[rgb(var(--color-border))]">
                    <div className="text-sm text-[rgb(var(--color-muted-foreground))]">
                      Page {pagination.page} of {pagination.pages} ({pagination.total} total events)
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
      </main>
    </div>
  );
}
