import { useState } from "react";
import type { MetaFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher, useSearchParams } from "react-router";
import { ConfirmDialog } from "../components/confirm-dialog";
import { deletionCopy, dirOf, langOf } from "../lib/deletion-copy";
import { adminCopy, pageTitle } from "../lib/admin-copy";
import { withLang } from "../lib/shell-copy";
import { formatCompact } from "../../../../packages/ui/src/format.ts";
import { roleLabel } from "../../../../packages/ui/src/role-names.ts";
import { LoadErrorBanner } from "../components/load-error-banner";
import { Plus, Pencil, Trash2, Shield, Users } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";
import { AdminLayout } from "../components/admin-layout";
import { requireAuth } from "../lib/auth.server";
import { getAuthServerUrl } from "../lib/config";
import { logger } from "../lib/logger.server";
import {
  createRole,
  deleteRole,
  getRoleUsers,
  isErrorResponse as isRbacError,
  type RoleData,
} from "../lib/rbac-api.server";
import {
  listRoles,
  isErrorResponse,
  type ActingUser,
  type Role,
} from "../lib/admin-api.server";
import { getCloudflare } from "../lib/cloudflare-context";

export const meta: MetaFunction = ({ location }) => {
  const lang = langOf(location.search);
  return [
    { title: pageTitle("roles", lang) },
    { name: "description", content: adminCopy(lang).roles.intro },
  ];
};

interface RoleWithUserCount extends Role {
  user_count: number;
}

interface LoaderData {
  roles: RoleWithUserCount[];
  user: { id: string; email: string } | null;
  authServerUrl: string;
  /** Set when roles could not be fetched, so the page never shows a failure as "no roles". */
  loadError?: string;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getCloudflare(context).env as {
    AUTH_STORAGE: KVNamespace;
    AUTH_SERVER_URL?: string;
    ADMIN_CLIENT_ID?: string;
    ADMIN_CLIENT_SECRET?: string;
  };
  const ctx = getCloudflare(context).ctx as ExecutionContext;

  // Initialize logger
  logger.setDatabase(null, false);
  if (ctx) logger.setContext(ctx);

  // Always require admin authentication
  let currentUser: { id: string; email: string; roles?: string[] };
  try {
    currentUser = await requireAuth(request, env, true) as { id: string; email: string; roles?: string[] };
  } catch (error) {
    // If it's a redirect response (from requireAuth), throw it
    if (error instanceof Response) {
      throw error;
    }
    // If no auth storage available, redirect to login
    throw new Response(null, {
      status: 302,
      headers: {
        Location: "/login",
      },
    });
  }

  const authServerUrl = getAuthServerUrl(request, env);
  const user = { id: currentUser.id, email: currentUser.email };

  // Construct acting user for M2M API calls
  const actingUser: ActingUser = {
    id: currentUser.id,
    email: currentUser.email,
    roles: currentUser.roles || [],
  };

  try {
    // Fetch all roles from auth service (using M2M auth)
    const rolesResponse = await listRoles(env, actingUser, request);

    if (isErrorResponse(rolesResponse)) {
      console.error("Error fetching roles:", rolesResponse.error);
      return { roles: [], user, authServerUrl, loadError: rolesResponse.error };
    }

    // Get user counts for each role via API
    const rolesWithCounts = await Promise.all(
      rolesResponse.map(async (role) => {
        // Call API to get users for this role
        const usersResponse = await getRoleUsers(request, env, role.id);
        const userCount = isRbacError(usersResponse) ? 0 : usersResponse.length;

        return {
          ...role,
          user_count: userCount,
        };
      })
    );

    return { roles: rolesWithCounts, user, authServerUrl };
  } catch (error) {
    console.error("Error loading roles:", error);
    return { roles: [], user, authServerUrl, loadError: error instanceof Error ? error.message : adminCopy(langOf(new URL(request.url).search)).common.actionFailed };
  }
}

export async function action({ request, context }: LoaderFunctionArgs) {
  const env = getCloudflare(context).env as {
    AUTH_STORAGE: KVNamespace;
    AUTH_SERVER_URL?: string;
  };

  // Require admin authentication for actions
  try {
    await requireAuth(request, env, true);
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }
    throw new Response(null, {
      status: 302,
      headers: {
        Location: "/login",
      },
    });
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const copy = adminCopy(langOf(new URL(request.url).search));

  try {
    if (intent === "createRole") {
      const name = formData.get("name") as string;
      const description = formData.get("description") as string;

      if (!name) {
        return { error: copy.roles.nameRequired };
      }

      const roleData: RoleData = {
        name: name.trim(),
        description: description?.trim() || undefined,
      };

      const result = await createRole(request, env, roleData);

      if (isRbacError(result)) {
        return { error: result.error };
      }

      return { success: true };
    }

    if (intent === "deleteRole") {
      const roleId = formData.get("roleId") as string;

      if (!roleId) {
        return { error: copy.roles.missingRole };
      }

      // The API endpoint will check if it's a system role
      // Soft delete: restorable from Recently deleted for 30 days
      const reason = String(formData.get("reason") ?? "").trim() || undefined;
      const result = await deleteRole(request, env, roleId, reason);

      if (isRbacError(result)) {
        return { error: result.error };
      }

      return { success: true };
    }

    return { error: copy.common.unknownAction };
  } catch (error) {
    console.error("Action error:", error);
    return { error: error instanceof Error ? error.message : copy.common.actionFailed };
  }
}

export default function Roles() {
  const { roles, user, authServerUrl, loadError } = useLoaderData<LoaderData>();
  const fetcher = useFetcher();
  const [searchQuery, setSearchQuery] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleDescription, setNewRoleDescription] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [searchParams] = useSearchParams();
  const deleteLang = langOf(searchParams);
  const deleteCopy = deletionCopy(deleteLang);
  const lang = deleteLang;
  const t = adminCopy(lang).roles;
  const c = adminCopy(lang).common;
  const [roleToDelete, setRoleToDelete] = useState<RoleWithUserCount | null>(null);

  const handleCreateRole = () => {
    if (!newRoleName.trim()) {
      return;
    }

    fetcher.submit(
      {
        intent: "createRole",
        name: newRoleName.trim(),
        description: newRoleDescription.trim(),
      },
      { method: "POST" }
    );

    setCreateDialogOpen(false);
    setNewRoleName("");
    setNewRoleDescription("");
  };

  const handleDeleteRole = ({ reason }: { reason: string }) => {
    if (!roleToDelete) return;

    fetcher.submit(
      { intent: "deleteRole", roleId: roleToDelete.id, reason },
      { method: "POST" }
    );

    setDeleteDialogOpen(false);
    setRoleToDelete(null);
  };

  const openDeleteDialog = (role: RoleWithUserCount) => {
    if (role.is_system_role) {
      return; // Should not happen due to disabled button, but extra safety
    }
    setRoleToDelete(role);
    setDeleteDialogOpen(true);
  };

  const filteredRoles = roles.filter((role) =>
    role.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    role.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <AdminLayout user={user} authServerUrl={authServerUrl}>
      <div className="mb-6">
        <h2 className="text-3xl font-bold text-[var(--color-foreground)] mb-2">{t.title}</h2>
        <p className="text-[var(--color-muted-foreground)]">{t.intro}</p>
      </div>

      {fetcher.data?.error && (
        <div role="alert" className="mb-4 p-3 ui-alert-error rounded-lg">{fetcher.data.error}</div>
      )}
      <LoadErrorBanner what={t.what} error={loadError} />
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>{t.cardTitle}</CardTitle>
                <CardDescription>{t.intro}</CardDescription>
              </div>
              <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
                <DialogTrigger asChild>
                  <Button>
                    <Plus className="h-4 w-4 me-2" />
                    {t.create}
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{t.createTitle}</DialogTitle>
                    <DialogDescription>{t.createIntro}</DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                      <Label htmlFor="name">{c.name}</Label>
                      <Input
                        id="name"
                        placeholder={t.namePlaceholder}
                        value={newRoleName}
                        onChange={(e) => setNewRoleName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newRoleName.trim()) {
                            handleCreateRole();
                          }
                        }}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="description">{c.description}</Label>
                      <Input
                        id="description"
                        placeholder={t.descriptionPlaceholder}
                        value={newRoleDescription}
                        onChange={(e) => setNewRoleDescription(e.target.value)}
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
                      {c.cancel}
                    </Button>
                    <Button onClick={handleCreateRole} disabled={!newRoleName.trim()}>
                      {t.create}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </CardHeader>
          <CardContent>
            <div className="mb-4">
              <Input
                placeholder={t.searchPlaceholder}
                aria-label={t.searchLabel}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="max-w-sm"
              />
            </div>

            {loadError && roles.length === 0 ? null : roles.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Shield className="h-12 w-12 text-[var(--color-muted-foreground)] mb-4" />
                <h3 className="text-lg font-semibold mb-2">{t.emptyTitle}</h3>
                <p className="text-sm text-[var(--color-muted-foreground)] mb-4">{t.emptyText}</p>
                <Button onClick={() => setCreateDialogOpen(true)}>
                  <Plus className="h-4 w-4 me-2" />
                  {t.create}
                </Button>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{c.name}</TableHead>
                    <TableHead>{c.description}</TableHead>
                    <TableHead>{t.colType}</TableHead>
                    <TableHead>{t.colUsers}</TableHead>
                    <TableHead className="text-end">{c.actions}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRoles.map((role) => (
                    <TableRow key={role.id}>
                      <TableCell className="font-medium">
                        <Link
                          to={withLang(`/roles/${role.id}`, lang)}
                          className="flex items-center gap-2 hover:underline"
                        >
                          <Shield className="h-4 w-4 text-[var(--color-muted-foreground)]" />
                          <bdi>{roleLabel(role.name, lang)}</bdi>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-[var(--color-muted-foreground)]">
                          {role.description ? <bdi>{role.description}</bdi> : t.noDescription}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant={role.is_system_role ? "default" : "secondary"}>
                          {role.is_system_role ? t.system : t.custom}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Users className="h-4 w-4 text-[var(--color-muted-foreground)]" />
                          <span className="text-sm">{formatCompact(role.user_count, lang)}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-end">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            asChild
                            title={t.edit}
                          >
                            <Link to={withLang(`/roles/${role.id}`, lang)} aria-label={t.editOf(roleLabel(role.name, lang))}>
                              <Pencil className="h-4 w-4" />
                            </Link>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openDeleteDialog(role)}
                            disabled={role.is_system_role}
                            title={role.is_system_role ? t.cannotDelete : t.delete}
                            aria-label={t.deleteOf(roleLabel(role.name, lang))}
                          >
                            <Trash2
                              className={`h-4 w-4 ${
                                role.is_system_role
                                  ? "text-[var(--color-muted-foreground)]"
                                  : "text-[var(--color-destructive-text)]"
                              }`}
                            />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

      {/* Delete confirmation: soft delete, restorable from Recently deleted */}
      <ConfirmDialog
        open={deleteDialogOpen}
        title={deleteCopy.deleteTitle("role")}
        description={
          deleteCopy.deleteBody("role", roleToDelete ? roleLabel(roleToDelete.name, lang) : "") +
          (roleToDelete && roleToDelete.user_count > 0 ? deleteCopy.roleHolders(roleToDelete.user_count) : "")
        }
        confirmLabel={deleteCopy.deleteConfirm}
        cancelLabel={deleteCopy.cancel}
        reason={{ label: deleteCopy.reasonLabel, placeholder: deleteCopy.reasonPlaceholder }}
        dir={dirOf(deleteLang)}
        lang={deleteLang}
        onCancel={() => {
          setDeleteDialogOpen(false);
          setRoleToDelete(null);
        }}
        onConfirm={handleDeleteRole}
      />
    </AdminLayout>
  );
}
