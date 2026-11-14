import type { MetaFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData } from "react-router";
import { Flag } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { AdminLayout } from "../components/admin-layout";
import { requireAuth, getAuthenticatedUser } from "../lib/auth.server";
import { getAuthServerUrl } from "../lib/config";
import { listModerationRequests, isErrorResponse, type ModerationQueue } from "../lib/admin-api.server";
import {
  MODERATION_ACTION_LABELS,
  MODERATION_STATUS_CLASSES,
  MODERATION_STATUS_LABELS,
  REASON_CATEGORY_LABELS,
  formatWhen,
  label,
} from "../lib/moderation";

export const meta: MetaFunction = () => [
  { title: "Moderation requests - Al Ummah Now Admin" },
  { name: "description", content: "Requests from client apps to act on user accounts" },
];

type Filters = { status: string; client_id: string; action: string; from: string; to: string; needs_attention: string };

type LoaderData = {
  queue: ModerationQueue | null;
  error?: string;
  filters: Filters;
  page: number;
  user: { id: string; email: string };
  authServerUrl: string;
};

const PAGE_SIZE = 25;

export async function loader({ request, context }: LoaderFunctionArgs): Promise<LoaderData> {
  const env = context?.cloudflare?.env as {
    AUTH_STORAGE: KVNamespace;
    AUTH_SERVER_URL?: string;
    ADMIN_CLIENT_ID?: string;
    ADMIN_CLIENT_SECRET?: string;
  };
  await requireAuth(request, env, true);
  const session = await getAuthenticatedUser(request, env);
  if (!session) throw new Response("Unauthorized", { status: 401 });
  const user = session.user;
  const actingUser = { id: user.id, email: user.email, roles: user.roles || [] };

  const url = new URL(request.url);
  // Open requests first: the default view is what needs a decision
  const filters: Filters = {
    status: url.searchParams.get("status") ?? "pending",
    client_id: url.searchParams.get("client_id") ?? "",
    action: url.searchParams.get("action") ?? "",
    from: url.searchParams.get("from") ?? "",
    to: url.searchParams.get("to") ?? "",
    needs_attention: url.searchParams.get("needs_attention") === "1" ? "1" : "",
  };
  const page = Math.max(parseInt(url.searchParams.get("page") || "1", 10) || 1, 1);
  const result = await listModerationRequests(env, actingUser, {
    ...filters,
    // "Needs attention" = approved requests whose action failed after its retries
    status: filters.needs_attention ? "approved" : filters.status === "all" ? "" : filters.status,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const base = { filters, page, user: { id: user.id, email: user.email }, authServerUrl: getAuthServerUrl(request, env) };
  if (isErrorResponse(result)) return { ...base, queue: null, error: result.error };
  return { ...base, queue: result };
}

const selectClass =
  "flex h-9 w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ring)]";

export default function ModerationRequestsPage() {
  const { queue, error, filters, page, user, authServerUrl } = useLoaderData<LoaderData>();
  const pages = queue ? Math.max(Math.ceil(queue.total / PAGE_SIZE), 1) : 1;
  const pageHref = (p: number) => {
    const q = new URLSearchParams({ ...filters, page: String(p) });
    return `/moderation?${q.toString()}`;
  };

  return (
    <AdminLayout user={user} authServerUrl={authServerUrl}>
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-[var(--color-foreground)] mb-2">Moderation requests</h2>
        <p className="text-[var(--color-muted-foreground)]">
          Client apps ask; auth admins decide. Approving runs the action on the auth account.
        </p>
      </div>

      {error && (
        <div role="alert" className="mb-6 p-4 ui-alert-error rounded-lg">
          Could not load moderation requests: {error}
        </div>
      )}

      {!!queue?.needs_attention && !filters.needs_attention && (
        <div role="alert" data-testid="moderation-needs-attention" className="mb-6 p-4 ui-alert-error rounded-lg flex flex-wrap items-center justify-between gap-2">
          <span>
            {queue.needs_attention === 1 ? "1 approved action failed" : `${queue.needs_attention} approved actions failed`} after every retry and need an admin.
          </span>
          <Link to="/moderation?needs_attention=1" className="underline font-medium">Show them</Link>
        </div>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <Form method="get" className="grid gap-4 md:grid-cols-7 items-end" data-testid="moderation-filters">
            <div className="space-y-1">
              <Label htmlFor="status">Status</Label>
              <select id="status" name="status" defaultValue={filters.status} className={selectClass}>
                <option value="all">All</option>
                {Object.entries(MODERATION_STATUS_LABELS).map(([value, text]) => (
                  <option key={value} value={value}>{text}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="client_id">Client app</Label>
              <select id="client_id" name="client_id" defaultValue={filters.client_id} className={selectClass}>
                <option value="">All</option>
                {(queue?.clients ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="action">Requested action</Label>
              <select id="action" name="action" defaultValue={filters.action} className={selectClass}>
                <option value="">All</option>
                {Object.entries(MODERATION_ACTION_LABELS).map(([value, text]) => (
                  <option key={value} value={value}>{text}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="needs_attention">Needs attention</Label>
              <select id="needs_attention" name="needs_attention" defaultValue={filters.needs_attention} className={selectClass}>
                <option value="">Any</option>
                <option value="1">Failed actions only</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="from">From</Label>
              <Input id="from" name="from" type="date" defaultValue={filters.from} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="to">To</Label>
              <Input id="to" name="to" type="date" defaultValue={filters.to} />
            </div>
            <Button type="submit">Apply</Button>
          </Form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2"><Flag className="h-5 w-5" /> Queue</CardTitle>
            <CardDescription>
              {queue ? `${queue.total} matching · ${queue.open} open (pending or waiting for info)` : "—"}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {queue && queue.requests.length === 0 ? (
            <p className="py-8 text-center text-[var(--color-muted-foreground)]" data-testid="moderation-empty">
              No moderation requests match these filters.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Received</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(queue?.requests ?? []).map((r) => (
                    <TableRow key={r.id} data-testid="moderation-row" data-request-id={r.id}>
                      <TableCell className="whitespace-nowrap">
                        <Link to={`/moderation/${r.id}`} className="underline underline-offset-2">{formatWhen(r.created_at)}</Link>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{r.subject?.email ?? r.subject_user_id}</div>
                        <div className="text-xs text-[var(--color-muted-foreground)]">{r.subject_user_id}</div>
                      </TableCell>
                      <TableCell>{label(MODERATION_ACTION_LABELS, r.action)}</TableCell>
                      <TableCell>
                        <div>{label(REASON_CATEGORY_LABELS, r.reason_category)}</div>
                        <div className="text-xs text-[var(--color-muted-foreground)] line-clamp-1 max-w-xs">{r.reason}</div>
                      </TableCell>
                      <TableCell>
                        <div>{r.client_name ?? r.client_id}</div>
                        <div className="text-xs text-[var(--color-muted-foreground)]">{r.requested_by.display_name}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={MODERATION_STATUS_CLASSES[r.status]}>{label(MODERATION_STATUS_LABELS, r.status)}</Badge>
                        {r.execution?.needs_attention && (
                          <Badge variant="destructive" className="ms-1" data-testid="moderation-row-failed">Action failed</Badge>
                        )}
                        {(r.execution?.status === "queued" || r.execution?.status === "retrying") && r.status === "approved" && (
                          <span className="ms-1 text-xs text-[var(--color-muted-foreground)]">{r.execution.status}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {pages > 1 && (
            <div className="mt-4 flex items-center justify-end gap-2 text-sm">
              {page > 1 && <Link to={pageHref(page - 1)} className="underline">Previous</Link>}
              <span>Page {page} of {pages}</span>
              {page < pages && <Link to={pageHref(page + 1)} className="underline">Next</Link>}
            </div>
          )}
        </CardContent>
      </Card>
    </AdminLayout>
  );
}
