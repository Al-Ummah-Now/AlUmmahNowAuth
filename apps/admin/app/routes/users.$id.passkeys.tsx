import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useFetcher, useLoaderData } from "react-router";
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

export const meta: MetaFunction = () => [{ title: "Passkeys - Al Ummah Now Admin" }];

/**
 * One user's passkeys (AUTH-PASSKEYS PK4, staff recovery): list, remove
 * (in-app dialog; the user is emailed) and "Send setup link" (one-time, 24 h,
 * never for your own account). Both changes need a sign-in within 15 minutes.
 */
export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as AdminEnv;
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
  const env = context?.cloudflare?.env as AdminEnv;
  const user = await adminUserOf(request, env);
  const userId = String(params.id ?? "");
  requireStepUp(user, request, `/users/${encodeURIComponent(userId)}/passkeys`);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "remove") {
    const result = await removeUserPasskey(env, actingOf(user), userId, String(form.get("credentialId") ?? ""));
    if (isErrorResponse(result)) return { ok: false, error: result.error, notice: null as string | null };
    logger.info("Passkeys: removed by admin", { userId, by: user.id });
    return { ok: true, error: null as string | null, notice: "Passkey removed. The user was emailed." };
  }
  if (intent === "setup-link") {
    const locale = form.get("locale") === "ar" ? "ar" : "en";
    const result = await sendPasskeySetupLink(env, actingOf(user), userId, locale);
    if (isErrorResponse(result)) {
      return { ok: false, error: result.error === "not_for_yourself" ? "Another admin has to send you a setup link." : result.error, notice: null };
    }
    logger.info("Passkeys: setup link sent", { userId, by: user.id, sent: result.sent });
    return {
      ok: true,
      error: result.sent ? null : "The link was created but the email could not be sent. Try again.",
      notice: result.sent ? "Setup link sent. It works once, for 24 hours." : null,
    };
  }
  return { ok: false, error: "Unknown action", notice: null };
}

const fmt = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" }) : "Never");

export default function UserPasskeys() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [removing, setRemoving] = useState<PasskeySummary | null>(null);
  const [locale, setLocale] = useState<"en" | "ar">("en");
  const busy = fetcher.state !== "idle";

  return (
    <AdminLayout user={data.user} authServerUrl={data.authServerUrl} passkeyGraceUntil={data.passkeyGraceUntil}>
      <p className="text-sm mb-2">
        <Link className="underline" to="/users">
          Users
        </Link>
      </p>
      <h1 className="text-2xl font-semibold mb-6">
        Passkeys of <bdi>{data.targetEmail || data.targetId}</bdi>
      </h1>
      <LoadErrorBanner what="the passkeys" error={data.loadError} />
      {fetcher.data?.error && (
        <p className="text-sm text-[var(--color-destructive-text)] mb-4" role="alert">
          {fetcher.data.error}
        </p>
      )}
      {fetcher.data?.notice && (
        <p className="text-sm mb-4" role="status">
          {fetcher.data.notice}
        </p>
      )}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Passkeys</CardTitle>
          <CardDescription>{data.staff ? "Staff account: needs a passkey once staff passkeys are on." : "Not staff."}</CardDescription>
        </CardHeader>
        <CardContent>
          {data.passkeys.length === 0 ? (
            <p data-testid="no-passkeys">No passkeys.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.passkeys.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <bdi>{p.name}</bdi>
                    </TableCell>
                    <TableCell>{p.synced ? "Synced" : "This device only"}</TableCell>
                    <TableCell>{fmt(p.createdAt)}</TableCell>
                    <TableCell>{fmt(p.lastUsedAt)}</TableCell>
                    <TableCell>
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => setRemoving(p)} aria-label={`Remove ${p.name}`}>
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Send a setup link</CardTitle>
          <CardDescription>
            For someone who lost their passkey: a one-time link (24 hours) that lets them add a new passkey after signing in, without the extra emailed code. It is audited and the user is emailed.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          {data.self ? (
            <p className="text-sm">Another admin has to send you a setup link.</p>
          ) : (
            <>
              <label className="text-sm flex items-center gap-2">
                Email language
                <select className="rounded border px-2 py-1 bg-transparent" value={locale} onChange={(e) => setLocale(e.target.value === "ar" ? "ar" : "en")}>
                  <option value="en">English</option>
                  <option value="ar">العربية</option>
                </select>
              </label>
              <Button disabled={busy} data-testid="send-setup-link" onClick={() => fetcher.submit({ intent: "setup-link", locale }, { method: "POST" })}>
                Send setup link
              </Button>
            </>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={removing !== null}
        title="Remove this passkey?"
        description={`"${removing?.name ?? ""}" will no longer sign in to this account. The user is emailed.`}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) fetcher.submit({ intent: "remove", credentialId: removing.id }, { method: "POST" });
          setRemoving(null);
        }}
      />
    </AdminLayout>
  );
}
