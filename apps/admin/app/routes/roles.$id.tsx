import { useState } from "react";
import { Email } from "../components/email";
import { AdminTime, adminDate, useAdminTime } from "../components/admin-time";
import type { MetaFunction, LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher, useSearchParams } from "react-router";
import { ArrowLeft, Save, Plus, X, Shield, Users, Key, Settings, Trash2 } from "lucide-react";
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
} from "../components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { requireAuth } from "../lib/auth.server";
import { actorLabel, isSystemUserId } from "../lib/system-accounts";
import { langOf } from "../lib/deletion-copy";
import { adminCopy, pageTitle } from "../lib/admin-copy";
import { withLang } from "../lib/shell-copy";
import { roleDescription as describeRole, roleLabel } from "../../../../packages/ui/src/role-names.ts";
import { getAuthServerUrl } from "../lib/config";
import { AdminLayout } from "../components/admin-layout";
import { logger } from "../lib/logger.server";
import { userNames } from "../lib/user-names.server";
import {
  getRoleById,
  updateRole,
  grantPermissionToRole,
  revokePermissionFromRole,
  getAllPermissions,
  getRoleUsers,
  removeUserFromRole,
  isErrorResponse,
  type RoleWithPermissions,
  type Permission,
} from "../lib/rbac-api.server";
import { getCloudflare } from "../lib/cloudflare-context";

export const meta: MetaFunction<typeof loader> = ({ loaderData, location }) => {
  const role = loaderData?.role;
  const lang = langOf(location.search);
  return [
    { title: pageTitle("roles", lang, role?.name ? roleLabel(role.name, lang) : adminCopy(lang).role.fallbackName) },
    { name: "description", content: adminCopy(lang).role.permissionsIntro },
  ];
};

interface UserWithRole {
  id: string;
  email: string;
  assigned_at: number;
  assigned_by: string | null;
}

interface LoaderData {
  user: { id: string; email: string };
  authServerUrl: string;
  role: RoleWithPermissions;
  allPermissions: Record<string, Permission[]>;
  usersWithRole: UserWithRole[];
  names?: Record<string, string>;
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = getCloudflare(context).env as {
    AUTH_STORAGE: KVNamespace;
    AUTH_SERVER_URL?: string;
    AUTH_DB?: D1Database;
  };
  const ctx = getCloudflare(context).ctx as ExecutionContext;

  // Initialize logger
  logger.setDatabase(null, false);
  if (ctx) logger.setContext(ctx);

  // Require authentication
  let user: { id: string; email: string };
  try {
    user = await requireAuth(request, env, true);
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

  const roleId = params.id;
  if (!roleId) {
    throw new Response("Role ID is required", { status: 400 });
  }

  try {
    // Fetch role with permissions
    const roleResponse = await getRoleById(request, env, roleId);
    if (isErrorResponse(roleResponse)) {
      throw new Response(roleResponse.error, { status: 404 });
    }

    // Fetch all permissions grouped by resource
    const permissionsResponse = await getAllPermissions(request, env);
    const allPermissions = isErrorResponse(permissionsResponse)
      ? {}
      : permissionsResponse.permissions;

    // Fetch users with this role via API
    const usersResponse = await getRoleUsers(request, env, roleId);
    // System accounts are never listed (they hold no role; the super admin's Users > System accounts shows them)
    const usersWithRole: UserWithRole[] = isErrorResponse(usersResponse) ? [] : usersResponse.filter((u) => !isSystemUserId(u.id));

    return {
      user: { id: user.id, email: user.email },
      authServerUrl: getAuthServerUrl(request, env),
      role: roleResponse,
      allPermissions,
      usersWithRole,
      // Who assigned the role, by name (never a raw id)
      names: await userNames(env.AUTH_DB, [...usersWithRole.map((u) => u.id), ...usersWithRole.map((u) => u.assigned_by)]),
    };
  } catch (error) {
    console.error("Error loading role:", error);
    if (error instanceof Response) {
      throw error;
    }
    throw new Response("Failed to load role", { status: 500 });
  }
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  const env = getCloudflare(context).env as {
    AUTH_STORAGE: KVNamespace;
    AUTH_SERVER_URL?: string;
  };

  // Require authentication
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

  const copy = adminCopy(langOf(new URL(request.url).search));
  const roleId = params.id;
  if (!roleId) {
    return { error: copy.role.idRequired };
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  try {
    if (intent === "updateRole") {
      const name = formData.get("name") as string;
      const description = formData.get("description") as string;

      if (!name) {
        return { error: copy.role.nameRequired };
      }

      const result = await updateRole(request, env, roleId, {
        name,
        description: description || undefined,
      });

      if (isErrorResponse(result)) {
        return { error: result.error };
      }

      return { success: true, message: "Role updated successfully" };
    }

    if (intent === "addPermission") {
      const permissionId = formData.get("permissionId") as string;

      if (!permissionId) {
        return { error: copy.role.permissionRequired };
      }

      const result = await grantPermissionToRole(request, env, roleId, permissionId);

      if (isErrorResponse(result)) {
        return { error: result.error };
      }

      return { success: true, message: "Permission added successfully" };
    }

    if (intent === "removePermission") {
      const permissionId = formData.get("permissionId") as string;

      if (!permissionId) {
        return { error: copy.role.permissionRequired };
      }

      const result = await revokePermissionFromRole(request, env, roleId, permissionId);

      if (isErrorResponse(result)) {
        return { error: result.error };
      }

      return { success: true, message: "Permission removed successfully" };
    }

    if (intent === "removeUserRole") {
      const userId = formData.get("userId") as string;

      if (!userId) {
        return { error: copy.role.userRequired };
      }

      const result = await removeUserFromRole(request, env, roleId, userId);

      if (isErrorResponse(result)) {
        return { error: result.error };
      }

      return { success: true, message: "Role removed from user successfully" };
    }

    return { error: copy.common.unknownAction };
  } catch (error) {
    console.error("Action error:", error);
    return { error: error instanceof Error ? error.message : copy.common.actionFailed };
  }
}

export default function RoleDetail() {
  const { user, authServerUrl, role, allPermissions, usersWithRole, names = {} } = useLoaderData<LoaderData>();
  const fetcher = useFetcher();
  const [searchParams] = useSearchParams();
  const lang = langOf(searchParams);
  const t = adminCopy(lang).role;
  const stamp = useAdminTime(lang);
  const c = adminCopy(lang).common;
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [addPermissionOpen, setAddPermissionOpen] = useState(false);
  const [roleName, setRoleName] = useState(role.name);
  const [roleDescription, setRoleDescription] = useState(role.description || "");
  const [selectedPermission, setSelectedPermission] = useState("");
  const [permissionToRemove, setPermissionToRemove] = useState<Permission | null>(null);
  const [userToRemove, setUserToRemove] = useState<UserWithRole | null>(null);

  const isSystemRole = role.is_system_role;

  // Group permissions by resource
  const permissionsByResource: Record<string, Permission[]> = {};
  role.permissions.forEach((permission) => {
    if (!permissionsByResource[permission.resource]) {
      permissionsByResource[permission.resource] = [];
    }
    permissionsByResource[permission.resource].push(permission);
  });

  // Get permissions not assigned to this role
  const unassignedPermissions: Record<string, Permission[]> = {};
  Object.entries(allPermissions).forEach(([resource, permissions]) => {
    const assigned = new Set(role.permissions.map(p => p.id));
    const unassigned = permissions.filter(p => !assigned.has(p.id));
    if (unassigned.length > 0) {
      unassignedPermissions[resource] = unassigned;
    }
  });

  const handleUpdateRole = () => {
    if (isSystemRole) return;

    fetcher.submit(
      {
        intent: "updateRole",
        name: roleName,
        description: roleDescription,
      },
      { method: "POST" }
    );
    setEditDialogOpen(false);
  };

  const handleAddPermission = () => {
    if (!selectedPermission) return;

    fetcher.submit(
      {
        intent: "addPermission",
        permissionId: selectedPermission,
      },
      { method: "POST" }
    );
    setAddPermissionOpen(false);
    setSelectedPermission("");
  };

  const handleRemovePermission = () => {
    if (!permissionToRemove) return;

    fetcher.submit(
      {
        intent: "removePermission",
        permissionId: permissionToRemove.id,
      },
      { method: "POST" }
    );
    setPermissionToRemove(null);
  };

  const handleRemoveUserRole = () => {
    if (!userToRemove) return;

    fetcher.submit(
      {
        intent: "removeUserRole",
        userId: userToRemove.id,
      },
      { method: "POST" }
    );
    setUserToRemove(null);
  };

  const getResourceColor = (resource: string) => {
    const colors: Record<string, string> = {
      users: "bg-blue-500/10 text-blue-800 dark:text-blue-300 border-blue-500/30",
      roles: "bg-purple-500/10 text-purple-800 dark:text-purple-300 border-purple-500/30",
      content: "bg-green-500/10 text-green-800 dark:text-green-300 border-green-500/30",
      settings: "bg-orange-500/10 text-orange-800 dark:text-orange-300 border-orange-500/30",
      audit: "bg-red-500/10 text-red-800 dark:text-red-300 border-red-500/30",
      analytics: "bg-cyan-500/10 text-cyan-800 dark:text-cyan-300 border-cyan-500/30",
      system: "bg-gray-500/10 text-gray-800 dark:text-gray-300 border-gray-500/30",
      clients: "bg-indigo-500/10 text-indigo-800 dark:text-indigo-300 border-indigo-500/30",
      "*": "bg-yellow-500/10 text-yellow-800 dark:text-yellow-300 border-yellow-500/30",
    };
    return colors[resource] || "bg-gray-500/10 text-gray-800 dark:text-gray-300 border-gray-500/30";
  };

  return (
    <AdminLayout user={user} authServerUrl={authServerUrl}>
      <Link to={withLang("/roles", lang)} className="mb-4 inline-flex items-center gap-2 text-sm font-medium text-[var(--color-link)] hover:underline">
        <ArrowLeft className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
        {t.back}
      </Link>
      {fetcher.data?.error && (
        <div role="alert" className="mb-4 p-3 ui-alert-error rounded-lg">{fetcher.data.error}</div>
      )}
      <div>
        <div className="space-y-6">
          {/* Role Header */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <Shield className="h-6 w-6 text-[var(--color-link)]" />
                    <CardTitle className="text-2xl"><h2><bdi>{roleLabel(role.name, lang)}</bdi></h2></CardTitle>
                    {isSystemRole && (
                      <Badge variant="outline" className="bg-amber-500/10 text-amber-800 dark:text-amber-300 border-amber-500/30">
                        {t.systemRole}
                      </Badge>
                    )}
                  </div>
                  <CardDescription>
                    {role.description ? <bdi>{describeRole(role.description, lang)}</bdi> : t.noDescription}
                  </CardDescription>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-[var(--color-muted-foreground)]">
                    <span className="whitespace-nowrap">{t.created(stamp(role.created_at, true))}</span>
                    {role.updated_at !== role.created_at && (
                      <span className="whitespace-nowrap">{t.updated(stamp(role.updated_at, true))}</span>
                    )}
                  </div>
                </div>
                {!isSystemRole && (
                  <Button onClick={() => setEditDialogOpen(true)}>
                    <Settings className="h-4 w-4 me-2" />
                    {t.edit}
                  </Button>
                )}
              </div>
            </CardHeader>
          </Card>

          {/* Permissions Section */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Key className="h-5 w-5" />
                    {t.permissions(role.permissions.length)}
                  </CardTitle>
                  <CardDescription>{t.permissionsIntro}</CardDescription>
                </div>
                {!isSystemRole && (
                  <Button onClick={() => setAddPermissionOpen(true)}>
                    <Plus className="h-4 w-4 me-2" />
                    {t.addPermission}
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {isSystemRole && (
                <div className="mb-4 p-4 rounded-md ui-alert-warning">
                  <p className="text-sm">{t.systemNote}</p>
                </div>
              )}

              {role.permissions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Key className="h-12 w-12 text-[var(--color-muted-foreground)] mb-4" />
                  <h3 className="text-lg font-semibold mb-2">{t.noPermissions}</h3>
                  <p className="text-sm text-[var(--color-muted-foreground)] mb-4">{t.noPermissionsText}</p>
                  {!isSystemRole && (
                    <Button onClick={() => setAddPermissionOpen(true)}>
                      <Plus className="h-4 w-4 me-2" />
                      {t.addPermission}
                    </Button>
                  )}
                </div>
              ) : (
                <div className="space-y-6">
                  {Object.entries(permissionsByResource).map(([resource, permissions]) => (
                    <div key={resource} className="space-y-3">
                      <h3 className="text-sm font-semibold text-[var(--color-foreground)]">
                        {t.resources[resource] ?? <bdi dir="ltr">{resource}</bdi>}
                      </h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        {permissions.map((permission) => (
                          <div
                            key={permission.id}
                            className={`flex items-center justify-between p-3 rounded-md border ${getResourceColor(permission.resource)}`}
                          >
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate rtl:text-right" dir="ltr" lang="en">
                                {permission.name}
                              </p>
                              {permission.description && (
                                <p className="text-xs opacity-80 truncate">
                                  <bdi>{permission.description}</bdi>
                                </p>
                              )}
                            </div>
                            {!isSystemRole && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 ms-2 shrink-0"
                                onClick={() => setPermissionToRemove(permission)}
                                title={t.removePermissionOf(permission.name)}
                                aria-label={t.removePermissionOf(permission.name)}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Users Section */}
          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-5 w-5" />
                  {t.users(usersWithRole.length)}
                </CardTitle>
                <CardDescription>{t.usersIntro}</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {usersWithRole.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Users className="h-12 w-12 text-[var(--color-muted-foreground)] mb-4" />
                  <h3 className="text-lg font-semibold mb-2">{t.noUsers}</h3>
                  <p className="text-sm text-[var(--color-muted-foreground)] mb-4">{t.noUsersText}</p>
                  <Button asChild>
                    <Link to={withLang("/users", lang)}>{t.goToUsers}</Link>
                  </Button>
                </div>
              ) : (
                <>
                {/* Phones: one card per person */}
                <ul className="space-y-3 md:hidden" data-testid="role-user-cards">
                  {usersWithRole.map((user) => (
                    <li key={user.id} className="flex items-start justify-between gap-3 rounded-lg border border-[var(--color-border)] p-3 text-sm">
                      <div className="min-w-0 space-y-1">
                        <div className="font-medium"><bdi>{names[user.id] || user.email}</bdi></div>
                        {names[user.id] && <div className="text-xs text-[var(--color-muted-foreground)]"><Email value={user.email} /></div>}
                        <div className="text-xs text-[var(--color-muted-foreground)]">
                          <span className="whitespace-nowrap">{t.colAssigned}: <AdminTime value={user.assigned_at} lang={lang} dateOnly /></span>{c.sep}<span className="whitespace-nowrap">{t.colAssignedBy}: <bdi>{(user.assigned_by && names[user.assigned_by]) || actorLabel(user.assigned_by, lang)}</bdi></span>
                        </div>
                      </div>
                      <Button variant="ghost" size="icon" onClick={() => setUserToRemove(user)} title={t.removeFromUser(user.email)} aria-label={t.removeFromUser(user.email)}>
                        <Trash2 className="h-4 w-4 text-[var(--color-destructive-text)]" />
                      </Button>
                    </li>
                  ))}
                </ul>
                <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.colUser}</TableHead>
                      <TableHead>{t.colAssigned}</TableHead>
                      <TableHead>{t.colAssignedBy}</TableHead>
                      <TableHead className="text-end">{c.actions}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {usersWithRole.map((user) => (
                      <TableRow key={user.id}>
                        <TableCell>
                          <div className="font-medium"><bdi>{names[user.id] || user.email}</bdi></div>
                          {names[user.id] && <div className="text-xs text-[var(--color-muted-foreground)]"><Email value={user.email} /></div>}
                        </TableCell>
                        <TableCell>
                          <AdminTime value={user.assigned_at} lang={lang} dateOnly />
                        </TableCell>
                        <TableCell>
                          <bdi>{(user.assigned_by && names[user.assigned_by]) || actorLabel(user.assigned_by, lang)}</bdi>
                        </TableCell>
                        <TableCell className="text-end">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setUserToRemove(user)}
                            title={t.removeFromUser(user.email)}
                            aria-label={t.removeFromUser(user.email)}
                          >
                            <Trash2 className="h-4 w-4 text-[var(--color-destructive-text)]" />
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
        </div>
      </div>

      {/* Edit Role Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.editTitle}</DialogTitle>
            <DialogDescription>{t.editIntro}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">{c.name}</Label>
              <Input
                id="name"
                value={roleName}
                onChange={(e) => setRoleName(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="description">{c.description}</Label>
              <Input
                id="description"
                value={roleDescription}
                onChange={(e) => setRoleDescription(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              {c.cancel}
            </Button>
            <Button onClick={handleUpdateRole}>
              <Save className="h-4 w-4 me-2" />
              {t.saveChanges}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Permission Dialog */}
      <Dialog open={addPermissionOpen} onOpenChange={setAddPermissionOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t.addTitle}</DialogTitle>
            <DialogDescription>{t.addIntro}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="permission">{t.permission}</Label>
              <Select value={selectedPermission} onValueChange={setSelectedPermission} dir={lang === "ar" ? "rtl" : "ltr"}>
                <SelectTrigger>
                  <SelectValue placeholder={t.selectPermission} />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(unassignedPermissions).map(([resource, permissions]) => (
                    <div key={resource}>
                      <div className="px-2 py-1.5 text-sm font-semibold text-[var(--color-muted-foreground)]">
                        {t.resources[resource] ?? <bdi dir="ltr">{resource}</bdi>}
                      </div>
                      {permissions.map((permission) => (
                        <SelectItem key={permission.id} value={permission.id}>
                          <div>
                            <div className="font-medium rtl:text-right" dir="ltr" lang="en">{permission.name}</div>
                            {permission.description && (
                              <div className="text-xs text-[var(--color-muted-foreground)]">
                                <bdi>{permission.description}</bdi>
                              </div>
                            )}
                          </div>
                        </SelectItem>
                      ))}
                    </div>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddPermissionOpen(false)}>
              {c.cancel}
            </Button>
            <Button onClick={handleAddPermission} disabled={!selectedPermission}>
              <Plus className="h-4 w-4 me-2" />
              {t.addPermission}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Permission Confirmation */}
      <AlertDialog open={!!permissionToRemove} onOpenChange={() => setPermissionToRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.removePermissionTitle}</AlertDialogTitle>
            <AlertDialogDescription>{t.removePermissionBody(permissionToRemove?.name ?? "")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{c.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemovePermission}>{c.remove}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remove User Role Confirmation */}
      <AlertDialog open={!!userToRemove} onOpenChange={() => setUserToRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.removeUserTitle}</AlertDialogTitle>
            <AlertDialogDescription>{t.removeUserBody(roleLabel(role.name, lang), userToRemove?.email ?? "")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{c.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemoveUserRole}>{c.remove}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminLayout>
  );
}
