import { useState } from "react";
import type { MetaFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { ArrowLeft, Plus, Pencil, Trash2, Shield, Users, LogOut } from "lucide-react";
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
import { logger } from "../lib/logger.server";
import {
  getAllRoles,
  createRole,
  deleteRole,
  isErrorResponse,
  type Role,
  type RoleData,
} from "../lib/rbac-api.server";

export const meta: MetaFunction = () => {
  return [
    { title: "Roles - Al Ummah Now Admin" },
    { name: "description", content: "Manage RBAC roles and permissions" },
  ];
};

interface RoleWithUserCount extends Role {
  user_count: number;
}

interface LoaderData {
  roles: RoleWithUserCount[];
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as {
    AUTH_DB: D1Database;
    AUTH_STORAGE: KVNamespace;
    AUTH_SERVER_URL?: string;
  };
  const ctx = context?.cloudflare?.ctx as ExecutionContext;

  // Initialize logger
  if (env?.AUTH_DB) {
    logger.setDatabase(env.AUTH_DB, true);
    if (ctx) logger.setContext(ctx);
  }

  // Always require admin authentication
  try {
    await requireAuth(request, env, true);
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

  try {
    if (!env?.AUTH_DB) {
      console.warn("AUTH_DB not available in development mode");
      return { roles: [] };
    }

    // Fetch all roles from auth service
    const rolesResponse = await getAllRoles(request, env);

    if (isErrorResponse(rolesResponse)) {
      console.error("Error fetching roles:", rolesResponse.error);
      return { roles: [] };
    }

    // Get user counts for each role
    const rolesWithCounts = await Promise.all(
      rolesResponse.map(async (role) => {
        const countResult = await env.AUTH_DB.prepare(`
          SELECT COUNT(*) as count
          FROM user_roles
          WHERE role_id = ? AND is_active = 1
        `).bind(role.id).first<{ count: number }>();

        return {
          ...role,
          user_count: countResult?.count || 0,
        };
      })
    );

    return { roles: rolesWithCounts };
  } catch (error) {
    console.error("Error loading roles:", error);
    return { roles: [] };
  }
}

export async function action({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as {
    AUTH_DB: D1Database;
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

  try {
    if (intent === "createRole") {
      const name = formData.get("name") as string;
      const description = formData.get("description") as string;

      if (!name) {
        return { error: "Role name is required" };
      }

      const roleData: RoleData = {
        name: name.trim(),
        description: description?.trim() || undefined,
      };

      const result = await createRole(request, env, roleData);

      if (isErrorResponse(result)) {
        return { error: result.error };
      }

      return { success: true };
    }

    if (intent === "deleteRole") {
      const roleId = formData.get("roleId") as string;

      if (!roleId) {
        return { error: "Missing roleId" };
      }

      // Check if role is system role (additional safety check)
      if (env?.AUTH_DB) {
        const role = await env.AUTH_DB.prepare(`
          SELECT is_system FROM roles WHERE id = ?
        `).bind(roleId).first<{ is_system: number }>();

        if (role?.is_system) {
          return { error: "Cannot delete system roles" };
        }
      }

      const result = await deleteRole(request, env, roleId);

      if (isErrorResponse(result)) {
        return { error: result.error };
      }

      return { success: true };
    }

    return { error: "Unknown intent" };
  } catch (error) {
    console.error("Action error:", error);
    return { error: error instanceof Error ? error.message : "Action failed" };
  }
}

export default function Roles() {
  const { roles } = useLoaderData<LoaderData>();
  const fetcher = useFetcher();
  const [searchQuery, setSearchQuery] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleDescription, setNewRoleDescription] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
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

  const handleDeleteRole = () => {
    if (!roleToDelete) return;

    fetcher.submit(
      { intent: "deleteRole", roleId: roleToDelete.id },
      { method: "POST" }
    );

    setDeleteDialogOpen(false);
    setRoleToDelete(null);
  };

  const openDeleteDialog = (role: RoleWithUserCount) => {
    if (role.is_system) {
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
    <div className="min-h-screen bg-[rgb(var(--color-background))]">
      {/* Navigation */}
      <nav className="border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-card))]">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" asChild>
                <Link to="/">
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
                  <h1 className="text-xl font-bold text-[rgb(var(--color-foreground))]">Role Management</h1>
                  <p className="text-sm text-[rgb(var(--color-muted-foreground))]">Al Ummah Now Admin</p>
                </div>
              </Link>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" asChild>
                <Link to="/logout">
                  <LogOut className="h-5 w-5" />
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Roles</CardTitle>
                <CardDescription>Manage RBAC roles and permission assignments</CardDescription>
              </div>
              <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
                <DialogTrigger asChild>
                  <Button>
                    <Plus className="h-4 w-4 mr-2" />
                    Create Role
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Create New Role</DialogTitle>
                    <DialogDescription>
                      Add a new role to the RBAC system. You can assign permissions to this role later.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                      <Label htmlFor="name">Name</Label>
                      <Input
                        id="name"
                        placeholder="e.g., Content Manager"
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
                      <Label htmlFor="description">Description</Label>
                      <Input
                        id="description"
                        placeholder="Optional description of role responsibilities"
                        value={newRoleDescription}
                        onChange={(e) => setNewRoleDescription(e.target.value)}
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button onClick={handleCreateRole} disabled={!newRoleName.trim()}>
                      Create Role
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </CardHeader>
          <CardContent>
            <div className="mb-4">
              <Input
                placeholder="Search roles by name or description..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="max-w-sm"
              />
            </div>

            {roles.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Shield className="h-12 w-12 text-[rgb(var(--color-muted-foreground))] mb-4" />
                <h3 className="text-lg font-semibold mb-2">No roles found</h3>
                <p className="text-sm text-[rgb(var(--color-muted-foreground))] mb-4">
                  Get started by creating your first role.
                </p>
                <Button onClick={() => setCreateDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create Role
                </Button>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Users</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRoles.map((role) => (
                    <TableRow key={role.id}>
                      <TableCell className="font-medium">
                        <Link
                          to={`/roles/${role.id}`}
                          className="flex items-center gap-2 hover:underline"
                        >
                          <Shield className="h-4 w-4 text-[rgb(var(--color-muted-foreground))]" />
                          {role.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-[rgb(var(--color-muted-foreground))]">
                          {role.description || "No description"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant={role.is_system ? "default" : "secondary"}>
                          {role.is_system ? "System" : "Custom"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Users className="h-4 w-4 text-[rgb(var(--color-muted-foreground))]" />
                          <span className="text-sm">{role.user_count}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            asChild
                            title="Edit Role"
                          >
                            <Link to={`/roles/${role.id}`}>
                              <Pencil className="h-4 w-4" />
                            </Link>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openDeleteDialog(role)}
                            disabled={role.is_system}
                            title={role.is_system ? "Cannot delete system roles" : "Delete Role"}
                          >
                            <Trash2
                              className={`h-4 w-4 ${
                                role.is_system
                                  ? "text-[rgb(var(--color-muted-foreground))]"
                                  : "text-[rgb(var(--color-destructive))]"
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
      </main>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Role</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the role "{roleToDelete?.name}"?
              {roleToDelete && roleToDelete.user_count > 0 && (
                <span className="block mt-2 font-semibold text-[rgb(var(--color-destructive))]">
                  Warning: This role is currently assigned to {roleToDelete.user_count} user(s).
                </span>
              )}
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setRoleToDelete(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteRole}
              className="bg-[rgb(var(--color-destructive))] text-[rgb(var(--color-destructive-foreground))] hover:bg-[rgb(var(--color-destructive))]/90"
            >
              Delete Role
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
