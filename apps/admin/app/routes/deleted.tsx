import { formatDateTime } from "../../../../packages/ui/src/format.ts";
import { pageTitle } from "../lib/admin-copy";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useFetcher, useLoaderData, useSearchParams } from "react-router";
import { RotateCcw, Trash2 } from "lucide-react";
import { AdminLayout } from "../components/admin-layout";
import { ConfirmDialog } from "../components/confirm-dialog";
import { LoadErrorBanner } from "../components/load-error-banner";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { requireAuth } from "../lib/auth.server";
import { getAuthServerUrl } from "../lib/config";
import { logger } from "../lib/logger.server";
import {
  isErrorResponse,
  listDeleted,
  requestPermanentDeletion,
  restoreDeleted,
  type ActingUser,
  type DeletedItem,
  type DeletionKind,
} from "../lib/admin-api.server";
import { daysUntil, deletionCopy, dirOf, langOf, type AdminLang } from "../lib/deletion-copy";
import { getCloudflare } from "../lib/cloudflare-context";

export const meta: MetaFunction = ({ location }) => [{ title: pageTitle("deleted", langOf(location.search)) }];

const KINDS: DeletionKind[] = ["user", "client", "role", "theme"];
const kindOf = (value: string | null): DeletionKind => (KINDS.includes(value as DeletionKind) ? (value as DeletionKind) : "user");

type Env = { AUTH_STORAGE: KVNamespace; AUTH_SERVER_URL?: string; ADMIN_CLIENT_ID?: string; ADMIN_CLIENT_SECRET?: string };

async function actingUserOf(request: Request, env: Env): Promise<ActingUser> {
  let user: { id: string; email: string; roles: string[] };
  try {
    user = (await requireAuth(request, env, true)) as typeof user;
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response(null, { status: 302, headers: { Location: "/login" } });
  }
  return { id: user.id, email: user.email, roles: user.roles || [] };
}

interface LoaderData {
  kind: DeletionKind;
  items: DeletedItem[];
  now: number;
  user: { id: string; email: string };
  authServerUrl: string;
  loadError?: string;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<LoaderData> {
  const env = getCloudflare(context).env as Env;
  const actingUser = await actingUserOf(request, env);
  const kind = kindOf(new URL(request.url).searchParams.get("kind"));
  const base = { kind, user: { id: actingUser.id, email: actingUser.email }, authServerUrl: getAuthServerUrl(request, env) };
  const result = await listDeleted(env, actingUser, kind, request);
  if (isErrorResponse(result)) {
    logger.error("Recently deleted: list failed", { kind, error: result.error });
    return { ...base, items: [], now: Date.now(), loadError: result.error };
  }
  return { ...base, items: result.items, now: result.now };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getCloudflare(context).env as Env;
  const actingUser = await actingUserOf(request, env);
  const form = await request.formData();
  const intent = form.get("intent");
  const kind = kindOf(form.get("kind") as string | null);
  const id = String(form.get("id") ?? "");
  if (!id) return { ok: false, error: "Missing item" };
  const result =
    intent === "restore"
      ? await restoreDeleted(env, actingUser, kind, id)
      : intent === "purge"
        ? await requestPermanentDeletion(env, actingUser, kind, id, String(form.get("confirm") ?? ""))
        : { error: "Unknown action" };
  if (isErrorResponse(result)) return { ok: false, error: result.error };
  logger.info("Recently deleted: action", { intent: String(intent), kind, id, by: actingUser.id });
  return { ok: true, intent: String(intent) };
}

type Pending = { mode: "restore" | "purge"; item: DeletedItem } | null;

function actorName(item: DeletedItem, lang: AdminLang): string {
  const t = deletionCopy(lang);
  if (item.deletedBy === "self") return t.self;
  if (item.deletedBy === "moderation") return t.moderation;
  if (item.deletedBy === "unknown") return t.unknownActor;
  return item.deletedByName || item.deletedByEmail || t.unknownActor;
}

function formatTime(ms: number, lang: AdminLang): string {
  return formatDateTime(ms, lang, { timeZone: "UTC" }) + " UTC";
}

export default function RecentlyDeleted() {
  const { kind, items, now, user, authServerUrl, loadError } = useLoaderData<LoaderData>();
  const [searchParams] = useSearchParams();
  const lang = langOf(searchParams);
  const t = deletionCopy(lang);
  const fetcher = useFetcher<{ ok: boolean; error?: string; intent?: string }>();
  const [pending, setPending] = useState<Pending>(null);
  const busy = fetcher.state !== "idle";
  const done = fetcher.state === "idle" ? fetcher.data : undefined;
  const notice = done?.ok ? (done.intent === "restore" ? t.restored : t.queuedNotice) : null;
  const actionError = done && !done.ok ? done.error ?? null : null;

  const tabHref = (k: DeletionKind) => {
    const q = new URLSearchParams(searchParams);
    q.set("kind", k);
    return `?${q}`;
  };
  // People by name, else email; other items by their label (purge asks to type the label)
  const labelOf = (item: DeletedItem) => item.label ?? item.id;
  const titleOf = (item: DeletedItem) => item.name || labelOf(item);
  const removal = (item: DeletedItem) => (
    <>
      {item.purgeRequestedAt ? (
        <span className="font-medium text-[var(--color-destructive-text)]">{t.queued}</span>
      ) : (
        t.daysLeft(daysUntil(item.purgeAt, now))
      )}
      {item.lastError && <div className="text-xs text-[var(--color-destructive-text)]">{t.lastError(item.lastError)}</div>}
    </>
  );
  const actions = (item: DeletedItem) => (
    <div className="flex flex-wrap justify-end gap-2">
      <Button size="sm" variant="outline" onClick={() => setPending({ mode: "restore", item })}>
        <RotateCcw aria-hidden="true" />
        {t.restore}
      </Button>
      {!item.purgeRequestedAt && (
        <Button size="sm" variant="destructive" onClick={() => setPending({ mode: "purge", item })}>
          <Trash2 aria-hidden="true" />
          {t.deletePermanently}
        </Button>
      )}
    </div>
  );
  const itemCell = (item: DeletedItem) => (
    <>
      <div className="font-medium"><bdi>{titleOf(item)}</bdi></div>
      {item.name && item.label && <div className="text-xs text-[var(--color-muted-foreground)]"><bdi>{item.label}</bdi></div>}
    </>
  );

  return (
    <AdminLayout user={user} authServerUrl={authServerUrl}>
      <div dir={dirOf(lang)} lang={lang} className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t.pageTitle}</h1>
          <p className="text-[var(--color-muted-foreground)]">{t.pageIntro}</p>
        </div>

        <nav aria-label={t.pageTitle} className="flex flex-wrap gap-2">
          {KINDS.map((k) => (
            <Link
              key={k}
              to={tabHref(k)}
              aria-current={k === kind ? "page" : undefined}
              className={
                "rounded-md border px-3 py-1.5 text-sm " +
                (k === kind
                  ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
                  : "border-[var(--color-border)] hover:bg-[var(--color-accent)]")
              }
            >
              {t.tab(k)}
            </Link>
          ))}
        </nav>

        <LoadErrorBanner what={t.pageTitle.toLowerCase()} error={loadError} />
        {notice && (
          <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
            {notice}
          </p>
        )}
        {actionError && (
          <p role="alert" className="text-sm text-[var(--color-destructive-text)]">
            {actionError}
          </p>
        )}

        <Card>
          <CardHeader>
            <CardTitle>{t.tab(kind)}</CardTitle>
            <CardDescription>{items.length === 0 ? t.empty(kind) : null}</CardDescription>
          </CardHeader>
          {items.length > 0 && (
            <CardContent>
              {/* Phone: one card per item, every field labelled; a table from md up */}
              <ul className="space-y-3 md:hidden" data-testid="deleted-cards">
                {items.map((item) => (
                  <li key={item.id} data-testid="deleted-card" className="rounded-lg border border-[var(--color-border)] p-3">
                    {itemCell(item)}
                    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                      <dt className="text-[var(--color-muted-foreground)]">{t.colDeletedBy}</dt>
                      <dd><bdi>{actorName(item, lang)}</bdi></dd>
                      <dt className="text-[var(--color-muted-foreground)]">{t.colDeletedAt}</dt>
                      <dd>{formatTime(item.deletedAt, lang)}</dd>
                      <dt className="text-[var(--color-muted-foreground)]">{t.colReason}</dt>
                      <dd><bdi>{item.reason ?? "—"}</bdi></dd>
                      <dt className="text-[var(--color-muted-foreground)]">{t.colRemoval}</dt>
                      <dd>{removal(item)}</dd>
                    </dl>
                    <div className="mt-3">{actions(item)}</div>
                  </li>
                ))}
              </ul>
              <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.colItem}</TableHead>
                    <TableHead>{t.colDeletedBy}</TableHead>
                    <TableHead>{t.colDeletedAt}</TableHead>
                    <TableHead>{t.colReason}</TableHead>
                    <TableHead>{t.colRemoval}</TableHead>
                    <TableHead className="text-end">{t.colActions}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id} data-testid="deleted-row">
                      <TableCell>{itemCell(item)}</TableCell>
                      <TableCell><bdi>{actorName(item, lang)}</bdi></TableCell>
                      <TableCell>{formatTime(item.deletedAt, lang)}</TableCell>
                      <TableCell><bdi>{item.reason ?? "—"}</bdi></TableCell>
                      <TableCell>{removal(item)}</TableCell>
                      <TableCell>{actions(item)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>
            </CardContent>
          )}
        </Card>
      </div>

      <ConfirmDialog
        open={pending?.mode === "restore"}
        danger={false}
        title={t.restoreTitle(kind)}
        description={pending ? t.restoreBody(labelOf(pending.item)) : ""}
        confirmLabel={t.restoreConfirm}
        cancelLabel={t.cancel}
        busy={busy}
        dir={dirOf(lang)}
        lang={lang}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (!pending) return;
          fetcher.submit({ intent: "restore", kind, id: pending.item.id }, { method: "POST" });
          setPending(null);
        }}
      />
      <ConfirmDialog
        open={pending?.mode === "purge"}
        title={t.purgeTitle}
        description={pending ? t.purgeBody(labelOf(pending.item)) : ""}
        confirmLabel={t.purgeConfirm}
        cancelLabel={t.cancel}
        typeToConfirm={pending ? { expected: labelOf(pending.item), label: t.purgeTypeLabel(labelOf(pending.item)) } : undefined}
        busy={busy}
        dir={dirOf(lang)}
        lang={lang}
        onCancel={() => setPending(null)}
        onConfirm={({ typed }) => {
          if (!pending) return;
          fetcher.submit({ intent: "purge", kind, id: pending.item.id, confirm: typed }, { method: "POST" });
          setPending(null);
        }}
      />
    </AdminLayout>
  );
}
