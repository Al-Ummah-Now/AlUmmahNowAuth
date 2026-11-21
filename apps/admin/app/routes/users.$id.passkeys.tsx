import { formatDate } from "../../../../packages/ui/src/format.ts";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useFetcher, useLoaderData, useSearchParams } from "react-router";
import { dirOf, langOf } from "../lib/deletion-copy";
import { pagesCopy } from "../lib/pages-copy";
import { AdminLayout } from "../components/admin-layout";
import { ConfirmDialog } from "../components/confirm-dialog";
import { LoadErrorBanner } from "../components/load-error-banner";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { requireStepUp } from "../lib/auth.server";
import { getAuthServerUrl } from "../lib/config";
import { logger } from "../lib/logger.server";
import { getUser, isErrorResponse, listUserPasskeys, removeUserPasskey, sendPasskeySetupLink, type PasskeySummary } from "../lib/admin-api.server";
import { actingOf, adminUserOf, type AdminEnv } from "../lib/passkeys.server";
import { getCloudflare } from "../lib/cloudflare-context";

export const meta: MetaFunction = () => [{ title: "Passkeys - Al Ummah Now Admin" }];

/**
 * One user's passkeys (AUTH-PASSKEYS PK4, staff recovery): list, remove
 * (in-app dialog; the user is emailed) and "Send setup link" (one-time, 24 h,
 * never for your own account). Both changes need a sign-in within 15 minutes.
 */
export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const env = getCloudflare(context).env as AdminEnv;
  const user = await adminUserOf(request, env);
  const userId = String(params.id ?? "");
  const acting = actingOf(user);
  const [target, list] = await Promise.all([getUser(env, acting, userId), listUserPasskeys(env, acting, userId, request)]);
  return {
    user: { id: user.id, email: user.email },
    authServerUrl: getAuthServerUrl(request, env),
    passkeyGraceUntil: user.passkeyGraceUntil,
    self: user.id === userId,
    targetId: userId,
    targetEmail: isErrorResponse(target) ? "" : (target as { email?: string }).email ?? "",
    passkeys: isErrorResponse(list) ? ([] as PasskeySummary[]) : list.passkeys,
    staff: isErrorResponse(list) ? false : list.staff,
    loadError: isErrorResponse(list) ? list.error : undefined,
  };
}

export async function action({ request, context, params }: ActionFunctionArgs) {
  const env = getCloudflare(context).env as AdminEnv;
  const user = await adminUserOf(request, env);
  const userId = String(params.id ?? "");
  requireStepUp(user, request, `/users/${encodeURIComponent(userId)}/passkeys`);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "remove") {
    const result = await removeUserPasskey(env, actingOf(user), userId, String(form.get("credentialId") ?? ""));
    if (isErrorResponse(result)) return { ok: false, error: result.error, notice: null as string | null };
    logger.info("Passkeys: removed by admin", { userId, by: user.id });
    return { ok: true, error: null as string | null, notice: "removed" as string | null };
  }
  if (intent === "setup-link") {
    const locale = form.get("locale") === "ar" ? "ar" : "en";
    const result = await sendPasskeySetupLink(env, actingOf(user), userId, locale);
    if (isErrorResponse(result)) {
      return { ok: false, error: result.error === "not_for_yourself" ? "not_self" : result.error, notice: null };
    }
    logger.info("Passkeys: setup link sent", { userId, by: user.id, sent: result.sent });
    return {
      ok: true,
      error: result.sent ? null : "email_failed",
      notice: result.sent ? "sent" : null,
    };
  }
  return { ok: false, error: "Unknown action", notice: null };
}

/** A setup link works this long (Auth: passkeys/routes.ts). */
const SETUP_LINK_HOURS = 24;

export default function UserPasskeys() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [removing, setRemoving] = useState<PasskeySummary | null>(null);
  const [searchParams] = useSearchParams();
  const lang = langOf(searchParams);
  const t = pagesCopy(lang).passkeys;
  const c = pagesCopy(lang).common;
  // The email's language: the admin picks; it starts as the page's language
  const [locale, setLocale] = useState<"en" | "ar">(lang);
  const busy = fetcher.state !== "idle";
  const fmt = (ms: number | null) => (ms ? formatDate(ms, lang, { dateStyle: "medium", timeZone: "UTC" }) : t.never);
  const who = data.targetEmail || data.targetId;
  const message = (key: string | null | undefined) =>
    key === "removed" ? t.removed : key === "sent" ? t.sent(SETUP_LINK_HOURS) : key === "not_self" ? t.linkSelf : key === "email_failed" ? t.emailFailed : key;

  return (
    <AdminLayout user={data.user} authServerUrl={data.authServerUrl} passkeyGraceUntil={data.passkeyGraceUntil} localized>
      <p className="text-sm mb-2">
        <Link className="underline" to={lang === "ar" ? "/users?lang=ar" : "/users"}>
          {t.back}
        </Link>
      </p>
      <h1 className="text-2xl font-semibold mb-6">{t.title("")}<bdi>{who}</bdi></h1>
      <LoadErrorBanner title={c.couldNotLoad(t.what)} error={data.loadError} />
      {fetcher.data?.error && (
        <p className="text-sm text-[var(--color-destructive-text)] mb-4" role="alert">
          {message(fetcher.data.error)}
        </p>
      )}
      {fetcher.data?.notice && (
        <p className="text-sm mb-4" role="status">
          {message(fetcher.data.notice)}
        </p>
      )}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t.cardTitle}</CardTitle>
          <CardDescription>{data.staff ? t.staff : t.notStaff}</CardDescription>
        </CardHeader>
        <CardContent>
          {data.passkeys.length === 0 ? (
            <p data-testid="no-passkeys">{t.empty}</p>
          ) : (
            <>
              {/* Phone: a card per passkey; a table from md up */}
              <ul className="space-y-3 md:hidden">
                {data.passkeys.map((p) => (
                  <li key={p.id} className="rounded-lg border border-[var(--color-border)] p-3">
                    <div className="font-medium"><bdi>{p.name}</bdi></div>
                    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                      <dt className="text-[var(--color-muted-foreground)]">{t.kind}</dt>
                      <dd>{p.synced ? t.synced : t.deviceOnly}</dd>
                      <dt className="text-[var(--color-muted-foreground)]">{t.added}</dt>
                      <dd>{fmt(p.createdAt)}</dd>
                      <dt className="text-[var(--color-muted-foreground)]">{t.lastUsed}</dt>
                      <dd>{fmt(p.lastUsedAt)}</dd>
                    </dl>
                    <div className="mt-3 flex justify-end">
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => setRemoving(p)} aria-label={t.removeOf(p.name)}>
                        {t.remove}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{c.name}</TableHead>
                      <TableHead>{t.kind}</TableHead>
                      <TableHead>{t.added}</TableHead>
                      <TableHead>{t.lastUsed}</TableHead>
                      <TableHead>
                        <span className="sr-only">{c.actions}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.passkeys.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>
                          <bdi>{p.name}</bdi>
                        </TableCell>
                        <TableCell>{p.synced ? t.synced : t.deviceOnly}</TableCell>
                        <TableCell>{fmt(p.createdAt)}</TableCell>
                        <TableCell>{fmt(p.lastUsedAt)}</TableCell>
                        <TableCell className="text-end">
                          <Button variant="outline" size="sm" disabled={busy} onClick={() => setRemoving(p)} aria-label={t.removeOf(p.name)}>
                            {t.remove}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t.linkTitle}</CardTitle>
          <CardDescription>{t.linkIntro(SETUP_LINK_HOURS)}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          {data.self ? (
            <p className="text-sm">{t.linkSelf}</p>
          ) : (
            <>
              <label className="text-sm flex items-center gap-2">
                {t.emailLanguage}
                <select className="rounded border px-2 py-1 bg-transparent" value={locale} onChange={(e) => setLocale(e.target.value === "ar" ? "ar" : "en")}>
                  <option value="en" lang="en">{t.english}</option>
                  <option value="ar" lang="ar">{t.arabic}</option>
                </select>
              </label>
              <Button disabled={busy} data-testid="send-setup-link" onClick={() => fetcher.submit({ intent: "setup-link", locale }, { method: "POST" })}>
                {t.send}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={removing !== null}
        title={t.removeTitle}
        description={t.removeBody(removing?.name ?? "")}
        confirmLabel={t.remove}
        cancelLabel={c.cancel}
        dir={dirOf(lang)}
        lang={lang}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) fetcher.submit({ intent: "remove", credentialId: removing.id }, { method: "POST" });
          setRemoving(null);
        }}
      />
    </AdminLayout>
  );
}
