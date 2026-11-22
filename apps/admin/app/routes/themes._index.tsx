import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation, useSearchParams, useSubmit } from "react-router";
import { ConfirmDialog } from "../components/confirm-dialog";
import { deletionCopy, dirOf, langOf } from "../lib/deletion-copy";
import { useState } from "react";
import { Copy, Download, Palette, Star, Trash2, Upload } from "lucide-react";
import { AdminLayout } from "../components/admin-layout";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { listClients, isErrorResponse } from "../lib/admin-api.server";
import { getAuthenticatedUser } from "../lib/auth.server";
import { getAuthServerUrl } from "../lib/config";
import { errorMessage, themeActor, themesApi, type ThemeEnv, type ThemeSummary } from "../lib/themes.server";
import { swatchesOf, type Swatches } from "../lib/theme-builder";
import { getCloudflare } from "../lib/cloudflare-context";
import { adminCopy, pageTitle } from "../lib/admin-copy";
import { withLang } from "../lib/shell-copy";

export const meta: MetaFunction = ({ location }) => {
  const lang = langOf(location.search);
  return [
    { title: pageTitle("themes", lang) },
    { name: "description", content: adminCopy(lang).themes.intro },
  ];
};

type LoaderData = {
  themes: (ThemeSummary & { swatches: Swatches | null })[];
  authDefault: string;
  clientDefaults: Record<string, string>;
  clients: { id: string; name: string }[];
  user: { id: string; email: string };
  authServerUrl: string;
  error?: string;
};

export async function loader({ request, context }: LoaderFunctionArgs): Promise<LoaderData> {
  const env = getCloudflare(context).env as ThemeEnv;
  const actor = await themeActor(request, env);
  const session = await getAuthenticatedUser(request, env);
  const user = { id: actor.id, email: session?.user.email ?? actor.email };
  const authServerUrl = getAuthServerUrl(request, env);
  const api = themesApi(env, actor, request);
  try {
    const [list, clients] = await Promise.all([api.list(), listClients(env, actor)]);
    const details = await Promise.all(list.themes.map((t) => api.get(t.id).catch(() => null)));
    return {
      themes: list.themes.map((t, i) => ({ ...t, swatches: details[i] ? swatchesOf(details[i]!.theme) : null })),
      authDefault: list.authDefault,
      clientDefaults: list.clientDefaults,
      clients: isErrorResponse(clients) ? [] : clients.clients.map((c) => ({ id: c.client_id ?? c.id, name: c.name })),
      user,
      authServerUrl,
    };
  } catch (error) {
    return { themes: [], authDefault: "fawanees", clientDefaults: {}, clients: [], user, authServerUrl, error: errorMessage(error) };
  }
}

type ActionData = { ok?: string; error?: string; intent?: string };

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionData | Response> {
  const env = getCloudflare(context).env as ThemeEnv;
  const actor = await themeActor(request, env);
  const api = themesApi(env, actor, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const lang = langOf(new URL(request.url).search);
  const words = adminCopy(lang);
  try {
    switch (intent) {
      case "duplicate": {
        const id = String(form.get("id") ?? "").trim();
        await api.duplicate(String(form.get("from")), id, { en: String(form.get("name_en") ?? "").trim(), ar: String(form.get("name_ar") ?? "").trim() });
        return redirect(withLang(`/themes/${encodeURIComponent(id)}`, lang));
      }
      case "set-default":
        await api.setAuthDefault(String(form.get("themeId")));
        return { ok: words.themes.defaultChanged, intent };
      case "set-client-default": {
        const themeId = String(form.get("themeId") ?? "");
        await api.setClientDefault(String(form.get("clientId")), themeId || null);
        return { ok: words.themes.appDefaultSaved, intent };
      }
      case "delete":
        // Soft delete: restorable from Recently deleted for 30 days
        await api.remove(String(form.get("themeId")), String(form.get("reason") ?? "").trim() || undefined);
        return { ok: words.themes.deleted, intent };
      case "import": {
        const file = form.get("file");
        if (!(file instanceof File) || file.size === 0) return { error: words.themes.chooseZip, intent };
        const summary = await api.importZip(await file.arrayBuffer(), { id: String(form.get("id") ?? "").trim() || undefined, replace: form.get("replace") === "on" });
        return redirect(withLang(`/themes/${encodeURIComponent(summary.id)}`, lang));
      }
      default:
        return { error: words.common.unknownAction, intent };
    }
  } catch (error) {
    return { error: errorMessage(error), intent };
  }
}

const selectClass =
  "flex h-9 w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ring)]";

function ThemeSwatch({ swatches, label }: { swatches: Swatches | null; label: (side: "light" | "dark") => string }) {
  if (!swatches) return <div className="h-28 rounded-t-xl bg-[var(--color-muted)]" />;
  const half = (s: Swatches["light"], side: "light" | "dark") => (
    <div className="relative flex-1 overflow-hidden" style={{ background: s.background }} aria-label={label(side)}>
      <div className="absolute inset-x-4 top-4 bottom-0 rounded-t-lg shadow-lg" style={{ background: s.card, borderTop: `3px solid ${s.primary}` }}>
        <div className="mx-3 mt-3 h-2 w-2/3 rounded" style={{ background: s.text, opacity: 0.85 }} />
        <div className="mx-3 mt-2 h-4 rounded" style={{ background: s.input }} />
        <div className="mx-3 mt-2 h-4 rounded" style={{ background: s.primary }} />
      </div>
    </div>
  );
  return (
    <div className="flex h-28 overflow-hidden rounded-t-xl" aria-hidden="true">
      {half(swatches.light, "light")}
      {half(swatches.dark, "dark")}
    </div>
  );
}

export default function ThemesPage() {
  const { themes, authDefault, clientDefaults, clients, user, authServerUrl, error } = useLoaderData<LoaderData>();
  const result = useActionData<ActionData>();
  const busy = useNavigation().state !== "idle";
  const [duplicateFrom, setDuplicateFrom] = useState<ThemeSummary | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleting, setDeleting] = useState<ThemeSummary | null>(null);
  const submit = useSubmit();
  const [searchParams] = useSearchParams();
  const deleteLang = langOf(searchParams);
  const deleteCopy = deletionCopy(deleteLang);
  const lang = deleteLang;
  const t = adminCopy(lang).themes;
  const words = adminCopy(lang).common;
  const nameOf = (th: { name: { en: string; ar: string } }) => th.name[lang] || th.name.en;
  const published = themes.filter((t) => t.kind === "builtin" || t.status !== "draft");

  return (
    <AdminLayout user={user} authServerUrl={authServerUrl}>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="mb-2 text-3xl font-bold text-[var(--color-foreground)]">{t.title}</h2>
          <p className="max-w-2xl text-[var(--color-muted-foreground)]">{t.intro}</p>
        </div>
        <Button variant="outline" onClick={() => setImportOpen(true)}>
          <Upload /> {t.importTheme}
        </Button>
      </div>

      {(error || result?.error) && (
        <div role="alert" className="mb-6 rounded-lg ui-alert-error p-4">
          {error ? t.loadError(error) : result?.error}
        </div>
      )}
      {result?.ok && (
        <div role="status" className="mb-6 rounded-lg ui-alert-success p-4">
          {result.ok}
        </div>
      )}

      <div className="mb-10 grid gap-6 sm:grid-cols-2 xl:grid-cols-3" data-testid="theme-list">
        {themes.map((th) => {
          const inUse = th.isAuthDefault || th.clientIds.length > 0;
          return (
            <Card key={th.id} className="overflow-hidden" data-testid={`theme-${th.id}`}>
              <ThemeSwatch swatches={th.swatches} label={t.swatch} />
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-lg">
                      <Link to={withLang(`/themes/${th.id}`, lang)} className="hover:underline">{nameOf(th)}</Link>
                    </CardTitle>
                    <CardDescription>
                      {lang === "ar" ? <span dir="ltr" lang="en">{th.name.en}</span> : <span dir="rtl" lang="ar">{th.name.ar}</span>}{words.sep}<code className="text-xs" dir="ltr">{th.id}</code>
                      {th.version && <>{words.sep}<span dir="ltr">v{th.version}</span></>}
                    </CardDescription>
                  </div>
                  {th.isAuthDefault && (
                    <Badge title={t.authDefaultTitle}>
                      <Star className="me-1 h-3 w-3" /> {t.authDefault}
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Badge variant="outline">{th.kind === "builtin" ? t.builtIn : t.custom}</Badge>
                  <Badge variant={th.status === "published" ? "secondary" : "outline"}>{t.status[th.status]}</Badge>
                  {th.clientIds.length > 0 && <Badge variant="outline">{t.defaultFor(th.clientIds.length)}</Badge>}
                </div>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <Link to={withLang(`/themes/${th.id}`, lang)}>
                    <Palette /> {th.kind === "builtin" ? t.view : t.edit}
                  </Link>
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDuplicateFrom(th)}>
                  <Copy /> {t.duplicate}
                </Button>
                {!th.isAuthDefault && th.status !== "draft" && (
                  <Form method="post">
                    <input type="hidden" name="intent" value="set-default" />
                    <input type="hidden" name="themeId" value={th.id} />
                    <Button size="sm" variant="outline" type="submit" disabled={busy}>
                      <Star /> {t.makeDefault}
                    </Button>
                  </Form>
                )}
                <Button asChild size="sm" variant="ghost">
                  <a href={`/themes/${th.id}/export?source=${th.status === "draft" ? "draft" : "published"}`} title={t.exportTitle}>
                    <Download /> {t.export}
                  </a>
                </Button>
                {th.kind === "custom" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    type="button"
                    disabled={busy || inUse}
                    onClick={() => setDeleting(th)}
                    title={inUse ? t.inUse : t.deleteTitle}
                    className="text-[var(--color-destructive-text)]"
                  >
                    <Trash2 /> {t.delete}
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t.appDefaults}</CardTitle>
          <CardDescription>
            {t.appDefaultsIntro((() => { const d = themes.find((x) => x.id === authDefault); return d ? nameOf(d) : authDefault; })())}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.colApp}</TableHead>
                <TableHead className="w-[45%]">{t.colTheme}</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.map((c) => (
                <TableRow key={c.id} data-testid={`client-default-${c.id}`}>
                  <TableCell>
                    <div className="font-medium"><bdi>{c.name}</bdi></div>
                    <code className="text-xs text-[var(--color-muted-foreground)]" dir="ltr">{c.id}</code>
                  </TableCell>
                  <TableCell colSpan={2}>
                    <Form method="post" className="flex gap-2">
                      <input type="hidden" name="intent" value="set-client-default" />
                      <input type="hidden" name="clientId" value={c.id} />
                      <select name="themeId" defaultValue={clientDefaults[c.id] ?? ""} className={selectClass} aria-label={t.themeFor(c.name)}>
                        <option value="">{t.authDefault}</option>
                        {published.map((x) => (
                          <option key={x.id} value={x.id}>{nameOf(x)}</option>
                        ))}
                      </select>
                      <Button type="submit" size="sm" variant="outline" disabled={busy}>{words.save}</Button>
                    </Form>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!duplicateFrom} onOpenChange={(open) => !open && setDuplicateFrom(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.duplicateTitle(duplicateFrom ? nameOf(duplicateFrom) : "")}</DialogTitle>
            <DialogDescription>{t.duplicateIntro}</DialogDescription>
          </DialogHeader>
          <Form method="post" className="space-y-4" id="duplicate-form">
            <input type="hidden" name="intent" value="duplicate" />
            <input type="hidden" name="from" value={duplicateFrom?.id ?? ""} />
            <div className="space-y-1">
              <Label htmlFor="dup-id">{t.themeId}</Label>
              <Input id="dup-id" name="id" required pattern="[a-z][a-z0-9\-]{1,39}" placeholder="eid-2027" dir="ltr" defaultValue={duplicateFrom ? `${duplicateFrom.id}-copy` : ""} />
              <p className="text-xs text-[var(--color-muted-foreground)]">{t.themeIdHelp}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="dup-en">{t.nameEn}</Label>
                <Input id="dup-en" name="name_en" required dir="ltr" lang="en" defaultValue={duplicateFrom ? `${duplicateFrom.name.en} copy` : ""} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="dup-ar">{t.nameAr}</Label>
                <Input id="dup-ar" name="name_ar" required dir="rtl" lang="ar" defaultValue={duplicateFrom ? `${duplicateFrom.name.ar} (نسخة)` : ""} />
              </div>
            </div>
          </Form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDuplicateFrom(null)}>{words.cancel}</Button>
            <Button type="submit" form="duplicate-form" disabled={busy}>{t.duplicate}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation: soft delete, restorable from Recently deleted */}
      <ConfirmDialog
        open={deleting !== null}
        title={deleteCopy.deleteTitle("theme")}
        description={deleteCopy.deleteBody("theme", deleting ? nameOf(deleting) : "")}
        confirmLabel={deleteCopy.deleteConfirm}
        cancelLabel={deleteCopy.cancel}
        reason={{ label: deleteCopy.reasonLabel, placeholder: deleteCopy.reasonPlaceholder }}
        busy={busy}
        dir={dirOf(deleteLang)}
        lang={deleteLang}
        onCancel={() => setDeleting(null)}
        onConfirm={({ reason }) => {
          if (!deleting) return;
          submit({ intent: "delete", themeId: deleting.id, reason }, { method: "post" });
          setDeleting(null);
        }}
      />

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.importTitle}</DialogTitle>
            <DialogDescription>{t.importIntro}</DialogDescription>
          </DialogHeader>
          <Form method="post" encType="multipart/form-data" className="space-y-4" id="import-form">
            <input type="hidden" name="intent" value="import" />
            <div className="space-y-1">
              <Label htmlFor="import-file">{t.package}</Label>
              <Input id="import-file" name="file" type="file" accept=".zip,application/zip" required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="import-id">{t.importAs}</Label>
              <Input id="import-id" name="id" pattern="[a-z][a-z0-9\-]{1,39}" placeholder={t.importAsPlaceholder} dir="ltr" />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="replace" /> {t.replaceDraft}
            </label>
          </Form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>{words.cancel}</Button>
            <Button type="submit" form="import-form" disabled={busy}>{t.import}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
