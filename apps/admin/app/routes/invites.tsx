import { useState } from "react";
import { Form, Link, useFetcher, useLoaderData, useSearchParams } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { AdminLayout } from "../components/admin-layout";
import { AdminTime } from "../components/admin-time";
import { ConfirmDialog } from "../components/confirm-dialog";
import { Email } from "../components/email";
import { LoadErrorBanner } from "../components/load-error-banner";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { isErrorResponse, listInvites, revokeInvite, type AdminInvite, type ApiEnv } from "../lib/admin-api.server";
import { adminCopy, pageTitle } from "../lib/admin-copy";
import { requireAuth, requireStepUp, type SessionEnv } from "../lib/auth.server";
import { getCloudflare } from "../lib/cloudflare-context";
import { getAuthServerUrl } from "../lib/config";
import { dirOf, langOf } from "../lib/deletion-copy";
import { inviteCopy, INVITE_STATUSES } from "../lib/invite-copy";

export const meta: MetaFunction = ({ location }) => [{ title: pageTitle("invites", langOf(location.search)) }];

type Env = SessionEnv & ApiEnv;

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getCloudflare(context).env as Env;
  const user = await requireAuth(request, env, true);
  const searchParams = new URL(request.url).searchParams;
  const params = new URLSearchParams();
  for (const key of ["search", "status", "cursor"]) {
    const value = searchParams.get(key);
    if (value) params.set(key, value);
  }
  const result = await listInvites(env, { id: user.id, email: user.email, roles: user.roles ?? [] }, params, request);
  const shell = { user: { id: user.id, email: user.email }, authServerUrl: getAuthServerUrl(request, env) };
  if (isErrorResponse(result)) return { ...shell, invites: [], nextCursor: null, loadError: result.error };
  return { ...shell, ...result, loadError: undefined };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getCloudflare(context).env as Env;
  const user = await requireAuth(request, env, true);
  const form = await request.formData();
  const id = form.get("id");
  if (form.get("intent") !== "revoke" || typeof id !== "string" || !id) {
    return { ok: false, error: inviteCopy(langOf(new URL(request.url).search)).invalid };
  }
  requireStepUp(user, request);
  const result = await revokeInvite(env, { id: user.id, email: user.email, roles: user.roles ?? [] }, id, request);
  return isErrorResponse(result) ? { ok: false, error: result.error } : { ok: true };
}

export default function Invites() {
  const { user, authServerUrl, invites, nextCursor, loadError } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const lang = langOf(params);
  const t = inviteCopy(lang);
  const [pending, setPending] = useState<AdminInvite | null>(null);
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";

  function pageHref(cursor: string | null) {
    const query = new URLSearchParams(params);
    if (cursor) query.set("cursor", cursor);
    else query.delete("cursor");
    return { pathname: "/invites", search: query.toString() };
  }

  return (
    <AdminLayout user={user} authServerUrl={authServerUrl}>
      <div dir={dirOf(lang)} lang={lang} className="space-y-4">
        <h1 className="text-3xl font-bold tracking-tight">{t.title}</h1>
        <Form method="get" key={params.toString()} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="lang" value={lang} />
          <label className="grid gap-1 text-sm">
            {t.search}
            <Input name="search" defaultValue={params.get("search") ?? ""} maxLength={100} />
          </label>
          <label className="grid gap-1 text-sm">
            {t.status}
            <select name="status" defaultValue={params.get("status") ?? "all"} className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3">
              <option value="all">{t.all}</option>
              {INVITE_STATUSES.map((status) => <option key={status} value={status}>{t.inviteStatuses[status]}</option>)}
            </select>
          </label>
          <Button type="submit" variant="outline">{t.apply}</Button>
        </Form>

        <LoadErrorBanner what={t.title} error={loadError} />
        {!busy && fetcher.data?.ok && <p role="status">{t.revoked}</p>}
        {!busy && fetcher.data?.error && <p role="alert" className="text-[var(--color-destructive-text)]">{fetcher.data.error}</p>}
        {!loadError && invites.length === 0 && <p className="text-[var(--color-muted-foreground)]">{t.empty}</p>}

        <ul className="grid gap-3 md:grid-cols-2">
          {invites.map((invite) => (
            <li key={invite.id} className="min-w-0">
              <Card className="h-full">
                <CardContent className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 break-words">
                      {invite.name && <div className="font-semibold"><bdi>{invite.name}</bdi></div>}
                      <Email value={invite.email} />
                    </div>
                    <Badge variant={invite.status === "revoked" ? "destructive" : "secondary"}>{t.inviteStatuses[invite.status]}</Badge>
                  </div>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-[var(--color-muted-foreground)]">{t.inviter}</dt>
                    <dd className="break-words"><bdi>{invite.invitedByEmail || invite.invitedByUserId}</bdi></dd>
                    <dt className="text-[var(--color-muted-foreground)]">{t.client}</dt>
                    <dd className="break-words"><bdi>{invite.clientName || invite.clientId}</bdi></dd>
                    <dt className="text-[var(--color-muted-foreground)]">{t.created}</dt>
                    <dd><AdminTime value={invite.createdAt} lang={lang} /></dd>
                    <dt className="text-[var(--color-muted-foreground)]">{t.expires}</dt>
                    <dd><AdminTime value={invite.expiresAt} lang={lang} /></dd>
                  </dl>
                  {(invite.status === "pending" || invite.status === "expired") && (
                    <div className="flex justify-end">
                      <Button size="sm" variant="destructive" disabled={busy} onClick={() => setPending(invite)}>{t.revoke}</Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap gap-2">
          {params.has("cursor") && <Button asChild variant="outline"><Link to={pageHref(null)}>{t.first}</Link></Button>}
          {nextCursor && <Button asChild variant="outline"><Link to={pageHref(nextCursor)}>{t.next}</Link></Button>}
        </div>
      </div>
      <ConfirmDialog
        open={!!pending}
        title={t.revokeTitle}
        description={pending ? `${t.revokeBody} (⁦${pending.email}⁩)` : t.revokeBody}
        confirmLabel={t.revoke}
        cancelLabel={adminCopy(lang).common.cancel}
        busy={busy}
        dir={dirOf(lang)}
        lang={lang}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (!pending) return;
          fetcher.submit({ intent: "revoke", id: pending.id }, { method: "post" });
          setPending(null);
        }}
      />
    </AdminLayout>
  );
}
