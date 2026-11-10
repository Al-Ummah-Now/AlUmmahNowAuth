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

export const meta: MetaFunction = () => [
  { title: "Sign-in themes - Al Ummah Now Admin" },
  { name: "description", content: "Auth's themes for the sign-in pages, profile and admin" },
];

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
  const env = context?.cloudflare?.env as ThemeEnv;
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
  const env = context?.cloudflare?.env as ThemeEnv;
  const actor = await themeActor(request, env);
  const api = themesApi(env, actor, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    switch (intent) {
      case "duplicate": {
        const id = String(form.get("id") ?? "").trim();
        await api.duplicate(String(form.get("from")), id, { en: String(form.get("name_en") ?? "").trim(), ar: String(form.get("name_ar") ?? "").trim() });
        return redirect(`/themes/${encodeURIComponent(id)}`);
      }
      case "set-default":
        await api.setAuthDefault(String(form.get("themeId")));
        return { ok: "Auth default changed. Pages pick it up within a few seconds.", intent };
      case "set-client-default": {
        const themeId = String(form.get("themeId") ?? "");
        await api.setClientDefault(String(form.get("clientId")), themeId || null);
        return { ok: "App default saved.", intent };
      }
      case "delete":
        // Soft delete: restorable from Recently deleted for 30 days
        await api.remove(String(form.get("themeId")), String(form.get("reason") ?? "").trim() || undefined);
        return { ok: "Theme moved to Recently deleted.", intent };
      case "import": {
        const file = form.get("file");
        if (!(file instanceof File) || file.size === 0) return { error: "Choose a theme .zip to import.", intent };
        const summary = await api.importZip(await file.arrayBuffer(), { id: String(form.get("id") ?? "").trim() || undefined, replace: form.get("replace") === "on" });
        return redirect(`/themes/${encodeURIComponent(summary.id)}`);
      }
      default:
        return { error: "Unknown action", intent };
    }
  } catch (error) {
    return { error: errorMessage(error), intent };
  }
}

const STATUS: Record<ThemeSummary["status"], string> = { published: "Published", draft: "Draft", changed: "Unpublished changes" };
const selectClass =
  "flex h-9 w-full rounded-md border border-[rgb(var(--color-border))] bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--color-ring))]";

function ThemeSwatch({ swatches }: { swatches: Swatches | null }) {
  if (!swatches) return <div className="h-28 rounded-t-xl bg-[rgb(var(--color-muted))]" />;
  const half = (s: Swatches["light"], side: "light" | "dark") => (
    <div className="relative flex-1 overflow-hidden" style={{ background: s.background }} aria-label={`${side} colours`}>
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
  const published = themes.filter((t) => t.kind === "builtin" || t.status !== "draft");

  return (
    <AdminLayout user={user} authServerUrl={authServerUrl}>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="mb-2 text-3xl font-bold text-[rgb(var(--color-foreground))]">Sign-in themes</h2>
          <p className="max-w-2xl text-[rgb(var(--color-muted-foreground))]">
            How Auth's pages look: sign-in, register, code entry, password reset, device approval, the account switcher, profile and this admin.
            Apps can ask for any published theme; otherwise they get their own default, then the Auth default.
          </p>
        </div>
        <Button variant="outline" onClick={() => setImportOpen(true)}>
          <Upload /> Import theme
        </Button>
      </div>

      {(error || result?.error) && (
        <div role="alert" className="mb-6 rounded-lg border border-red-500/20 bg-red-500/10 p-4 text-red-500">
          {error ? `Could not load themes: ${error}` : result?.error}
        </div>
      )}
      {result?.ok && (
        <div role="status" className="mb-6 rounded-lg border border-green-500/20 bg-green-500/10 p-4 text-green-600">
          {result.ok}
        </div>
      )}

      <div className="mb-10 grid gap-6 sm:grid-cols-2 xl:grid-cols-3" data-testid="theme-list">
        {themes.map((t) => {
          const inUse = t.isAuthDefault || t.clientIds.length > 0;
          return (
            <Card key={t.id} className="overflow-hidden" data-testid={`theme-${t.id}`}>
              <ThemeSwatch swatches={t.swatches} />
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-lg">
                      <Link to={`/themes/${t.id}`} className="hover:underline">{t.name.en}</Link>
                    </CardTitle>
                    <CardDescription>
                      <span dir="rtl" lang="ar">{t.name.ar}</span> · <code className="text-xs">{t.id}</code>
                      {t.version && <> · v{t.version}</>}
                    </CardDescription>
                  </div>
                  {t.isAuthDefault && (
                    <Badge title="Every app without its own default gets this theme">
                      <Star className="mr-1 h-3 w-3" /> Auth default
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Badge variant="outline">{t.kind === "builtin" ? "Built-in" : "Custom"}</Badge>
                  <Badge variant={t.status === "published" ? "secondary" : "outline"}>{STATUS[t.status]}</Badge>
                  {t.clientIds.length > 0 && <Badge variant="outline">Default for {t.clientIds.length} app{t.clientIds.length > 1 ? "s" : ""}</Badge>}
                </div>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <Link to={`/themes/${t.id}`}>
                    <Palette /> {t.kind === "builtin" ? "View" : "Edit"}
                  </Link>
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDuplicateFrom(t)}>
                  <Copy /> Duplicate
                </Button>
                {!t.isAuthDefault && t.status !== "draft" && (
                  <Form method="post">
                    <input type="hidden" name="intent" value="set-default" />
                    <input type="hidden" name="themeId" value={t.id} />
                    <Button size="sm" variant="outline" type="submit" disabled={busy}>
                      <Star /> Make Auth default
                    </Button>
                  </Form>
                )}
                <Button asChild size="sm" variant="ghost">
                  <a href={`/themes/${t.id}/export?source=${t.status === "draft" ? "draft" : "published"}`} title="Download as a theme package (.zip)">
                    <Download /> Export
                  </a>
                </Button>
                {t.kind === "custom" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    type="button"
                    disabled={busy || inUse}
                    onClick={() => setDeleting(t)}
                    title={inUse ? "In use: change the Auth default and app defaults first" : "Delete this theme"}
                    className="text-red-500"
                  >
                    <Trash2 /> Delete
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>App defaults</CardTitle>
          <CardDescription>
            The theme an app's sign-in pages use when the app doesn't ask for one. Apps without their own default use the Auth default (
            {themes.find((t) => t.id === authDefault)?.name.en ?? authDefault}).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>App</TableHead>
                <TableHead className="w-[45%]">Theme</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.map((c) => (
                <TableRow key={c.id} data-testid={`client-default-${c.id}`}>
                  <TableCell>
                    <div className="font-medium">{c.name}</div>
                    <code className="text-xs text-[rgb(var(--color-muted-foreground))]">{c.id}</code>
                  </TableCell>
                  <TableCell colSpan={2}>
                    <Form method="post" className="flex gap-2">
                      <input type="hidden" name="intent" value="set-client-default" />
                      <input type="hidden" name="clientId" value={c.id} />
                      <select name="themeId" defaultValue={clientDefaults[c.id] ?? ""} className={selectClass} aria-label={`Theme for ${c.name}`}>
                        <option value="">Auth default</option>
                        {published.map((t) => (
                          <option key={t.id} value={t.id}>{t.name.en}</option>
                        ))}
                      </select>
                      <Button type="submit" size="sm" variant="outline" disabled={busy}>Save</Button>
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
            <DialogTitle>Duplicate {duplicateFrom?.name.en}</DialogTitle>
            <DialogDescription>The copy is a draft you can edit; nothing changes on the live pages until you publish it.</DialogDescription>
          </DialogHeader>
          <Form method="post" className="space-y-4" id="duplicate-form">
            <input type="hidden" name="intent" value="duplicate" />
            <input type="hidden" name="from" value={duplicateFrom?.id ?? ""} />
            <div className="space-y-1">
              <Label htmlFor="dup-id">Theme id</Label>
              <Input id="dup-id" name="id" required pattern="[a-z][a-z0-9\-]{1,39}" placeholder="eid-2027" defaultValue={duplicateFrom ? `${duplicateFrom.id}-copy` : ""} />
              <p className="text-xs text-[rgb(var(--color-muted-foreground))]">Lowercase letters, digits and dashes. Apps use it in links (?theme=…).</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="dup-en">Name (English)</Label>
                <Input id="dup-en" name="name_en" required defaultValue={duplicateFrom ? `${duplicateFrom.name.en} copy` : ""} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="dup-ar">Name (Arabic)</Label>
                <Input id="dup-ar" name="name_ar" required dir="rtl" lang="ar" defaultValue={duplicateFrom ? `${duplicateFrom.name.ar} (نسخة)` : ""} />
              </div>
            </div>
          </Form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDuplicateFrom(null)}>Cancel</Button>
            <Button type="submit" form="duplicate-form" disabled={busy}>Duplicate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation: soft delete, restorable from Recently deleted */}
      <ConfirmDialog
        open={deleting !== null}
        title={deleteCopy.deleteTitle("theme")}
        description={deleteCopy.deleteBody("theme", deleting ? deleting.name[deleteLang] || deleting.name.en : "")}
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
            <DialogTitle>Import a theme package</DialogTitle>
            <DialogDescription>A .zip with theme.json and an assets/ folder (theme package format v1). It arrives as a draft.</DialogDescription>
          </DialogHeader>
          <Form method="post" encType="multipart/form-data" className="space-y-4" id="import-form">
            <input type="hidden" name="intent" value="import" />
            <div className="space-y-1">
              <Label htmlFor="import-file">Package</Label>
              <Input id="import-file" name="file" type="file" accept=".zip,application/zip" required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="import-id">Import as id (optional)</Label>
              <Input id="import-id" name="id" pattern="[a-z][a-z0-9\-]{1,39}" placeholder="The id in theme.json" />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="replace" /> Replace the draft of an existing custom theme with this id
            </label>
          </Form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>Cancel</Button>
            <Button type="submit" form="import-form" disabled={busy}>Import</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
