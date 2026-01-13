import { useState, useEffect, useRef } from "react";
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
// Role assignment uses M2M auth through admin-api.server.ts
import {
  listUsers,
  listRoles,
  createUser,
  updateUser,
  deleteUser,
  assignUserRole,
  removeUserRole,
  isErrorResponse,
  type ActingUser,
  type Role,
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
    name?: string;
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
      name: user.name,
      created_at: user.created_at,
      roles: user.roles || [],
    }));

    // Fetch all roles for the role manager (using M2M auth)
    const rolesResponse = await listRoles(env, actingUser, request);
    console.debug("[users._index] listRoles response:", JSON.stringify(rolesResponse, null, 2));
    if (isErrorResponse(rolesResponse)) {
      console.error("Error fetching roles for user management:", rolesResponse.error);
    }
    const allRoles: Role[] = isErrorResponse(rolesResponse) ? [] : rolesResponse;
    console.debug("[users._index] Final allRoles count:", allRoles.length);

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

      const result = await assignUserRole(env, actingUser, userId, roleId);

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

      const result = await removeUserRole(env, actingUser, userId, roleId);

      if (isErrorResponse(result)) {
        return { error: result.error };
      }

      return { success: true };
    }

    if (intent === "createUser") {
      const email = formData.get("email") as string;
      const roleIds = formData.getAll("roleId") as string[];

      // Debug: Log incoming role IDs for E2E troubleshooting
      console.log('[createUser] Received roleIds:', JSON.stringify(roleIds), 'for email:', email);

      if (!email) {
        return { error: "Email is required" };
      }

      // Create user via M2M API
      // Note: OpenAuth's userApiRoutes doesn't support initialRole, so we assign roles separately
      const result = await createUser(env, actingUser, {
        email,
        sendInvite: false, // Don't send invite for now
      });

      if (isErrorResponse(result)) {
        return { error: result.error };
      }

      console.log('[createUser] User created with ID:', result.id, '- now assigning', roleIds.length, 'roles');

      // Assign all selected roles after user creation
      const roleAssignmentErrors: string[] = [];
      for (const roleId of roleIds) {
        console.log('[createUser] Assigning role:', roleId, 'to user:', result.id);
        const roleResult = await assignUserRole(env, actingUser, result.id, roleId);
        if (isErrorResponse(roleResult)) {
          const errorMsg = `Failed to assign role ${roleId}: ${roleResult.error}`;
          console.error('[createUser] Role assignment failed:', errorMsg);
          roleAssignmentErrors.push(errorMsg);
        } else {
          console.log('[createUser] Role assigned successfully:', roleId);
        }
      }

      // Return role assignment errors as warnings so they're visible in the UI
      if (roleAssignmentErrors.length > 0) {
        return {
          success: true,
          userId: result.id,
          warning: `User created but role assignment failed: ${roleAssignmentErrors.join('; ')}`
        };
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

    // Combined edit user action - handles email AND role changes in one call
    if (intent === "editUser") {
      const userId = formData.get("userId") as string;
      const email = formData.get("email") as string;
      const newRoleId = formData.get("newRoleId") as string | null;
      const oldRoleId = formData.get("oldRoleId") as string | null;

      if (!userId) {
        return { error: "Missing userId" };
      }

      // Update email first
      const emailResult = await updateUser(env, actingUser, userId, { email });
      if (isErrorResponse(emailResult)) {
        return { error: emailResult.error };
      }

      // Handle role change if requested
      if (newRoleId !== oldRoleId) {
        // Remove old role if exists
        if (oldRoleId) {
          const removeResult = await removeUserRole(env, actingUser, userId, oldRoleId);
          if (isErrorResponse(removeResult)) {
            // Log but don't fail - user update succeeded
            console.warn('Failed to remove old role:', removeResult.error);
          }
        }
        // Assign new role
        if (newRoleId) {
          const assignResult = await assignUserRole(env, actingUser, userId, newRoleId);
          if (isErrorResponse(assignResult)) {
            return { error: assignResult.error };
          }
        }
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
  const [editingUser, setEditingUser] = useState<{ id: string; email: string; name?: string; roles: Array<{ id: string; name: string }> } | null>(null);
  const [editEmail, setEditEmail] = useState("");
  const [editRole, setEditRole] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverWarning, setServerWarning] = useState<string | null>(null);
  const [editServerError, setEditServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isEditSubmitting, setIsEditSubmitting] = useState(false);
  // Track previous fetcher state to detect state transitions (not just idle with old data)
  // Use separate refs for create and edit to avoid interference
  const prevFetcherStateForCreateRef = useRef<string>(fetcher.state);
  const prevFetcherStateForEditRef = useRef<string>(fetcher.state);

  // Handle fetcher response for create user
  // Use queueMicrotask to avoid synchronous setState in effect body
  useEffect(() => {
    const prevState = prevFetcherStateForCreateRef.current;
    prevFetcherStateForCreateRef.current = fetcher.state;

    // Only process response when transitioning from loading/submitting to idle
    // This prevents reacting to stale fetcher.data when isSubmitting first becomes true
    if (isSubmitting && fetcher.state === "idle" && prevState !== "idle" && fetcher.data) {
      const data = fetcher.data as { success?: boolean; error?: string; warning?: string };
      queueMicrotask(() => {
        setIsSubmitting(false);
        if (data.success) {
          // Check if there's a warning about role assignment
          if (data.warning) {
            // Show warning in UI and keep dialog open briefly so E2E tests can see it
            console.error('[createUser] Warning:', data.warning);
            setServerWarning(data.warning);
            // Still close dialog after a moment - user was created successfully
            setTimeout(() => {
              setCreateDialogOpen(false);
              setNewUserEmail("");
              setSelectedRoles([]);
              setEmailError(null);
              setServerError(null);
              setServerWarning(null);
              revalidator.revalidate();
            }, 2000);
          } else {
            // Success with no warnings - close dialog and reset form
            setCreateDialogOpen(false);
            setNewUserEmail("");
            setSelectedRoles([]);
            setEmailError(null);
            setServerError(null);
            setServerWarning(null);
            // Revalidate to fetch fresh data (fetcher.submit doesn't auto-revalidate like Form)
            revalidator.revalidate();
          }
        } else if (data.error) {
          // Server error - show error in dialog
          setServerError(data.error);
        }
      });
    }
  }, [fetcher.state, fetcher.data, isSubmitting, revalidator]);

  // Handle fetcher response for edit user
  // Use queueMicrotask to avoid synchronous setState in effect body
  useEffect(() => {
    const prevState = prevFetcherStateForEditRef.current;
    prevFetcherStateForEditRef.current = fetcher.state;

    // Only process response when transitioning from loading/submitting to idle
    if (isEditSubmitting && fetcher.state === "idle" && prevState !== "idle") {
      const data = fetcher.data as { success?: boolean; error?: string } | undefined;
      queueMicrotask(() => {
        setIsEditSubmitting(false);
        if (data?.success) {
          // Success - close dialog and reset form
          setEditDialogOpen(false);
          setEditingUser(null);
          setEditEmail("");
          setEditRole("");
          setEditServerError(null);
          // Revalidate to fetch fresh data (fetcher.submit doesn't auto-revalidate like Form)
          revalidator.revalidate();
        } else if (data?.error) {
          // Server error - show error in dialog
          setEditServerError(data.error);
        } else {
          // No explicit success/error but operation completed - assume success
          setEditDialogOpen(false);
          setEditingUser(null);
          setEditEmail("");
          setEditRole("");
          setEditServerError(null);
          // Revalidate to fetch fresh data
          revalidator.revalidate();
        }
      });
    }
  }, [fetcher.state, fetcher.data, isEditSubmitting, revalidator]);

  // Simple email format validation
  const isValidEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const handleCreateUser = () => {
    // Validate email format before submitting
    if (!newUserEmail.trim()) {
      setEmailError("Email is required");
      return;
    }
    if (!isValidEmail(newUserEmail)) {
      setEmailError("Please enter a valid email address");
      return;
    }
    setEmailError(null);
    setServerError(null);

    // Debug: Log selected roles at submission time
    console.log('[handleCreateUser] Submitting with selectedRoles:', JSON.stringify(selectedRoles), 'for email:', newUserEmail);

    // Submit form data for createUser action
    const formData = new FormData();
    formData.append("intent", "createUser");
    formData.append("email", newUserEmail);
    selectedRoles.forEach((roleId) => formData.append("roleId", roleId));

    setIsSubmitting(true);
    fetcher.submit(formData, { method: "POST" });
    // Dialog stays open - will be closed by useEffect on success
  };

  const handleEditUser = (user: { id: string; email: string; name?: string; roles: Array<{ id: string; name: string }> }) => {
    setEditingUser(user);
    setEditEmail(user.email);
    // Set the current role (take the first one or default to user)
    const currentRole = user.roles.length > 0 ? user.roles[0].name : 'user';
    setEditRole(currentRole);
    setEditServerError(null);
    setEditDialogOpen(true);
  };

  const handleSaveEdit = () => {
    if (!editingUser) return;

    setEditServerError(null);
    setIsEditSubmitting(true);

    // Find role IDs for the combined action
    const targetRoleId = allRoles.find((r) => r.name === editRole)?.id || null;
    const currentRoleId = editingUser.roles.length > 0 ? editingUser.roles[0].id : null;

    // Use the combined editUser action that handles email AND role in one call
    const formData = new FormData();
    formData.append("intent", "editUser");
    formData.append("userId", editingUser.id);
    formData.append("email", editEmail);
    if (targetRoleId) formData.append("newRoleId", targetRoleId);
    if (currentRoleId) formData.append("oldRoleId", currentRoleId);

    fetcher.submit(formData, { method: "POST" });

    // Dialog stays open - will be closed by useEffect on success
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
    user.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    user.name?.toLowerCase().includes(searchQuery.toLowerCase())
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
                        onChange={(e) => {
                          setNewUserEmail(e.target.value);
                          setEmailError(null); // Clear error when user types
                        }}
                        className={emailError ? "border-red-500" : ""}
                      />
                      {emailError && (
                        <p className="text-sm text-red-500" role="alert">{emailError}</p>
                      )}
                    </div>
                    {serverError && (
                      <div className="p-3 text-sm text-red-500 bg-red-50 rounded-md" role="alert">
                        {serverError}
                      </div>
                    )}
                    {serverWarning && (
                      <div className="p-3 text-sm text-yellow-700 bg-yellow-50 rounded-md" role="alert" data-testid="role-assignment-warning">
                        ⚠️ {serverWarning}
                      </div>
                    )}
                    <div className="grid gap-2">
                      <Label htmlFor="roles">Initial Roles</Label>
                      <div className="space-y-2">
                        {allRoles.map((role) => (
                          <label key={role.id} className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selectedRoles.includes(role.id)}
                              onChange={(e) => {
                                console.log('[RoleCheckbox] Toggle role:', role.id, role.name, 'checked:', e.target.checked, 'current selectedRoles:', selectedRoles);
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
                    <Button variant="outline" onClick={() => {
                      setCreateDialogOpen(false);
                      setEmailError(null);
                      setServerError(null);
                      setServerWarning(null);
                      setNewUserEmail("");
                      setSelectedRoles([]);
                    }}>
                      Cancel
                    </Button>
                    <Button onClick={handleCreateUser} disabled={isSubmitting}>
                      {isSubmitting ? "Creating..." : "Create User"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </CardHeader>
          <CardContent>
            <div className="mb-4">
              <Input
                placeholder="Search users by name or email..."
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
                    <TableHead>Name</TableHead>
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
                          <User className="h-4 w-4 text-[rgb(var(--color-muted-foreground))]" />
                          {user.name || '-'}
                        </div>
                      </TableCell>
                      <TableCell>
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
                disabled={isEditSubmitting}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="role">Role</Label>
              <select
                id="role"
                className="flex h-10 w-full rounded-md border border-[rgb(var(--color-input))] bg-[rgb(var(--color-background))] px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-ring))] focus-visible:ring-offset-2"
                value={editRole}
                onChange={(e) => setEditRole(e.target.value)}
                disabled={isEditSubmitting}
              >
                  {allRoles.map((role) => (
                  <option key={role.id} value={role.name}>{role.name}</option>
                ))}
              </select>
            </div>
            {editServerError && (
              <div className="p-3 text-sm text-red-500 bg-red-50 rounded-md" role="alert">
                {editServerError}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)} disabled={isEditSubmitting}>
              Cancel
            </Button>
            <Button type="submit" onClick={handleSaveEdit} disabled={isEditSubmitting}>
              {isEditSubmitting ? "Saving..." : "Save"}
            </Button>
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
