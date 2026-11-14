import { useState } from "react";
import type { MetaFunction, LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher, useSearchParams } from "react-router";
import { ArrowLeft, Save, Plus, X, Shield, Users, Key, Settings, Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import { formatDate } from "../lib/date-utils";
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
import { logger } from "../lib/logger.server";
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

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const role = data?.role;
  return [
    { title: `${role?.name || 'Role'} - Al Ummah Now Admin` },
    { name: "description", content: "Manage role details and permissions" },
  ];
};

interface UserWithRole {
  id: string;
  email: string;
  assigned_at: number;
  assigned_by: string | null;
}

interface LoaderData {
  role: RoleWithPermissions;
  allPermissions: Record<string, Permission[]>;
  usersWithRole: UserWithRole[];
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as {
    AUTH_STORAGE: KVNamespace;
    AUTH_SERVER_URL?: string;
  };
  const ctx = context?.cloudflare?.ctx as ExecutionContext;

  // Initialize logger
  logger.setDatabase(null, false);
  if (ctx) logger.setContext(ctx);

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
      role: roleResponse,
      allPermissions,
      usersWithRole,
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
  const env = context?.cloudflare?.env as {
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

  const roleId = params.id;
  if (!roleId) {
    return { error: "Role ID is required" };
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  try {
    if (intent === "updateRole") {
      const name = formData.get("name") as string;
      const description = formData.get("description") as string;

      if (!name) {
        return { error: "Role name is required" };
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
        return { error: "Permission ID is required" };
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
        return { error: "Permission ID is required" };
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
        return { error: "User ID is required" };
      }

      const result = await removeUserFromRole(request, env, roleId, userId);

      if (isErrorResponse(result)) {
        return { error: result.error };
      }

      return { success: true, message: "Role removed from user successfully" };
    }

    return { error: "Unknown intent" };
  } catch (error) {
    console.error("Action error:", error);
    return { error: error instanceof Error ? error.message : "Action failed" };
  }
}

export default function RoleDetail() {
  const { role, allPermissions, usersWithRole } = useLoaderData<LoaderData>();
  const fetcher = useFetcher();
  const [searchParams] = useSearchParams();
  const lang = langOf(searchParams);
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
      users: "bg-blue-500/10 text-blue-600 border-blue-500/20",
      roles: "bg-purple-500/10 text-purple-600 border-purple-500/20",
      content: "bg-green-500/10 text-green-600 border-green-500/20",
      settings: "bg-orange-500/10 text-orange-600 border-orange-500/20",
      audit: "bg-red-500/10 text-red-600 border-red-500/20",
      analytics: "bg-cyan-500/10 text-cyan-600 border-cyan-500/20",
      system: "bg-gray-500/10 text-gray-600 border-gray-500/20",
      clients: "bg-indigo-500/10 text-indigo-600 border-indigo-500/20",
      "*": "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
    };
    return colors[resource] || "bg-gray-500/10 text-gray-600 border-gray-500/20";
  };

  return (
    <div className="min-h-screen bg-[rgb(var(--color-background))]">
      {/* Navigation */}
      <nav className="border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-card))]">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" asChild>
                <Link to="/roles">
                  <ArrowLeft className="h-5 w-5" />
                </Link>
              </Button>
              <Link to="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
                <img
                  src="https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png"
                  alt="Al Ummah Now"
                  className="h-10 w-10 rounded-lg"
                />
                <div>
                  <h1 className="text-xl font-bold text-[rgb(var(--color-foreground))]">
                    Role Management
                  </h1>
                  <p className="text-sm text-[rgb(var(--color-muted-foreground))]">
                    Al Ummah Now Admin
                  </p>
                </div>
              </Link>
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        <div className="space-y-6">
          {/* Role Header */}
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <Shield className="h-6 w-6 text-[rgb(var(--color-primary))]" />
                    <CardTitle className="text-2xl">{role.name}</CardTitle>
                    {isSystemRole && (
                      <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/20">
                        System Role
                      </Badge>
                    )}
                  </div>
                  <CardDescription>
                    {role.description || "No description provided"}
                  </CardDescription>
                  <div className="flex items-center gap-4 text-sm text-[rgb(var(--color-muted-foreground))]">
                    <span>Created: {formatDate(role.created_at)}</span>
                    {role.updated_at !== role.created_at && (
                      <span>Updated: {formatDate(role.updated_at)}</span>
                    )}
                  </div>
                </div>
                {!isSystemRole && (
                  <Button onClick={() => setEditDialogOpen(true)}>
                    <Settings className="h-4 w-4 mr-2" />
                    Edit Role
                  </Button>
                )}
              </div>
            </CardHeader>
          </Card>

          {/* Permissions Section */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Key className="h-5 w-5" />
                    Permissions ({role.permissions.length})
                  </CardTitle>
                  <CardDescription>
                    Permissions granted to users with this role
                  </CardDescription>
                </div>
                {!isSystemRole && (
                  <Button onClick={() => setAddPermissionOpen(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    Add Permission
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {isSystemRole && (
                <div className="mb-4 p-4 rounded-md bg-amber-500/10 border border-amber-500/20">
                  <p className="text-sm text-amber-600">
                    This is a system role. Permissions cannot be modified.
                  </p>
                </div>
              )}

              {role.permissions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Key className="h-12 w-12 text-[rgb(var(--color-muted-foreground))] mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No permissions assigned</h3>
                  <p className="text-sm text-[rgb(var(--color-muted-foreground))] mb-4">
                    Add permissions to define what users with this role can do.
                  </p>
                  {!isSystemRole && (
                    <Button onClick={() => setAddPermissionOpen(true)}>
                      <Plus className="h-4 w-4 mr-2" />
                      Add Permission
                    </Button>
                  )}
                </div>
              ) : (
                <div className="space-y-6">
                  {Object.entries(permissionsByResource).map(([resource, permissions]) => (
                    <div key={resource} className="space-y-3">
                      <h3 className="text-sm font-semibold text-[rgb(var(--color-foreground))] uppercase">
                        {resource}
                      </h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        {permissions.map((permission) => (
                          <div
                            key={permission.id}
                            className={`flex items-center justify-between p-3 rounded-md border ${getResourceColor(permission.resource)}`}
                          >
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">
                                {permission.name}
                              </p>
                              {permission.description && (
                                <p className="text-xs opacity-80 truncate">
                                  {permission.description}
                                </p>
                              )}
                            </div>
                            {!isSystemRole && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 ml-2 shrink-0"
                                onClick={() => setPermissionToRemove(permission)}
                                title="Remove permission"
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
                  Users with this Role ({usersWithRole.length})
                </CardTitle>
                <CardDescription>
                  Users who have been assigned this role
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {usersWithRole.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Users className="h-12 w-12 text-[rgb(var(--color-muted-foreground))] mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No users assigned</h3>
                  <p className="text-sm text-[rgb(var(--color-muted-foreground))] mb-4">
                    No users currently have this role assigned.
                  </p>
                  <Button asChild>
                    <Link to="/users">
                      Go to User Management
                    </Link>
                  </Button>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Email</TableHead>
                      <TableHead>Assigned Date</TableHead>
                      <TableHead>Assigned By</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {usersWithRole.map((user) => (
                      <TableRow key={user.id}>
                        <TableCell className="font-medium">{user.email}</TableCell>
                        <TableCell>
                          {formatDate(user.assigned_at)}
                        </TableCell>
                        <TableCell>
                          {actorLabel(user.assigned_by, lang)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setUserToRemove(user)}
                            title="Remove role from user"
                          >
                            <Trash2 className="h-4 w-4 text-[rgb(var(--color-destructive))]" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </main>

      {/* Edit Role Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Role</DialogTitle>
            <DialogDescription>
              Update the role name and description.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={roleName}
                onChange={(e) => setRoleName(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                value={roleDescription}
                onChange={(e) => setRoleDescription(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleUpdateRole}>
              <Save className="h-4 w-4 mr-2" />
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Permission Dialog */}
      <Dialog open={addPermissionOpen} onOpenChange={setAddPermissionOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add Permission</DialogTitle>
            <DialogDescription>
              Grant a new permission to this role.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="permission">Permission</Label>
              <Select value={selectedPermission} onValueChange={setSelectedPermission}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a permission" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(unassignedPermissions).map(([resource, permissions]) => (
                    <div key={resource}>
                      <div className="px-2 py-1.5 text-sm font-semibold text-[rgb(var(--color-muted-foreground))] uppercase">
                        {resource}
                      </div>
                      {permissions.map((permission) => (
                        <SelectItem key={permission.id} value={permission.id}>
                          <div>
                            <div className="font-medium">{permission.name}</div>
                            {permission.description && (
                              <div className="text-xs text-[rgb(var(--color-muted-foreground))]">
                                {permission.description}
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
              Cancel
            </Button>
            <Button onClick={handleAddPermission} disabled={!selectedPermission}>
              <Plus className="h-4 w-4 mr-2" />
              Add Permission
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Permission Confirmation */}
      <AlertDialog open={!!permissionToRemove} onOpenChange={() => setPermissionToRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Permission</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove the permission "{permissionToRemove?.name}" from this role?
              Users with this role will lose access to this permission.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemovePermission}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remove User Role Confirmation */}
      <AlertDialog open={!!userToRemove} onOpenChange={() => setUserToRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Role from User</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove the role "{role.name}" from user "{userToRemove?.email}"?
              This will revoke all permissions granted by this role.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemoveUserRole}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
