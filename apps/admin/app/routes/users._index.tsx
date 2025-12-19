import { useState } from "react";
import type { MetaFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
import { Plus, Settings, Trash2, Mail, User, Pencil } from "lucide-react";
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
import { AdminLayout } from "../components/admin-layout";
import { requireAuth } from "../lib/auth.server";
import { getAuthServerUrl } from "../lib/config";
import { logger } from "../lib/logger.server";
import {
  getAllRoles,
  assignRoleToUser,
  removeRoleFromUser,
  isErrorResponse as isRbacError,
} from "../lib/rbac-api.server";
import {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  assignUserRole,
  isErrorResponse,
  type ActingUser,
} from "../lib/admin-api.server";

export const meta: MetaFunction = () => {
  return [
    { title: "Users - Al Ummah Now Admin" },
    { name: "description", content: "Manage user accounts" },
  ];
};

interface LoaderData {
  users: Array<{
    id: string;
    email: string;
    created_at: string;
    roles: Array<{ id: string; name: string }>;
  }>;
  allRoles: Array<{ id: string; name: string; is_system: boolean; description?: string }>;
  user: { id: string; email: string } | null;
  authServerUrl: string;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as {
    AUTH_STORAGE: KVNamespace;
    AUTH_SERVER_URL?: string;
    ADMIN_CLIENT_ID?: string;
    ADMIN_CLIENT_SECRET?: string;
  };
  const ctx = context?.cloudflare?.ctx as ExecutionContext;

  // Initialize logger
  logger.setDatabase(null, false);
  if (ctx) logger.setContext(ctx);

  // Always require authentication
  let currentUser: { id: string; email: string; roles: string[] };
  try {
    currentUser = await requireAuth(request, env, true) as { id: string; email: string; roles: string[] };
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

  // Construct acting user for M2M API calls
  const actingUser: ActingUser = {
    id: currentUser.id,
    email: currentUser.email,
    roles: currentUser.roles || [],
  };

  const authServerUrl = getAuthServerUrl(request, env);

  try {
    // Fetch users via M2M API
    const usersResponse = await listUsers(env, actingUser, undefined, request);

    if (isErrorResponse(usersResponse)) {
      console.error("Error fetching users:", usersResponse.error);
      return { users: [], allRoles: [], user: { id: currentUser.id, email: currentUser.email }, authServerUrl };
    }

    // Transform the API response to match component expectations
    const users = usersResponse.users.map((user) => ({
      id: user.id,
      email: user.email,
      created_at: user.created_at,
      roles: user.roles || [],
    }));

    // Fetch all roles for the role manager
    const rolesResponse = await getAllRoles(request, env);
    const allRoles = isRbacError(rolesResponse) ? [] : rolesResponse;

    return { users, allRoles, user: { id: currentUser.id, email: currentUser.email }, authServerUrl };
  } catch (error) {
    console.error("Error loading users:", error);
    return { users: [], allRoles: [], user: { id: currentUser.id, email: currentUser.email }, authServerUrl };
  }
}

export async function action({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as {
    AUTH_STORAGE: KVNamespace;
    AUTH_SERVER_URL?: string;
    ADMIN_CLIENT_ID?: string;
    ADMIN_CLIENT_SECRET?: string;
  };

  // Require authentication for actions
  let currentUser: { id: string; email: string; roles: string[] };
  try {
    currentUser = await requireAuth(request, env, true) as { id: string; email: string; roles: string[] };
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

  // Construct acting user for M2M API calls
  const actingUser: ActingUser = {
    id: currentUser.id,
    email: currentUser.email,
    roles: currentUser.roles || [],
  };

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

      if (isRbacError(result)) {
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

      if (isRbacError(result)) {
        return { error: result.error };
      }

      return { success: true };
    }

    if (intent === "createUser") {
      const email = formData.get("email") as string;
      const roleIds = formData.getAll("roleId") as string[];

      if (!email) {
        return { error: "Email is required" };
      }

      // Create user via M2M API
      const result = await createUser(env, actingUser, {
        email,
        initialRole: roleIds[0], // First role as initial
        sendInvite: false, // Don't send invite for now
      });

      if (isErrorResponse(result)) {
        return { error: result.error };
      }

      // Assign additional roles if more than one selected
      for (const roleId of roleIds.slice(1)) {
        await assignUserRole(env, actingUser, result.id, roleId);
      }

      return { success: true, userId: result.id };
    }

    if (intent === "updateUser") {
      const userId = formData.get("userId") as string;
      const email = formData.get("email") as string;

      if (!userId) {
        return { error: "Missing userId" };
      }

      // Update user via M2M API
      const result = await updateUser(env, actingUser, userId, { email });

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

      // Delete user via M2M API
      const result = await deleteUser(env, actingUser, userId);

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

export default function Users() {
  const { users, allRoles, user, authServerUrl } = useLoaderData<LoaderData>();
  const revalidator = useRevalidator();
  const fetcher = useFetcher();
  const [searchQuery, setSearchQuery] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newUserEmail, setNewUserEmail] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [roleManagerOpen, setRoleManagerOpen] = useState<string | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<{ id: string; email: string; roles: Array<{ id: string; name: string }> } | null>(null);
  const [editEmail, setEditEmail] = useState("");
  const [editRole, setEditRole] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);

  const handleCreateUser = () => {
    // Submit form data for createUser action
    const formData = new FormData();
    formData.append("intent", "createUser");
    formData.append("email", newUserEmail);
    selectedRoles.forEach((roleId) => formData.append("roleId", roleId));

    fetcher.submit(formData, { method: "POST" });
    setCreateDialogOpen(false);
    setNewUserEmail("");
    setSelectedRoles([]);
  };

  const handleEditUser = (user: { id: string; email: string; roles: Array<{ id: string; name: string }> }) => {
    setEditingUser(user);
    setEditEmail(user.email);
    // Set the current role (take the first one or default to user)
    const currentRole = user.roles.length > 0 ? user.roles[0].name : 'user';
    setEditRole(currentRole);
    setEditDialogOpen(true);
  };

  const handleSaveEdit = () => {
    if (!editingUser) return;

    // First update user email
    fetcher.submit(
      { intent: "updateUser", userId: editingUser.id, email: editEmail },
      { method: "POST" }
    );

    // Then update role if changed
    const currentRole = editingUser.roles.length > 0 ? editingUser.roles[0].name : 'user';
    if (editRole !== currentRole) {
      // Find role IDs
      const targetRoleId = allRoles.find((r) => r.name === editRole)?.id;
      const currentRoleId = editingUser.roles.length > 0 ? editingUser.roles[0].id : null;

      // Remove old role if exists
      if (currentRoleId) {
        fetcher.submit(
          { intent: "removeRole", userId: editingUser.id, roleId: currentRoleId },
          { method: "POST" }
        );
      }

      // Add new role
      if (targetRoleId) {
        fetcher.submit(
          { intent: "assignRole", userId: editingUser.id, roleId: targetRoleId },
          { method: "POST" }
        );
      }
    }

    setEditDialogOpen(false);
    setEditingUser(null);
    setEditEmail("");
    setEditRole("");
  };

  const handleConfirmDelete = () => {
    if (!deletingUserId) return;

    fetcher.submit(
      { intent: "deleteUser", userId: deletingUserId },
      { method: "POST" }
    );
    setDeleteDialogOpen(false);
    setDeletingUserId(null);
  };

  const handleDeleteUser = (userId: string) => {
    setDeletingUserId(userId);
    setDeleteDialogOpen(true);
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
    <AdminLayout user={user} authServerUrl={authServerUrl}>
      <div className="mb-6">
        <h2 className="text-3xl font-bold text-[rgb(var(--color-foreground))] mb-2">User Management</h2>
        <p className="text-[rgb(var(--color-muted-foreground))]">
          Manage user accounts and role assignments
        </p>
      </div>

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
                            size="sm"
                            onClick={() => handleEditUser(user)}
                            title="Edit User"
                          >
                            <Pencil className="h-4 w-4 mr-1" />
                            Edit
                          </Button>
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
                            size="sm"
                            onClick={() => handleDeleteUser(user.id)}
                            title="Delete User"
                          >
                            <Trash2 className="h-4 w-4 mr-1 text-[rgb(var(--color-destructive))]" />
                            Delete
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

      {/* Role Manager Dialogs */}
      {users.map((u) => (
        <UserRoleManager
          key={u.id}
          open={roleManagerOpen === u.id}
          onOpenChange={(open) => {
            if (!open) {
              closeRoleManager();
            }
          }}
          userId={u.id}
          userEmail={u.email}
          currentRoles={u.roles}
          allRoles={allRoles}
        />
      ))}

      {/* Edit User Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription>
              Update user information.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="role">Role</Label>
              <select
                id="role"
                className="flex h-10 w-full rounded-md border border-[rgb(var(--color-input))] bg-[rgb(var(--color-background))] px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-ring))] focus-visible:ring-offset-2"
                value={editRole}
                onChange={(e) => setEditRole(e.target.value)}
              >
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" onClick={handleSaveEdit}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete User</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this user? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
