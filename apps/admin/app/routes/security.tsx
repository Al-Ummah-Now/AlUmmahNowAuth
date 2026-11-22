import { formatDateTime } from "../../../../packages/ui/src/format.ts";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useFetcher, useLoaderData, useSearchParams } from "react-router";
import { adminCopy, pageTitle } from "../lib/admin-copy";
import { dirOf, langOf } from "../lib/deletion-copy";
import { withLang } from "../lib/shell-copy";
import { AdminLayout } from "../components/admin-layout";
import { ConfirmDialog } from "../components/confirm-dialog";
import { LoadErrorBanner } from "../components/load-error-banner";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { requireStepUp } from "../lib/auth.server";
import { getAuthServerUrl } from "../lib/config";
import { logger } from "../lib/logger.server";
import { getStaffPasskeySettings, isErrorResponse, setStaffPasskeyEnforcement, type StaffPasskeySettings } from "../lib/admin-api.server";
import { actingOf, adminUserOf, isSuperAdmin, type AdminEnv } from "../lib/passkeys.server";
import { getCloudflare } from "../lib/cloudflare-context";

export const meta: MetaFunction = ({ location }) => [{ title: pageTitle("security", langOf(location.search)) }];

/**
 * Staff passkeys (AUTH-PASSKEYS): the admin-managed enforcement switch.
 * Super Admins only; switching on needs a passkey of your own (so nobody locks
 * themselves out) and a sign-in within 15 minutes. Existing staff get 7 days.
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getCloudflare(context).env as AdminEnv;
  const user = await adminUserOf(request, env);
  const base = {
    user: { id: user.id, email: user.email },
    authServerUrl: getAuthServerUrl(request, env),
    canChange: isSuperAdmin(user.roles),
    passkeyGraceUntil: user.passkeyGraceUntil,
  };
  const settings = await getStaffPasskeySettings(env, actingOf(user), request);
  if (isErrorResponse(settings)) {
    logger.error("Security: settings failed", { error: settings.error });
    return { ...base, settings: null as StaffPasskeySettings | null, loadError: settings.error };
  }
  return { ...base, settings, loadError: undefined as string | undefined };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getCloudflare(context).env as AdminEnv;
  const user = await adminUserOf(request, env);
  // High-risk: a fresh sign-in first (AD5)
  const lang = langOf(new URL(request.url).search);
  const t = adminCopy(lang).security;
  requireStepUp(user, request, withLang("/security", lang));
  const form = await request.formData();
  const enforced = form.get("enforced") === "true";
  const result = await setStaffPasskeyEnforcement(env, actingOf(user), enforced);
  if (isErrorResponse(result)) {
    const message =
      result.error === "actor_needs_passkey"
        ? t.actorNeedsPasskey
        : result.error === "super_admin_only"
          ? t.superAdminOnly
          : result.error;
    return { ok: false, error: message };
  }
  logger.info("Security: staff passkey enforcement changed", { enforced, by: user.id });
  return { ok: true, error: null as string | null };
}


export default function Security() {
  const { user, authServerUrl, settings, loadError, canChange, passkeyGraceUntil } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [searchParams] = useSearchParams();
  const lang = langOf(searchParams);
  const t = adminCopy(lang).security;
  const c = adminCopy(lang).common;
  const fmt = (ms: number) => `${formatDateTime(ms, lang, { dateStyle: "long", timeStyle: "short", timeZone: "UTC" })} ${t.utc}`;
  const [confirming, setConfirming] = useState<null | boolean>(null);
  const busy = fetcher.state !== "idle";
  const error = fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const submit = (enforced: boolean) => {
    fetcher.submit({ enforced: String(enforced) }, { method: "POST" });
    setConfirming(null);
  };
  const graceEnd = settings?.enforcedAt ? settings.enforcedAt + settings.graceDays * 86_400_000 : null;

  return (
    <AdminLayout user={user} authServerUrl={authServerUrl} passkeyGraceUntil={passkeyGraceUntil}>
      <h1 className="text-2xl font-semibold mb-6">{t.title}</h1>
      <LoadErrorBanner what={t.what} error={loadError} />
      {settings && (
        <Card>
          <CardHeader>
            <CardTitle>{t.staffPasskeys}</CardTitle>
            <CardDescription>{t.intro(settings.graceDays)}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p data-testid="staff-passkeys-state">
              {settings.enforced ? (
                <>
                  <strong>{t.on}</strong>{t.onSince(fmt(settings.enforcedAt!), fmt(graceEnd!))}
                </>
              ) : (
                <>
                  <strong>{t.off}</strong>{t.offNote}
                </>
              )}
            </p>
            <p>{t.staffCount(settings.staff, settings.capped, settings.withoutPasskey.length)}</p>
            {settings.withoutPasskey.length > 0 && (
              <ul className="list-disc ps-6 text-sm" data-testid="staff-without-passkey">
                {settings.withoutPasskey.slice(0, 50).map((s) => (
                  <li key={s.id}>
                    <Link className="inline-flex min-h-6 items-center underline" to={withLang(`/users/${encodeURIComponent(s.id)}/passkeys`, lang)}>
                      <bdi>{s.email}</bdi>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {!settings.actorHasPasskey && (
              <p className="text-sm" role="note">
                {t.noPasskeyYet}
              </p>
            )}
            {error && (
              <p className="text-sm text-[var(--color-destructive-text)]" role="alert">
                {error}
              </p>
            )}
            {canChange ? (
              settings.enforced ? (
                <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)} data-testid="staff-passkeys-off">
                  {t.switchOff}
                </Button>
              ) : (
                <Button disabled={busy || !settings.actorHasPasskey} onClick={() => setConfirming(true)} data-testid="staff-passkeys-on">
                  {t.switchOn}
                </Button>
              )
            ) : (
              <p className="text-sm">{t.superAdminOnly}</p>
            )}
          </CardContent>
        </Card>
      )}
      <ConfirmDialog
        open={confirming !== null}
        title={confirming ? t.confirmOnTitle : t.confirmOffTitle}
        description={confirming ? t.confirmOnBody(settings?.graceDays ?? 7) : t.confirmOffBody}
        confirmLabel={confirming ? t.switchOn : t.switchOff}
        cancelLabel={c.cancel}
        dir={dirOf(lang)}
        lang={lang}
        danger={!confirming}
        onCancel={() => setConfirming(null)}
        onConfirm={() => submit(!!confirming)}
      />
    </AdminLayout>
  );
}
