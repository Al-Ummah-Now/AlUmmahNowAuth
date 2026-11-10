import type { MetaFunction, LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useEffect } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import { AdminLayout } from "../components/admin-layout";
import { requireAuth, getAuthenticatedUser } from "../lib/auth.server";
import { getAuthServerUrl } from "../lib/config";
import {
  decideModerationRequest,
  getModerationRequest,
  isErrorResponse,
  type ModerationDecision,
  type ModerationRequestDetail,
} from "../lib/admin-api.server";
import {
  MODERATION_ACTION_LABELS,
  MODERATION_STATUS_CLASSES,
  MODERATION_STATUS_LABELS,
  REASON_CATEGORY_LABELS,
  formatWhen,
  label,
  userPageHref,
} from "../lib/moderation";

export const meta: MetaFunction = () => [{ title: "Moderation request - Al Ummah Now Admin" }];

type Env = { AUTH_STORAGE: KVNamespace; AUTH_SERVER_URL?: string; ADMIN_CLIENT_ID?: string; ADMIN_CLIENT_SECRET?: string };

type LoaderData = {
  detail: ModerationRequestDetail | null;
  error?: string;
  user: { id: string; email: string };
  authServerUrl: string;
};

async function actingUserFrom(request: Request, env: Env) {
  await requireAuth(request, env, true);
  const session = await getAuthenticatedUser(request, env);
  if (!session) throw new Response("Unauthorized", { status: 401 });
  return session.user;
}

export async function loader({ request, context, params }: LoaderFunctionArgs): Promise<LoaderData> {
  const env = context?.cloudflare?.env as Env;
  const user = await actingUserFrom(request, env);
  const result = await getModerationRequest(env, { id: user.id, email: user.email, roles: user.roles || [] }, params.id!);
  const base = { user: { id: user.id, email: user.email }, authServerUrl: getAuthServerUrl(request, env) };
  if (isErrorResponse(result)) return { ...base, detail: null, error: result.error };
  return { ...base, detail: result };
}

const DECISIONS: ModerationDecision[] = ["approve", "reject", "request-info", "execute", "mark-actioned"];

export async function action({ request, context, params }: ActionFunctionArgs) {
  const env = context?.cloudflare?.env as Env;
  const user = await actingUserFrom(request, env);
  const form = await request.formData();
  const decision = String(form.get("_action") || "") as ModerationDecision;
  if (!DECISIONS.includes(decision)) return { ok: false, error: "Unknown action" };
  const note = String(form.get("note") || "").trim();
  if ((decision === "reject" || decision === "request-info") && !note) {
    return { ok: false, error: "Write a note for the requesting app." };
  }
  const result = await decideModerationRequest(env, { id: user.id, email: user.email, roles: user.roles || [] }, params.id!, decision, note || undefined);
  if (isErrorResponse(result)) return { ok: false, error: result.error };
  return { ok: true, status: result.request.status };
}

const CONFIRM: Partial<Record<ModerationDecision, string>> = {
  approve: "Approve this request? Its action is queued and runs on the auth account within seconds.",
  execute: "Queue the action on the auth account again?",
};

export default function ModerationRequestPage() {
  const { detail, error, user, authServerUrl } = useLoaderData<LoaderData>();
  const fetcher = useFetcher<{ ok: boolean; error?: string; status?: string }>();
  const busy = fetcher.state !== "idle";
  const revalidator = useRevalidator();
  const running = detail?.request.status === "approved" && (detail.request.execution?.status === "queued" || detail.request.execution?.status === "retrying");
  // While the action is queued, refresh every 5 s until it is done or flagged
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, 5000);
    return () => clearInterval(timer);
  }, [running, revalidator]);

  if (!detail) {
    return (
      <AdminLayout user={user} authServerUrl={authServerUrl}>
        <Link to="/moderation" className="inline-flex items-center gap-1 text-sm underline mb-4"><ArrowLeft className="h-4 w-4" /> Moderation requests</Link>
        <div role="alert" className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-500">Could not load this request: {error}</div>
      </AdminLayout>
    );
  }

  const { request: r, subject, prior_requests } = detail;
  const open = r.status === "pending" || r.status === "info_requested";
  const automatic = r.action !== "other";
  const failed = r.status === "approved" && !!r.execution?.needs_attention;
  const canExecute = failed && automatic;
  const canMarkActioned = r.status === "approved" && (!automatic || failed);

  const submit = (decision: ModerationDecision) => (event: React.MouseEvent<HTMLButtonElement>) => {
    const message = CONFIRM[decision];
    if (message && !window.confirm(message)) {
      event.preventDefault();
      return;
    }
  };

  return (
    <AdminLayout user={user} authServerUrl={authServerUrl}>
      <Link to="/moderation" className="inline-flex items-center gap-1 text-sm underline mb-4"><ArrowLeft className="h-4 w-4" /> Moderation requests</Link>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h2 className="text-2xl font-bold text-[rgb(var(--color-foreground))]">{label(MODERATION_ACTION_LABELS, r.action)}</h2>
        <Badge variant="outline" data-testid="moderation-status" className={MODERATION_STATUS_CLASSES[r.status]}>
          {label(MODERATION_STATUS_LABELS, r.status)}
        </Badge>
        <span className="text-sm text-[rgb(var(--color-muted-foreground))]">{r.id}</span>
      </div>

      {fetcher.data?.error && (
        <div role="alert" className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-500">{fetcher.data.error}</div>
      )}
      {failed && (
        <div role="alert" data-testid="moderation-action-failed" className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-600">
          <div className="font-medium">Needs attention: the action failed after {r.execution.attempts} attempt{r.execution.attempts === 1 ? "" : "s"}.</div>
          {r.action_error && <div className="text-sm mt-1">{r.action_error}</div>}
          <div className="text-sm mt-1">Run it again, close it as done by hand, or reject the request.</div>
        </div>
      )}
      {running && (
        <div role="status" data-testid="moderation-action-running" className="mb-4 p-3 bg-sky-500/10 border border-sky-500/20 rounded-lg text-sky-700">
          The action is {r.execution.status === "retrying" ? `being retried (attempt ${r.execution.attempts + 1})` : "queued"} and will run shortly.
          {r.execution.status === "retrying" && r.action_error && <div className="text-sm mt-1">Last error: {r.action_error}</div>}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Request</CardTitle>
              <CardDescription>
                From {r.client_name ?? r.client_id} · by {r.requested_by.display_name} ({r.requested_by.id}) · {formatWhen(r.created_at)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="text-xs uppercase tracking-wide text-[rgb(var(--color-muted-foreground))]">Reason</div>
                <div className="font-medium">{label(REASON_CATEGORY_LABELS, r.reason_category)}</div>
                <p className="whitespace-pre-wrap mt-1" data-testid="moderation-reason">{r.reason}</p>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-[rgb(var(--color-muted-foreground))]">Evidence</div>
                {r.evidence.length === 0 ? (
                  <p className="text-sm text-[rgb(var(--color-muted-foreground))]">None attached.</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {r.evidence.map((e, i) => (
                      <li key={`${e.url}-${i}`}>
                        <a href={e.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline break-all">
                          {e.label || e.url} <ExternalLink className="h-3 w-3" />
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {r.decision_note && (
                <div>
                  <div className="text-xs uppercase tracking-wide text-[rgb(var(--color-muted-foreground))]">Decision note (shown to the app)</div>
                  <p className="whitespace-pre-wrap">{r.decision_note}</p>
                </div>
              )}
            </CardContent>
          </Card>

          {(open || r.status === "approved") && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Decide</CardTitle>
                <CardDescription>
                  {automatic
                    ? "Approve queues the action; it runs with the same account code as the Users and Sessions pages and is retried on failure."
                    : "\"Other\" has no automatic action: approve, handle it, then mark it actioned."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <fetcher.Form method="post" className="space-y-3" data-testid="moderation-decide">
                  <div className="space-y-1">
                    <Label htmlFor="note">Note for the requesting app (required to reject or ask for more information)</Label>
                    <textarea
                      id="note"
                      name="note"
                      rows={3}
                      maxLength={4000}
                      className="w-full rounded-md border border-[rgb(var(--color-border))] bg-transparent px-3 py-2 text-sm"
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {open && (
                      <>
                        <Button type="submit" name="_action" value="approve" disabled={busy} onClick={submit("approve")}>
                          {automatic ? "Approve and run" : "Approve"}
                        </Button>
                        <Button type="submit" name="_action" value="reject" variant="destructive" disabled={busy}>Reject</Button>
                        {r.status === "pending" && (
                          <Button type="submit" name="_action" value="request-info" variant="outline" disabled={busy}>Request more info</Button>
                        )}
                      </>
                    )}
                    {canExecute && (
                      <Button type="submit" name="_action" value="execute" disabled={busy} onClick={submit("execute")} data-testid="moderation-run-again">Run action again</Button>
                    )}
                    {canMarkActioned && (
                      <Button type="submit" name="_action" value="mark-actioned" variant="outline" disabled={busy}>Mark actioned</Button>
                    )}
                    {r.status === "approved" && (
                      <Button type="submit" name="_action" value="reject" variant="destructive" disabled={busy}>Reject</Button>
                    )}
                  </div>
                </fetcher.Form>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">History</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3" data-testid="moderation-history">
                {r.history.map((h) => (
                  <li key={h.id} className="border-l-2 border-[rgb(var(--color-border))] pl-3">
                    <div className="text-sm font-medium">{h.type.replace(/_/g, " ")}</div>
                    <div className="text-xs text-[rgb(var(--color-muted-foreground))]">
                      {h.actor_type === "admin" ? `Auth admin ${h.actor_name ?? h.actor_id}` : h.actor_type === "client" ? `${h.actor_name ?? "Client"} (${r.client_name ?? r.client_id})` : "System"} · {formatWhen(h.at)}
                    </div>
                    {h.note && <p className="text-sm whitespace-pre-wrap mt-1">{h.note}</p>}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">User</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {subject ? (
                <>
                  <div className="font-medium" data-testid="moderation-subject-email">{subject.email}</div>
                  {subject.name && <div>{subject.name}</div>}
                  <div className="text-[rgb(var(--color-muted-foreground))]">{subject.id}</div>
                  <div>Status: <span className="font-medium">{subject.status}</span></div>
                  {subject.password_reset_required && <div>Password reset required</div>}
                  <div>Joined {formatWhen(subject.created_at)}</div>
                  <Link to={userPageHref(subject)} className="inline-block mt-2 underline">Open in Users</Link>
                </>
              ) : (
                <p>No auth user with id {r.subject_user_id} (deleted?).</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Earlier requests for this user</CardTitle>
            </CardHeader>
            <CardContent>
              {prior_requests.length === 0 ? (
                <p className="text-sm text-[rgb(var(--color-muted-foreground))]">None.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {prior_requests.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-2">
                      <Link to={`/moderation/${p.id}`} className="underline">{label(MODERATION_ACTION_LABELS, p.action)}</Link>
                      <span className="text-xs text-[rgb(var(--color-muted-foreground))]">{formatWhen(p.created_at)}</span>
                      <Badge variant="outline" className={MODERATION_STATUS_CLASSES[p.status]}>{label(MODERATION_STATUS_LABELS, p.status)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AdminLayout>
  );
}
