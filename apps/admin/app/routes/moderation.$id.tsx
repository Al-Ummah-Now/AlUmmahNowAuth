import type { MetaFunction, LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { Email } from "../components/email";
import { AdminTime, useAdminTime } from "../components/admin-time";
import { Link, useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import { AdminLayout } from "../components/admin-layout";
import { ConfirmDialog } from "../components/confirm-dialog";
import { confirmCopy, dirOf, langOf } from "../lib/confirm-copy";
import { requireAuth, getAuthenticatedUser } from "../lib/auth.server";
import { getAuthServerUrl } from "../lib/config";
import {
  decideModerationRequest,
  getModerationRequest,
  isErrorResponse,
  type ModerationDecision,
  type ModerationRequestDetail,
} from "../lib/admin-api.server";
import { MODERATION_STATUS_CLASSES, label, userPageHref } from "../lib/moderation";
import { adminCopy, pageTitle } from "../lib/admin-copy";
import { withLang } from "../lib/shell-copy";
import { getCloudflare } from "../lib/cloudflare-context";

export const meta: MetaFunction = ({ location }) => [{ title: pageTitle("moderationRequest", langOf(location.search)) }];

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
  const env = getCloudflare(context).env as Env;
  const user = await actingUserFrom(request, env);
  const result = await getModerationRequest(env, { id: user.id, email: user.email, roles: user.roles || [] }, params.id!);
  const base = { user: { id: user.id, email: user.email }, authServerUrl: getAuthServerUrl(request, env) };
  if (isErrorResponse(result)) return { ...base, detail: null, error: result.error };
  return { ...base, detail: result };
}

const DECISIONS: ModerationDecision[] = ["approve", "reject", "request-info", "execute", "mark-actioned"];

export async function action({ request, context, params }: ActionFunctionArgs) {
  const env = getCloudflare(context).env as Env;
  const user = await actingUserFrom(request, env);
  const form = await request.formData();
  const decision = String(form.get("_action") || "") as ModerationDecision;
  const words = adminCopy(langOf(new URL(request.url).search));
  if (!DECISIONS.includes(decision)) return { ok: false, error: words.common.unknownAction };
  const note = String(form.get("note") || "").trim();
  if ((decision === "reject" || decision === "request-info") && !note) {
    return { ok: false, error: words.moderation.writeNote };
  }
  const result = await decideModerationRequest(env, { id: user.id, email: user.email, roles: user.roles || [] }, params.id!, decision, note || undefined);
  if (isErrorResponse(result)) return { ok: false, error: result.error };
  return { ok: true, status: result.request.status };
}

/** Decisions that run the action on the auth account ask first, in the page. */
const CONFIRMED: ReadonlySet<ModerationDecision> = new Set<ModerationDecision>(["approve", "execute"]);

export default function ModerationRequestPage() {
  const { detail, error, user, authServerUrl } = useLoaderData<LoaderData>();
  const fetcher = useFetcher<{ ok: boolean; error?: string; status?: string }>();
  const busy = fetcher.state !== "idle";
  const revalidator = useRevalidator();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState<ModerationDecision | null>(null);
  const [searchParams] = useSearchParams();
  const lang = langOf(searchParams);
  const copy = confirmCopy(lang);
  const t = adminCopy(lang).moderation;
  const L = adminCopy(lang).moderationLabels;
  const c = adminCopy(lang).common;
  // Times: local with the zone, UTC on hover (components/admin-time.tsx)
  const when = (v: string | number | null | undefined) => <AdminTime value={v} lang={lang} />;
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
        <Link to={withLang("/moderation", lang)} className="inline-flex items-center gap-1 text-sm underline mb-4"><ArrowLeft className="h-4 w-4 rtl:-scale-x-100" /> {t.back}</Link>
        <div role="alert" className="p-4 ui-alert-error rounded-lg">{t.loadOneError(error ?? "")}</div>
      </AdminLayout>
    );
  }

  const { request: r, subject, prior_requests } = detail;
  const open = r.status === "pending" || r.status === "info_requested";
  const automatic = r.action !== "other";
  const failed = r.status === "approved" && !!r.execution?.needs_attention;
  const canExecute = failed && automatic;
  const canMarkActioned = r.status === "approved" && (!automatic || failed);

  // Approving or re-running asks in the page dialog first; the form is sent from there
  const submit = (decision: ModerationDecision) => (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!CONFIRMED.has(decision)) return;
    event.preventDefault();
    setPending(decision);
  };
  const sendPending = () => {
    if (!pending || !formRef.current) return;
    const data = new FormData(formRef.current);
    data.set("_action", pending);
    fetcher.submit(data, { method: "post" });
    setPending(null);
  };
  const pendingCopy = pending === "approve" || pending === "execute" ? copy[pending] : undefined;
  // Deleting an account is high impact: the admin types the account's email (or id)
  const deletesAccount = r.action === "delete_account";

  return (
    <AdminLayout user={user} authServerUrl={authServerUrl}>
      <Link to={withLang("/moderation", lang)} className="inline-flex items-center gap-1 text-sm underline mb-4"><ArrowLeft className="h-4 w-4 rtl:-scale-x-100" /> {t.back}</Link>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h2 className="text-2xl font-bold text-[var(--color-foreground)]">{label(L.action, r.action)}</h2>
        <Badge variant="outline" data-testid="moderation-status" className={MODERATION_STATUS_CLASSES[r.status]}>
          {label(L.status, r.status)}
        </Badge>
        <span className="text-sm text-[var(--color-muted-foreground)]" dir="ltr">{r.id}</span>
      </div>

      {fetcher.data?.error && (
        <div role="alert" className="mb-4 p-3 ui-alert-error rounded-lg">{fetcher.data.error}</div>
      )}
      {failed && (
        <div role="alert" data-testid="moderation-action-failed" className="mb-4 p-3 ui-alert-error rounded-lg">
          <div className="font-medium">{t.failedTitle(r.execution.attempts)}</div>
          {r.action_error && <div className="text-sm mt-1"><bdi>{r.action_error}</bdi></div>}
          <div className="text-sm mt-1">{t.failedHelp}</div>
        </div>
      )}
      {running && (
        <div role="status" data-testid="moderation-action-running" className="mb-4 p-3 ui-alert-info rounded-lg">
          {t.running(r.execution.status === "retrying", r.execution.attempts + 1)}
          {r.execution.status === "retrying" && r.action_error && <div className="text-sm mt-1">{t.lastError("")}<bdi>{r.action_error}</bdi></div>}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t.request}</CardTitle>
              <CardDescription>
                {t.fromLabel} <bdi>{r.client_name ?? r.client_id}</bdi>{c.sep}{t.byLabel} {/* name and id as one left-to-right unit: "Huda Qasim (mod-7)" in both languages */}<bdi dir="ltr" className="whitespace-nowrap">{r.requested_by.display_name} ({r.requested_by.id})</bdi>{c.sep}{when(r.created_at)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">{t.reason}</div>
                <div className="font-medium">{label(L.reason, r.reason_category)}</div>
                <p className="whitespace-pre-wrap mt-1" data-testid="moderation-reason"><bdi>{r.reason}</bdi></p>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">{t.evidence}</div>
                {r.evidence.length === 0 ? (
                  <p className="text-sm text-[var(--color-muted-foreground)]">{t.noEvidence}</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {r.evidence.map((e, i) => (
                      <li key={`${e.url}-${i}`}>
                        <a href={e.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline break-all">
                          <bdi>{e.label || e.url}</bdi> <ExternalLink className="h-3 w-3" />
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {r.decision_note && (
                <div>
                  <div className="text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">{t.decisionNote}</div>
                  <p className="whitespace-pre-wrap"><bdi>{r.decision_note}</bdi></p>
                </div>
              )}
            </CardContent>
          </Card>

          {(open || r.status === "approved") && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t.decide}</CardTitle>
                <CardDescription>{automatic ? t.decideAuto : t.decideOther}</CardDescription>
              </CardHeader>
              <CardContent>
                <fetcher.Form ref={formRef} method="post" className="space-y-3" data-testid="moderation-decide">
                  <div className="space-y-1">
                    <Label htmlFor="note">{t.noteLabel}</Label>
                    <textarea
                      id="note"
                      name="note"
                      rows={3}
                      maxLength={4000}
                      className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm"
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {open && (
                      <>
                        <Button type="submit" name="_action" value="approve" disabled={busy} onClick={submit("approve")}>
                          {automatic ? t.approveAndRun : t.approve}
                        </Button>
                        <Button type="submit" name="_action" value="reject" variant="destructive" disabled={busy}>{t.reject}</Button>
                        {r.status === "pending" && (
                          <Button type="submit" name="_action" value="request-info" variant="outline" disabled={busy}>{t.requestInfo}</Button>
                        )}
                      </>
                    )}
                    {canExecute && (
                      <Button type="submit" name="_action" value="execute" disabled={busy} onClick={submit("execute")} data-testid="moderation-run-again">{t.runAgain}</Button>
                    )}
                    {canMarkActioned && (
                      <Button type="submit" name="_action" value="mark-actioned" variant="outline" disabled={busy}>{t.markActioned}</Button>
                    )}
                    {r.status === "approved" && (
                      <Button type="submit" name="_action" value="reject" variant="destructive" disabled={busy}>{t.reject}</Button>
                    )}
                  </div>
                </fetcher.Form>
              </CardContent>
            </Card>
          )}

          {pendingCopy && (
            <ConfirmDialog
              open
              title={pendingCopy.title}
              description={
                deletesAccount
                  ? `${pendingCopy.body} ${copy.deletesAccount(subject?.email ?? r.subject_user_id)}`
                  : pendingCopy.body
              }
              confirmLabel={pendingCopy.confirm}
              cancelLabel={copy.cancel}
              dir={dirOf(lang)}
              lang={lang}
              danger={deletesAccount}
              onCancel={() => setPending(null)}
              onConfirm={sendPending}
            />
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t.history}</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3" data-testid="moderation-history">
                {r.history.map((h) => (
                  <li key={h.id} className="border-s-2 border-[var(--color-border)] ps-3">
                    <div className="text-sm font-medium">{t.historyType[h.type] ?? h.type.replace(/_/g, " ")}</div>
                    <div className="text-xs text-[var(--color-muted-foreground)]">
                      {h.actor_type === "admin" ? <>{t.historyAdmin("")}<bdi>{h.actor_name ?? h.actor_id}</bdi></> : h.actor_type === "client" ? <><bdi>{h.actor_name ?? t.historyClient}</bdi> (<bdi>{r.client_name ?? r.client_id}</bdi>)</> : t.historySystem}{c.sep}{when(h.at)}
                    </div>
                    {h.note && <p className="text-sm whitespace-pre-wrap mt-1"><bdi>{h.note}</bdi></p>}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t.user}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {subject ? (
                <>
                  {subject.name && <div className="font-medium"><bdi>{subject.name}</bdi></div>}
                  <div className={subject.name ? "" : "font-medium"} data-testid="moderation-subject-email"><Email value={subject.email} /></div>
                  <div>{t.userStatus} <span className="font-medium">{t.userStatusValue[subject.status] ?? subject.status}</span></div>
                  {subject.password_reset_required && <div>{t.passwordResetRequired}</div>}
                  <div>{t.joined("")}{when(subject.created_at)}</div>
                  <Link to={userPageHref(subject, lang)} className="inline-block mt-2 underline">{t.openInUsers}</Link>
                </>
              ) : (
                <p>{t.noSubject} <bdi dir="ltr">{r.subject_user_id}</bdi></p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t.earlier}</CardTitle>
            </CardHeader>
            <CardContent>
              {prior_requests.length === 0 ? (
                <p className="text-sm text-[var(--color-muted-foreground)]">{t.noneEarlier}</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {prior_requests.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-2">
                      <Link to={withLang(`/moderation/${p.id}`, lang)} className="underline">{label(L.action, p.action)}</Link>
                      <span className="text-xs text-[var(--color-muted-foreground)]">{when(p.created_at)}</span>
                      <Badge variant="outline" className={MODERATION_STATUS_CLASSES[p.status]}>{label(L.status, p.status)}</Badge>
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
