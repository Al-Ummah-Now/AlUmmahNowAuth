import type { MetaFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useSearchParams } from "react-router";
import { adminCopy, pageTitle } from "../lib/admin-copy";
import { toAsciiDigits } from "../../../../packages/ui/src/format.ts";
import { langOf } from "../lib/deletion-copy";
import { withLang } from "../lib/shell-copy";
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
import { MODERATION_STATUS_CLASSES, formatWhen, label } from "../lib/moderation";
import { getCloudflare } from "../lib/cloudflare-context";

export const meta: MetaFunction = ({ location }) => {
  const lang = langOf(location.search);
  return [
    { title: pageTitle("moderation", lang) },
    { name: "description", content: adminCopy(lang).moderation.intro },
  ];
};

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
  const env = getCloudflare(context).env as {
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
    // Arabic pages type dates as text and may use ٠–٩
    from: toAsciiDigits(url.searchParams.get("from") ?? ""),
    to: toAsciiDigits(url.searchParams.get("to") ?? ""),
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
  const [searchParams] = useSearchParams();
  const lang = langOf(searchParams);
  const t = adminCopy(lang).moderation;
  const L = adminCopy(lang).moderationLabels;
  const c = adminCopy(lang).common;
  // The browser's date field writes its own "mm/dd/yyyy" in the browser's language: Arabic pages
  // use a text field with an Arabic hint instead (YYYY-MM-DD, ٠–٩ accepted)
  const dateInput = lang === "ar"
    ? { type: "text", inputMode: "numeric" as const, dir: "ltr", className: "text-right", placeholder: t.datePlaceholder, pattern: "[0-9٠-٩]{4}-[0-9٠-٩]{2}-[0-9٠-٩]{2}" }
    : { type: "date" };
  const pages = queue ? Math.max(Math.ceil(queue.total / PAGE_SIZE), 1) : 1;
  const pageHref = (p: number) => {
    const q = new URLSearchParams({ ...filters, page: String(p) });
    return withLang(`/moderation?${q.toString()}`, lang);
  };

  return (
    <AdminLayout user={user} authServerUrl={authServerUrl}>
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-[var(--color-foreground)] mb-2">{t.title}</h2>
        <p className="text-[var(--color-muted-foreground)]">{t.intro}</p>
      </div>

      {error && (
        <div role="alert" className="mb-6 p-4 ui-alert-error rounded-lg">
          {t.loadError(error)}
        </div>
      )}

      {!!queue?.needs_attention && !filters.needs_attention && (
        <div role="alert" data-testid="moderation-needs-attention" className="mb-6 p-4 ui-alert-error rounded-lg flex flex-wrap items-center justify-between gap-2">
          <span>{t.needsAttention(queue.needs_attention)}</span>
          <Link to={withLang("/moderation?needs_attention=1", lang)} className="underline font-medium">{t.showThem}</Link>
        </div>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">{t.filters}</CardTitle>
        </CardHeader>
        <CardContent>
          <Form method="get" className="grid gap-4 md:grid-cols-7 items-end" data-testid="moderation-filters">
            {/* The page language stays on (?lang=ar) */}
            {lang === "ar" && <input type="hidden" name="lang" value="ar" />}
            <div className="space-y-1">
              <Label htmlFor="status">{t.status}</Label>
              <select id="status" name="status" defaultValue={filters.status} className={selectClass}>
                <option value="all">{c.all}</option>
                {Object.entries(L.status).map(([value, text]) => (
                  <option key={value} value={value}>{text}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="client_id">{t.clientApp}</Label>
              <select id="client_id" name="client_id" defaultValue={filters.client_id} className={selectClass}>
                <option value="">{c.all}</option>
                {(queue?.clients ?? []).map((c) => (
                  <option key={c.id} value={c.id} dir="auto">{c.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="action">{t.requestedAction}</Label>
              <select id="action" name="action" defaultValue={filters.action} className={selectClass}>
                <option value="">{c.all}</option>
                {Object.entries(L.action).map(([value, text]) => (
                  <option key={value} value={value}>{text}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="needs_attention">{t.needsAttentionLabel}</Label>
              <select id="needs_attention" name="needs_attention" defaultValue={filters.needs_attention} className={selectClass}>
                <option value="">{t.any}</option>
                <option value="1">{t.failedOnly}</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="from">{t.from}</Label>
              <Input id="from" name="from" {...dateInput} defaultValue={filters.from} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="to">{t.to}</Label>
              <Input id="to" name="to" {...dateInput} defaultValue={filters.to} />
            </div>
            <Button type="submit">{t.apply}</Button>
          </Form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2"><Flag className="h-5 w-5" /> {t.queue}</CardTitle>
            <CardDescription>
              {queue ? t.queueSummary(queue.total, queue.open) : "—"}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {queue && queue.requests.length === 0 ? (
            <p className="py-8 text-center text-[var(--color-muted-foreground)]" data-testid="moderation-empty">
              {t.empty}
            </p>
          ) : (
            <>
            {/* Phones: one card per request (a six-column table does not fit) */}
            <ul className="space-y-3 md:hidden" data-testid="moderation-cards">
              {(queue?.requests ?? []).map((r) => (
                <li key={r.id} className="rounded-lg border border-[var(--color-border)] p-3 space-y-1 text-sm" data-request-id={r.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link to={withLang(`/moderation/${r.id}`, lang)} className="font-medium underline underline-offset-2">{label(L.action, r.action)}</Link>
                    <span className="flex flex-wrap gap-1">
                      <Badge variant="outline" className={MODERATION_STATUS_CLASSES[r.status]}>{label(L.status, r.status)}</Badge>
                      {r.execution?.needs_attention && <Badge variant="destructive">{t.actionFailedBadge}</Badge>}
                    </span>
                  </div>
                  <div><bdi>{r.subject?.name || r.subject?.email || r.subject_user_id}</bdi></div>
                  <div>{label(L.reason, r.reason_category)}{c.sep}<bdi className="text-[var(--color-muted-foreground)]">{r.reason}</bdi></div>
                  <div className="text-xs text-[var(--color-muted-foreground)]">
                    <bdi>{r.client_name ?? r.client_id}</bdi>{c.sep}<bdi>{r.requested_by.display_name}</bdi>{c.sep}{formatWhen(r.created_at, lang)}
                  </div>
                </li>
              ))}
            </ul>
            <div className="hidden md:block overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.colReceived}</TableHead>
                    <TableHead>{t.colUser}</TableHead>
                    <TableHead>{t.colAction}</TableHead>
                    <TableHead>{t.colReason}</TableHead>
                    <TableHead>{t.colFrom}</TableHead>
                    <TableHead>{t.colStatus}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(queue?.requests ?? []).map((r) => (
                    <TableRow key={r.id} data-testid="moderation-row" data-request-id={r.id}>
                      <TableCell className="whitespace-nowrap">
                        <Link to={withLang(`/moderation/${r.id}`, lang)} className="underline underline-offset-2">{formatWhen(r.created_at, lang)}</Link>
                      </TableCell>
                      <TableCell>
                        {/* The person by name, then their email; the id only when the account is gone */}
                        <div className="font-medium"><bdi>{r.subject?.name || r.subject?.email || r.subject_user_id}</bdi></div>
                        {r.subject?.name && r.subject.email && <div className="text-xs text-[var(--color-muted-foreground)]"><bdi>{r.subject.email}</bdi></div>}
                      </TableCell>
                      <TableCell>{label(L.action, r.action)}</TableCell>
                      <TableCell>
                        <div>{label(L.reason, r.reason_category)}</div>
                        <div className="text-xs text-[var(--color-muted-foreground)] line-clamp-1 max-w-xs"><bdi>{r.reason}</bdi></div>
                      </TableCell>
                      <TableCell>
                        <div><bdi>{r.client_name ?? r.client_id}</bdi></div>
                        <div className="text-xs text-[var(--color-muted-foreground)]"><bdi>{r.requested_by.display_name}</bdi></div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={MODERATION_STATUS_CLASSES[r.status]}>{label(L.status, r.status)}</Badge>
                        {r.execution?.needs_attention && (
                          <Badge variant="destructive" className="ms-1" data-testid="moderation-row-failed">{t.actionFailedBadge}</Badge>
                        )}
                        {(r.execution?.status === "queued" || r.execution?.status === "retrying") && r.status === "approved" && (
                          <span className="ms-1 text-xs text-[var(--color-muted-foreground)]">{label(L.execution, r.execution.status)}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            </>
          )}
          {pages > 1 && (
            <div className="mt-4 flex items-center justify-end gap-2 text-sm">
              {page > 1 && <Link to={pageHref(page - 1)} className="underline">{c.previous}</Link>}
              <span>{c.page(page, pages)}</span>
              {page < pages && <Link to={pageHref(page + 1)} className="underline">{c.next}</Link>}
            </div>
          )}
        </CardContent>
      </Card>
    </AdminLayout>
  );
}
