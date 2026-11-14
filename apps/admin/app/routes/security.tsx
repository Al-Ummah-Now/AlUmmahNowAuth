import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useFetcher, useLoaderData } from "react-router";
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

export const meta: MetaFunction = () => [{ title: "Security - Al Ummah Now Admin" }];

/**
 * Staff passkeys (AUTH-PASSKEYS): the admin-managed enforcement switch.
 * Super Admins only; switching on needs a passkey of your own (so nobody locks
 * themselves out) and a sign-in within 15 minutes. Existing staff get 7 days.
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as AdminEnv;
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
  const env = context?.cloudflare?.env as AdminEnv;
  const user = await adminUserOf(request, env);
  // High-risk: a fresh sign-in first (AD5)
  requireStepUp(user, request, "/security");
  const form = await request.formData();
  const enforced = form.get("enforced") === "true";
  const result = await setStaffPasskeyEnforcement(env, actingOf(user), enforced);
  if (isErrorResponse(result)) {
    const message =
      result.error === "actor_needs_passkey"
        ? "Add a passkey to your own account first, so you can still sign in once this is on."
        : result.error === "super_admin_only"
          ? "Only a Super Admin can change this."
          : result.error;
    return { ok: false, error: message };
  }
  logger.info("Security: staff passkey enforcement changed", { enforced, by: user.id });
  return { ok: true, error: null as string | null };
}

const fmt = (ms: number) => new Date(ms).toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }) + " UTC";

export default function Security() {
  const { user, authServerUrl, settings, loadError, canChange, passkeyGraceUntil } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
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
      <h1 className="text-2xl font-semibold mb-6">Security</h1>
      <LoadErrorBanner what="the security settings" error={loadError} />
      {settings && (
        <Card>
          <CardHeader>
            <CardTitle>Staff passkeys</CardTitle>
            <CardDescription>
              Staff (Super Admin, Admin, Moderator, Writer, reviewers) sign in to the admin tools with a passkey. Staff who already have a staff role
              when this is switched on get {settings.graceDays} days; anyone made staff later needs one at once.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p data-testid="staff-passkeys-state">
              {settings.enforced ? (
                <>
                  <strong>On</strong> since {fmt(settings.enforcedAt!)}. Grace for existing staff ends {fmt(graceEnd!)}.
                </>
              ) : (
                <>
                  <strong>Off.</strong> Anyone can add a passkey; nobody is required to.
                </>
              )}
            </p>
            <p>
              Staff: {settings.staff}
              {settings.capped ? "+" : ""}. Without a passkey: {settings.withoutPasskey.length}.
            </p>
            {settings.withoutPasskey.length > 0 && (
              <ul className="list-disc ps-6 text-sm" data-testid="staff-without-passkey">
                {settings.withoutPasskey.slice(0, 50).map((s) => (
                  <li key={s.id}>
                    <Link className="underline" to={`/users/${encodeURIComponent(s.id)}/passkeys`}>
                      <bdi>{s.email}</bdi>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {!settings.actorHasPasskey && (
              <p className="text-sm" role="note">
                You have no passkey yet. Add one from your account before switching this on.
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
                  Switch off
                </Button>
              ) : (
                <Button disabled={busy || !settings.actorHasPasskey} onClick={() => setConfirming(true)} data-testid="staff-passkeys-on">
                  Switch on
                </Button>
              )
            ) : (
              <p className="text-sm">Only a Super Admin can change this.</p>
            )}
          </CardContent>
        </Card>
      )}
      <ConfirmDialog
        open={confirming !== null}
        title={confirming ? "Require passkeys for staff?" : "Stop requiring passkeys?"}
        description={
          confirming
            ? `Existing staff get ${settings?.graceDays ?? 7} days. New staff need a passkey at once. Staff without one will see "Passkey needed" in the admin tools after that.`
            : "Staff can sign in to the admin tools with a password again."
        }
        confirmLabel={confirming ? "Switch on" : "Switch off"}
        cancelLabel="Cancel"
        danger={!confirming}
        onCancel={() => setConfirming(null)}
        onConfirm={() => submit(!!confirming)}
      />
    </AdminLayout>
  );
}
