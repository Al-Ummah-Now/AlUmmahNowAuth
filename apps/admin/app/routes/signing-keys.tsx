import { useState } from "react";
import { AdminTime, useAdminTime } from "../components/admin-time";
import { pageTitle } from "../lib/admin-copy";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { AdminLayout } from "../components/admin-layout";
import { ConfirmDialog } from "../components/confirm-dialog";
import { LoadErrorBanner } from "../components/load-error-banner";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { requireStepUp } from "../lib/auth.server";
import { getAuthServerUrl } from "../lib/config";
import { dirOf, langOf, type AdminLang } from "../lib/deletion-copy";
import { logger } from "../lib/logger.server";
import { getSigningKeys, isErrorResponse, queueSigningKeyStep, type SigningKeysView } from "../lib/admin-api.server";
import { actingOf, adminUserOf, type AdminEnv } from "../lib/passkeys.server";
import { signingKeysCopy, type SigningKeysCopy } from "../lib/signing-keys-copy";
import { getCloudflare } from "../lib/cloudflare-context";

export const meta: MetaFunction = ({ location }) => [{ title: pageTitle("signingKeys", langOf(location.search)) }];

/**
 * Admin > Signing keys (AlUmmahNowAuth#13): the issuer's keys and their state,
 * how rotation works, the rotation job's last run, and (Super Admin, fresh
 * sign-in) "Rotate now" and "Run again" after a flagged failure.
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getCloudflare(context).env as AdminEnv;
  const user = await adminUserOf(request, env);
  const base = { user: { id: user.id, email: user.email }, authServerUrl: getAuthServerUrl(request, env), passkeyGraceUntil: user.passkeyGraceUntil };
  const view = await getSigningKeys(env, actingOf(user), request);
  if (isErrorResponse(view)) {
    logger.error("Signing keys: load failed", { error: view.error });
    return { ...base, view: null as SigningKeysView | null, loadError: view.error };
  }
  return { ...base, view, loadError: undefined as string | undefined };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getCloudflare(context).env as AdminEnv;
  const user = await adminUserOf(request, env);
  // High-risk: a fresh sign-in first (AD5)
  requireStepUp(user, request, "/signing-keys");
  const form = await request.formData();
  const intent = form.get("intent") === "retry" ? "retry" : "rotate";
  const result = await queueSigningKeyStep(env, actingOf(user), intent);
  if (isErrorResponse(result)) return { ok: false as const, intent, error: result.error };
  logger.info("Signing keys: step queued", { intent, by: user.id });
  return { ok: true as const, intent, error: null };
}

const HOUR = 3_600_000;

/** A time inside a sentence: local with its zone after hydration (components/admin-time.tsx). */
function formatTime(ms: number | undefined | null, stamp: (v: number) => string, t: SigningKeysCopy): string {
  return ms ? stamp(ms) : t.never;
}

function errorText(t: SigningKeysCopy, code: string): string {
  return code in t.errors ? t.errors[code as keyof SigningKeysCopy["errors"]] : t.errors.generic;
}

const STATE_STYLE: Record<string, string> = {
  active: "border-[var(--color-success-text)] text-[var(--color-success-text)] font-semibold",
  pending: "border-[var(--color-border)] text-[var(--color-foreground)]",
  previous: "border-[var(--color-border)] text-[var(--color-muted-foreground)]",
  retired: "border-transparent text-[var(--color-muted-foreground)] line-through decoration-1",
};

export default function SigningKeys() {
  const { user, authServerUrl, view, loadError, passkeyGraceUntil } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const lang = langOf(searchParams);
  const t = signingKeysCopy(lang);
  const stamp = useAdminTime(lang);
  const fetcher = useFetcher<typeof action>();
  const [confirming, setConfirming] = useState(false);
  const busy = fetcher.state !== "idle";
  const result = fetcher.state === "idle" ? fetcher.data : undefined;
  const submit = (intent: "rotate" | "retry") => {
    fetcher.submit({ intent }, { method: "POST" });
    setConfirming(false);
  };

  const leadHours = view ? Math.round(view.policy.publishLeadMs / HOUR) : 1;
  const retireHours = view ? Math.round(view.policy.retireAfterMs / HOUR) : 24;
  const hasPending = !!view?.keys.some((k) => k.state === "pending");
  // Retired keys last: the ones that matter first
  const keys = view ? [...view.keys].sort((a, b) => Number(a.state === "retired") - Number(b.state === "retired") || b.created - a.created) : [];

  return (
    <AdminLayout user={user} authServerUrl={authServerUrl} passkeyGraceUntil={passkeyGraceUntil}>
      <div dir={dirOf(lang)} lang={lang} className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">{t.pageTitle}</h1>
          <p className="mt-1 max-w-3xl text-[var(--color-muted-foreground)]">{t.pageIntro}</p>
        </div>
        <LoadErrorBanner what={t.loadWhat} error={loadError} />

        {view && (
          <>
            {view.status.error && (
              <div role="alert" data-testid="signing-keys-failed" className="rounded-lg border border-[var(--color-destructive)] bg-[var(--color-muted)] p-4">
                <p className="font-semibold text-[var(--color-destructive-text)]">{t.failedTitle}</p>
                <p className="mt-1 text-sm">{t.failedBody(formatTime(view.status.errorAt, stamp, t), view.status.attempts)}</p>
                <p className="mt-1 text-xs text-[var(--color-muted-foreground)] rtl:text-right" dir="ltr">
                  {view.status.error}
                </p>
                {view.canRotate && (
                  <Button className="mt-3" variant="outline" disabled={busy} onClick={() => submit("retry")} data-testid="signing-keys-retry">
                    {t.retry}
                  </Button>
                )}
              </div>
            )}

            <Card>
              <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4 space-y-0">
                <div>
                  <CardTitle>{t.keysTitle}</CardTitle>
                  <CardDescription>{t.statusTitle}: {view.status.lastRunAt ? t.lastRun(formatTime(view.status.lastRunAt, stamp, t), view.status.lastTrigger ?? "schedule") : t.neverRun}</CardDescription>
                  {view.status.queuedAt && <p className="mt-1 text-sm" role="status">{t.queued(formatTime(view.status.queuedAt, stamp, t))}</p>}
                </div>
                {view.canRotate ? (
                  <div className="flex flex-col items-end gap-1">
                    <Button disabled={busy || hasPending} onClick={() => setConfirming(true)} data-testid="signing-keys-rotate">
                      {busy && result === undefined && fetcher.formData?.get("intent") === "rotate" ? t.rotating : t.rotateNow}
                    </Button>
                    {hasPending && <p className="max-w-xs text-end text-xs text-[var(--color-muted-foreground)]">{t.rotatePending}</p>}
                  </div>
                ) : (
                  <p className="text-sm text-[var(--color-muted-foreground)]">{t.rotateOnlySuper}</p>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                {result && (
                  <p role={result.ok ? "status" : "alert"} className={`text-sm ${result.ok ? "" : "text-[var(--color-destructive-text)]"}`} data-testid="signing-keys-result">
                    {result.ok ? (result.intent === "retry" ? t.retryNotice : t.queuedNotice) : errorText(t, result.error ?? "")}
                  </p>
                )}
                {/* Phones: one card per key (five columns do not fit) */}
                <ul className="space-y-3 md:hidden" data-testid="signing-keys-list" aria-label={t.keysTitle}>
                  {keys.map((k) => (
                    <li key={k.id} data-state={k.state} className="rounded-lg border border-[var(--color-border)] p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${STATE_STYLE[k.state]}`}>{t.state[k.state]}</span>
                        <span className="text-xs text-[var(--color-muted-foreground)]" dir="ltr">{k.alg}</span>
                      </div>
                      <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">{t.stateHelp[k.state]}</p>
                      <code className="mt-2 block break-all text-xs rtl:text-right" dir="ltr">{k.id}</code>
                      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                        <dt className="text-[var(--color-muted-foreground)]">{t.colCreated}</dt>
                        <dd><AdminTime value={k.created} lang={lang} missing={t.never} /></dd>
                        <dt className="text-[var(--color-muted-foreground)]">{t.colSignsFrom}</dt>
                        <dd><AdminTime value={k.activates ?? k.created} lang={lang} missing={t.never} /></dd>
                        {k.expired && (
                          <>
                            <dt className="text-[var(--color-muted-foreground)]">{t.colRetired}</dt>
                            <dd><AdminTime value={k.expired} lang={lang} missing={t.never} /></dd>
                          </>
                        )}
                      </dl>
                    </li>
                  ))}
                </ul>
                <div className="hidden md:block">
                  <Table data-testid="signing-keys-table" aria-label={t.keysTitle}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t.colKey}</TableHead>
                        <TableHead>{t.colState}</TableHead>
                        <TableHead>{t.colCreated}</TableHead>
                        <TableHead>{t.colSignsFrom}</TableHead>
                        <TableHead>{t.colRetired}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {keys.map((k) => (
                        <TableRow key={k.id} data-state={k.state}>
                          <TableCell>
                            <code className="text-xs" dir="ltr">{k.id}</code>
                            <div className="text-xs text-[var(--color-muted-foreground)] rtl:text-right" dir="ltr">{k.alg}</div>
                          </TableCell>
                          <TableCell>
                            <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${STATE_STYLE[k.state]}`}>{t.state[k.state]}</span>
                            <div className="mt-1 max-w-xs text-xs text-[var(--color-muted-foreground)]">{t.stateHelp[k.state]}</div>
                          </TableCell>
                          <TableCell className="whitespace-nowrap"><AdminTime value={k.created} lang={lang} missing={t.never} /></TableCell>
                          <TableCell className="whitespace-nowrap"><AdminTime value={k.activates ?? k.created} lang={lang} missing={t.never} /></TableCell>
                          <TableCell className="whitespace-nowrap"><AdminTime value={k.expired} lang={lang} missing={t.never} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t.policyTitle}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="list-disc space-y-1 ps-6 text-sm" data-testid="signing-keys-policy">
                  {t.policy({ leadHours, rotateDays: Math.round(view.policy.rotateEveryMs / (24 * HOUR)), retireHours, scheduled: view.policy.scheduled }).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        title={t.confirmTitle}
        description={t.confirmBody(leadHours, retireHours)}
        confirmLabel={t.confirm}
        cancelLabel={t.cancel}
        // Not destructive: nobody is signed out
        danger={false}
        dir={dirOf(lang)}
        lang={lang}
        onCancel={() => setConfirming(false)}
        onConfirm={() => submit("rotate")}
      />
    </AdminLayout>
  );
}
