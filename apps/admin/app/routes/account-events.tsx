import { Fragment, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useFetcher, useLoaderData, useSearchParams } from "react-router";
import { RotateCcw } from "lucide-react";
import { AdminLayout } from "../components/admin-layout";
import { AdminTime } from "../components/admin-time";
import { ConfirmDialog } from "../components/confirm-dialog";
import { LoadErrorBanner } from "../components/load-error-banner";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { accountEventsCopy, errorOf, type AccountEventsCopy, type EventStatus } from "../lib/account-events-copy";
import { getAccountEvents, isErrorResponse, resendAccountEvent, type AccountEventDelivery, type AccountEventSubscriber, type AccountEventsView } from "../lib/admin-api.server";
import { pageTitle } from "../lib/admin-copy";
import { getCloudflare } from "../lib/cloudflare-context";
import { getAuthServerUrl } from "../lib/config";
import { dirOf, langOf } from "../lib/deletion-copy";
import { logger } from "../lib/logger.server";
import { userPageHref } from "../lib/moderation";
import { actingOf, adminUserOf, type AdminEnv } from "../lib/passkeys.server";
import { userNames } from "../lib/user-names.server";

export const meta: MetaFunction = ({ location }) => [{ title: pageTitle("accountEvents", langOf(location.search)) }];

const STATUSES: EventStatus[] = ["failed", "pending", "delivered"];
const JTI = /^[0-9a-f-]{36}$/;

/**
 * Admin > Account events (AlUmmahNowAuth#507): each app that receives account events, its last
 * delivery, what waits and what failed, and "Send again" for a failed delivery. Off by default:
 * 404, and no link in the rail, until ACCOUNT_EVENTS is on (here and on the Auth server).
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getCloudflare(context).env as AdminEnv;
  const user = await adminUserOf(request, env);
  if (env.ACCOUNT_EVENTS !== "on") throw new Response("Not Found", { status: 404 });
  const query = new URL(request.url).searchParams;
  const status = STATUSES.find((s) => s === query.get("status")) ?? "failed";
  // A hand-edited link shows the first page, not an error
  const client = /^[A-Za-z0-9._-]{1,128}$/.exec(query.get("client") ?? "")?.[0];
  const before = /^\d{1,16}_[0-9a-f-]{36}$/.exec(query.get("before") ?? "")?.[0];
  const base = { user: { id: user.id, email: user.email }, authServerUrl: getAuthServerUrl(request, env), passkeyGraceUntil: user.passkeyGraceUntil, status, client, before };
  const view = await getAccountEvents(env, actingOf(user), { status, client, before }, request);
  if (isErrorResponse(view)) {
    if (view.error === "feature_off") throw new Response("Not Found", { status: 404 });
    logger.error("Account events: load failed", { error: view.error });
    return { ...base, view: null as AccountEventsView | null, names: {} as Record<string, string>, loadError: view.error };
  }
  const names = await userNames(env.AUTH_DB, view.deliveries.map((d) => d.userId));
  return { ...base, view, names, loadError: undefined as string | undefined };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getCloudflare(context).env as AdminEnv;
  const user = await adminUserOf(request, env);
  if (env.ACCOUNT_EVENTS !== "on") throw new Response("Not Found", { status: 404 });
  const jti = (await request.formData()).get("jti");
  if (typeof jti !== "string" || !JTI.test(jti)) return { ok: false as const, error: "generic" };
  const result = await resendAccountEvent(env, actingOf(user), jti);
  if (isErrorResponse(result)) return { ok: false as const, error: result.error };
  logger.info("Account events: sent again", { jti, by: user.id });
  return { ok: true as const, error: null };
}

const errorText = (t: AccountEventsCopy, code: string | null) => (code && Object.hasOwn(t.errors, code) ? t.errors[code as keyof AccountEventsCopy["errors"]] : t.errors.generic);
const muted = "text-[var(--color-muted-foreground)]";

export default function AccountEvents() {
  const { user, authServerUrl, view, names, loadError, passkeyGraceUntil, status, client, before } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const lang = langOf(searchParams);
  const t = accountEventsCopy(lang);
  const fetcher = useFetcher<typeof action>();
  const [confirming, setConfirming] = useState<AccountEventDelivery | null>(null);
  const busy = fetcher.state !== "idle";
  const result = fetcher.state === "idle" ? fetcher.data : undefined;

  const apps = view?.clients ?? [];
  const appName = (id: string) => apps.find((a) => a.clientId === id)?.name ?? id;
  const eventName = (type: string) => t.event[type] ?? type;
  /** This page with other filters; a new filter starts at the newest. */
  const href = (next: { status?: EventStatus; client?: string | null; before?: string }) => {
    const q = new URLSearchParams();
    q.set("status", next.status ?? status);
    const app = next.client === undefined ? client : next.client;
    if (app) q.set("client", app);
    if (next.before) q.set("before", next.before);
    if (lang === "ar") q.set("lang", "ar");
    return `?${q}`;
  };

  const count = (app: AccountEventSubscriber, which: "pending" | "failed") =>
    app[which] === 0 ? (
      <span className={muted}>{t.count(0, view!.countLimit)}</span>
    ) : (
      <Link
        to={href({ status: which, client: app.clientId })}
        className={`font-semibold underline underline-offset-4 ${which === "failed" ? "text-[var(--color-destructive-text)]" : ""}`}
        aria-label={`${t.status[which]}${t.listSep}${app.name}: ${t.count(app[which], view!.countLimit)}`}
      >
        {t.count(app[which], view!.countLimit)}
      </Link>
    );
  const receives = (app: AccountEventSubscriber) => app.types.map(eventName).join(t.listSep);
  const address = (app: AccountEventSubscriber) => (
    // Wraps after a slash, never inside a word
    <code dir="ltr" className={`block text-xs [overflow-wrap:break-word] rtl:text-right ${muted}`}>
      {app.uri.split(/(?<=\/)(?!\/)/).map((part, i) => <Fragment key={i}>{part}<wbr /></Fragment>)}
    </code>
  );

  const eventCell = (d: AccountEventDelivery) => (
    <>
      <span className="font-medium">{eventName(d.type)}</span>
      {d.reason && <span className={`block text-xs ${muted}`}>{t.reason[d.reason] ?? d.reason}</span>}
    </>
  );
  // A person by name; an id only when the account no longer exists
  const userCell = (d: AccountEventDelivery) =>
    !d.userId ? (
      <span className={muted}>{t.noUser}</span>
    ) : names[d.userId] ? (
      <Link to={userPageHref({ id: d.userId }, lang)} className="underline underline-offset-4"><bdi>{names[d.userId]}</bdi></Link>
    ) : (
      <bdi className="break-all font-mono text-xs">{d.userId}</bdi>
    );
  const resultCell = (d: AccountEventDelivery) => {
    const error = errorOf(t, d.error);
    return (
      <>
        {d.settledAt && (
          <span className="block">
            {d.status === "failed" ? t.failedAt : t.deliveredAt} <AdminTime value={d.settledAt} lang={lang} />
          </span>
        )}
        {error && (
          <span className={`block ${d.status === "failed" ? "text-[var(--color-destructive-text)]" : muted}`}>
            {error.text}
            {error.code && <> <bdi dir="ltr" className="font-mono text-xs">{error.code}</bdi></>}
          </span>
        )}
        <span className={`block text-xs ${muted}`}>{d.attempts ? t.attempts(d.attempts) : t.notSentYet}</span>
      </>
    );
  };
  const sendAgain = (d: AccountEventDelivery) => (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(d)} aria-label={`${t.sendAgain}${t.listSep}${eventName(d.type)}${t.listSep}${appName(d.clientId)}`}>
      <RotateCcw aria-hidden="true" />
      {busy && fetcher.formData?.get("jti") === d.jti ? t.sending : t.sendAgain}
    </Button>
  );

  return (
    <AdminLayout user={user} authServerUrl={authServerUrl} passkeyGraceUntil={passkeyGraceUntil}>
      <div dir={dirOf(lang)} lang={lang} className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">{t.pageTitle}</h1>
          <p className={`mt-1 max-w-3xl ${muted}`}>{t.pageIntro}</p>
        </div>
        <LoadErrorBanner what={t.loadWhat} error={loadError} />

        {view && (
          <>
            <Card>
              <CardHeader>
                <CardTitle><h2>{t.appsTitle}</h2></CardTitle>
                <CardDescription>{apps.length ? t.appsIntro : t.noApps}</CardDescription>
              </CardHeader>
              {apps.length > 0 && (
                <CardContent>
                  {/* Phones: one card per app (five columns do not fit) */}
                  <ul className="space-y-3 md:hidden" aria-label={t.appsTitle}>
                    {apps.map((app) => (
                      <li key={app.clientId} className="rounded-lg border border-[var(--color-border)] p-3">
                        <p className="font-medium"><bdi>{app.name}</bdi></p>
                        {address(app)}
                        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                          <dt className={muted}>{t.colReceives}</dt>
                          <dd>{receives(app)}</dd>
                          <dt className={muted}>{t.colLast}</dt>
                          <dd><AdminTime value={app.lastDeliveredAt} lang={lang} missing={t.never} /></dd>
                          <dt className={muted}>{t.colWaiting}</dt>
                          <dd>{count(app, "pending")}</dd>
                          <dt className={muted}>{t.colFailed}</dt>
                          <dd>{count(app, "failed")}</dd>
                        </dl>
                      </li>
                    ))}
                  </ul>
                  <div className="hidden md:block">
                    <Table data-testid="account-events-apps" aria-label={t.appsTitle}>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t.colApp}</TableHead>
                          <TableHead>{t.colReceives}</TableHead>
                          <TableHead>{t.colLast}</TableHead>
                          <TableHead>{t.colWaiting}</TableHead>
                          <TableHead>{t.colFailed}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {apps.map((app) => (
                          <TableRow key={app.clientId}>
                            <TableCell>
                              <span className="font-medium"><bdi>{app.name}</bdi></span>
                              {address(app)}
                            </TableCell>
                            <TableCell className="max-w-xs">{receives(app)}</TableCell>
                            <TableCell><AdminTime value={app.lastDeliveredAt} lang={lang} missing={t.never} /></TableCell>
                            <TableCell>{count(app, "pending")}</TableCell>
                            <TableCell>{count(app, "failed")}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              )}
            </Card>

            <Card>
              <CardHeader>
                <CardTitle><h2>{t.deliveriesTitle}</h2></CardTitle>
                <CardDescription>{t.deliveriesIntro}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <nav aria-label={t.filterLabel} className="flex flex-wrap gap-2">
                    {STATUSES.map((s) => (
                      <Link
                        key={s}
                        to={href({ status: s })}
                        aria-current={s === status ? "page" : undefined}
                        className={
                          "rounded-md border px-3 py-1.5 text-sm " +
                          (s === status
                            ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
                            : "border-[var(--color-border)] hover:bg-[var(--color-accent)]")
                        }
                      >
                        {t.status[s]}
                      </Link>
                    ))}
                  </nav>
                  {client && (
                    <p className="text-sm">
                      <bdi>{t.onlyApp(appName(client))}</bdi>{" "}
                      <Link to={href({ client: null })} className="ms-2 text-[var(--color-link)] underline underline-offset-4">{t.allApps}</Link>
                    </p>
                  )}
                </div>
                {result && (
                  <p role={result.ok ? "status" : "alert"} data-testid="account-events-result" className={`text-sm ${result.ok ? "" : "text-[var(--color-destructive-text)]"}`}>
                    {result.ok ? t.queued : errorText(t, result.error)}
                  </p>
                )}
                {view.deliveries.length === 0 ? (
                  <p className={`text-sm ${muted}`} data-testid="account-events-empty">{t.empty[status]}</p>
                ) : (
                  <>
                    <ul className="space-y-3 lg:hidden" aria-label={t.deliveriesTitle}>
                      {view.deliveries.map((d) => (
                        <li key={d.jti} className="rounded-lg border border-[var(--color-border)] p-3 text-sm">
                          <p>{eventCell(d)}</p>
                          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                            <dt className={muted}>{t.colApp}</dt>
                            <dd><bdi>{appName(d.clientId)}</bdi></dd>
                            <dt className={muted}>{t.colUser}</dt>
                            <dd>{userCell(d)}</dd>
                            <dt className={muted}>{t.colHappened}</dt>
                            <dd><AdminTime value={d.createdAt} lang={lang} /></dd>
                            <dt className={muted}>{t.colResult}</dt>
                            <dd>{resultCell(d)}</dd>
                          </dl>
                          {d.status === "failed" && <div className="mt-3">{sendAgain(d)}</div>}
                        </li>
                      ))}
                    </ul>
                    <div className="hidden lg:block">
                      <Table data-testid="account-events-deliveries" aria-label={t.deliveriesTitle}>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t.colEvent}</TableHead>
                            <TableHead>{t.colApp}</TableHead>
                            <TableHead>{t.colUser}</TableHead>
                            <TableHead>{t.colHappened}</TableHead>
                            <TableHead>{t.colResult}</TableHead>
                            {status === "failed" && <TableHead><span className="sr-only">{t.colAction}</span></TableHead>}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {view.deliveries.map((d) => (
                            <TableRow key={d.jti} data-status={d.status}>
                              <TableCell>{eventCell(d)}</TableCell>
                              <TableCell><bdi>{appName(d.clientId)}</bdi></TableCell>
                              <TableCell>{userCell(d)}</TableCell>
                              <TableCell><AdminTime value={d.createdAt} lang={lang} /></TableCell>
                              <TableCell>{resultCell(d)}</TableCell>
                              {status === "failed" && <TableCell className="text-end">{sendAgain(d)}</TableCell>}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </>
                )}
                {(before || view.next) && (
                  <nav aria-label={t.pages} className="flex flex-wrap gap-2">
                    {before && <Button asChild size="sm" variant="outline"><Link to={href({})}>{t.newest}</Link></Button>}
                    {view.next && <Button asChild size="sm" variant="outline"><Link to={href({ before: view.next })}>{t.older}</Link></Button>}
                  </nav>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirming !== null}
        title={t.confirmTitle}
        description={confirming ? t.confirmBody(eventName(confirming.type), appName(confirming.clientId)) : ""}
        confirmLabel={t.confirm}
        cancelLabel={t.cancel}
        danger={false}
        dir={dirOf(lang)}
        lang={lang}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) fetcher.submit({ jti: confirming.jti }, { method: "POST" });
          setConfirming(null);
        }}
      />
    </AdminLayout>
  );
}
