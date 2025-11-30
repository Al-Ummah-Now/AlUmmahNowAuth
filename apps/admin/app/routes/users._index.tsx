import { useState } from "react";
import type { MetaFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher, useRevalidator } from "react-router";
import { ArrowLeft, Plus, Settings, Trash2, Mail, User, LogOut } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";
import { UserRoleBadge } from "../components/user-role-badge";
import { UserRoleManager } from "../components/user-role-manager";
import { requireAuth } from "../lib/auth.server";
import { logger } from "../lib/logger.server";
import {
  getAllRoles,
  assignRoleToUser,
  removeRoleFromUser,
  isErrorResponse,
} from "../lib/rbac-api.server";

export const meta: MetaFunction = () => {
  return [
    { title: "Users - Al Ummah Now Admin" },
    { name: "description", content: "Manage user accounts" },
  ];
};

interface UserWithRoles {
  id: string;
  email: string;
  created_at: string;
  role_names: string | null;
  role_ids: string | null;
}

interface LoaderData {
  users: Array<{
    id: string;
    email: string;
    created_at: string;
    roles: Array<{ id: string; name: string }>;
  }>;
  allRoles: Array<{ id: string; name: string; is_system: boolean; description?: string }>;
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

  // Always require authentication
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
      return { users: [], allRoles: [] };
    }

    // Fetch users with their RBAC roles
    const usersResult = await env.AUTH_DB.prepare(`
      SELECT
        u.id,
        u.email,
        u.created_at,
        GROUP_CONCAT(r.name) as role_names,
        GROUP_CONCAT(r.id) as role_ids
      FROM user u
      LEFT JOIN user_roles ur ON u.id = ur.user_id AND ur.is_active = 1
      LEFT JOIN roles r ON ur.role_id = r.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `).all<UserWithRoles>();

    // Transform the data to split the concatenated role names and IDs
    const users = (usersResult.results || []).map((user) => ({
      id: user.id,
      email: user.email,
      created_at: user.created_at,
      roles: user.role_names && user.role_ids
        ? user.role_names.split(',').map((name, idx) => ({
            name: name.trim(),
            id: user.role_ids!.split(',')[idx].trim(),
          }))
        : [],
    }));

    // Fetch all roles for the role manager
    const rolesResponse = await getAllRoles(request, env);
    const allRoles = isErrorResponse(rolesResponse) ? [] : rolesResponse;

    return { users, allRoles };
  } catch (error) {
    console.error("Error loading users:", error);
    return { users: [], allRoles: [] };
  }
}

export async function action({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as {
    AUTH_DB: D1Database;
    AUTH_STORAGE: KVNamespace;
    AUTH_SERVER_URL?: string;
  };

  // Require authentication for actions
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
    if (intent === "assignRole") {
      const userId = formData.get("userId") as string;
      const roleId = formData.get("roleId") as string;

      if (!userId || !roleId) {
        return { error: "Missing userId or roleId" };
      }

      const result = await assignRoleToUser(request, env, userId, roleId);

      if (isErrorResponse(result)) {
        return { error: result.error };
      }

      return { success: true };
    }

    if (intent === "removeRole") {
      const userId = formData.get("userId") as string;
      const roleId = formData.get("roleId") as string;

      if (!userId || !roleId) {
        return { error: "Missing userId or roleId" };
      }

      const result = await removeRoleFromUser(request, env, userId, roleId);

      if (isErrorResponse(result)) {
        return { error: result.error };
      }

      return { success: true };
    }

    if (intent === "deleteUser") {
      const userId = formData.get("userId") as string;

      if (!userId) {
        return { error: "Missing userId" };
      }

      // Delete user from database
      if (env?.AUTH_DB) {
        await env.AUTH_DB.prepare(`DELETE FROM user WHERE id = ?`)
          .bind(userId)
          .run();
      }

      return { success: true };
    }

    return { error: "Unknown intent" };
  } catch (error) {
    console.error("Action error:", error);
    return { error: error instanceof Error ? error.message : "Action failed" };
  }
}

export default function Users() {
  const { users, allRoles } = useLoaderData<LoaderData>();
  const revalidator = useRevalidator();
  const fetcher = useFetcher();
  const [searchQuery, setSearchQuery] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newUserEmail, setNewUserEmail] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [roleManagerOpen, setRoleManagerOpen] = useState<string | null>(null);

  const handleCreateUser = async () => {
    // TODO: Implement user creation API call with selected roles
    console.info("Creating user:", { email: newUserEmail, roles: selectedRoles });
    setCreateDialogOpen(false);
    setNewUserEmail("");
    setSelectedRoles([]);
  };

  const handleDeleteUser = async (userId: string) => {
    if (confirm("Are you sure you want to delete this user? This action cannot be undone.")) {
      fetcher.submit(
        { intent: "deleteUser", userId },
        { method: "POST" }
      );
    }
  };

  const filteredUsers = users.filter((user) =>
    user.email?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const openRoleManager = (userId: string) => {
    setRoleManagerOpen(userId);
  };

  const closeRoleManager = () => {
    setRoleManagerOpen(null);
    // Revalidate to fetch fresh data
    revalidator.revalidate();
  };

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
                  <h1 className="text-xl font-bold text-[rgb(var(--color-foreground))]">User Management</h1>
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
                <CardTitle>Users</CardTitle>
                <CardDescription>Manage user accounts and RBAC role assignments</CardDescription>
              </div>
              <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
                <DialogTrigger asChild>
                  <Button>
                    <Plus className="h-4 w-4 mr-2" />
                    Create User
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Create New User</DialogTitle>
                    <DialogDescription>
                      Add a new user to the system. They will receive an email to set up their account.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                      <Label htmlFor="email">Email</Label>
                      <Input
                        id="email"
                        type="email"
                        placeholder="user@example.com"
                        value={newUserEmail}
                        onChange={(e) => setNewUserEmail(e.target.value)}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="roles">Initial Roles</Label>
                      <div className="space-y-2">
                        {allRoles.map((role) => (
                          <label key={role.id} className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selectedRoles.includes(role.id)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedRoles([...selectedRoles, role.id]);
                                } else {
                                  setSelectedRoles(selectedRoles.filter((id) => id !== role.id));
                                }
                              }}
                              className="h-4 w-4 rounded border-[rgb(var(--color-input))]"
                            />
                            <span className="text-sm">{role.name}</span>
                            {role.description && (
                              <span className="text-xs text-[rgb(var(--color-muted-foreground))]">
                                - {role.description}
                              </span>
                            )}
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button onClick={handleCreateUser}>Create User</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </CardHeader>
          <CardContent>
            <div className="mb-4">
              <Input
                placeholder="Search users by email..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="max-w-sm"
              />
            </div>

            {users.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <User className="h-12 w-12 text-[rgb(var(--color-muted-foreground))] mb-4" />
                <h3 className="text-lg font-semibold mb-2">No users found</h3>
                <p className="text-sm text-[rgb(var(--color-muted-foreground))] mb-4">
                  Get started by creating your first user account.
                </p>
                <Button onClick={() => setCreateDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create User
                </Button>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>RBAC Roles</TableHead>
                    <TableHead>Created At</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredUsers.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <Mail className="h-4 w-4 text-[rgb(var(--color-muted-foreground))]" />
                          {user.email}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          {user.roles.length === 0 ? (
                            <span className="text-sm text-[rgb(var(--color-muted-foreground))]">
                              No roles
                            </span>
                          ) : (
                            user.roles.map((role) => (
                              <UserRoleBadge key={role.id} role={role.name} />
                            ))
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {new Date(user.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openRoleManager(user.id)}
                            title="Manage Roles"
                          >
                            <Settings className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDeleteUser(user.id)}
                            title="Delete User"
                          >
                            <Trash2 className="h-4 w-4 text-[rgb(var(--color-destructive))]" />
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

      {/* Role Manager Dialogs */}
      {users.map((user) => (
        <UserRoleManager
          key={user.id}
          open={roleManagerOpen === user.id}
          onOpenChange={(open) => {
            if (!open) {
              closeRoleManager();
            }
          }}
          userId={user.id}
          userEmail={user.email}
          currentRoles={user.roles}
          allRoles={allRoles}
        />
      ))}
    </div>
  );
}
