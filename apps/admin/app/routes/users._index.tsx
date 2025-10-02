import { useState } from "react";
import type { MetaFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { ArrowLeft, Plus, Pencil, Trash2, Mail, Shield, User, LogOut } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { getAllUsers } from "~/lib/db.server";
import { requireAuth } from "~/lib/auth.server";
import { logger } from "~/lib/logger.server";

export const meta: MetaFunction = () => {
  return [
    { title: "Users - Al Ummah Now Admin" },
    { name: "description", content: "Manage user accounts" },
  ];
};

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as { AUTH_DB: D1Database; AUTH_STORAGE: KVNamespace };
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
      return { users: [] };
    }
    const users = await getAllUsers(env.AUTH_DB);
    return { users };
  } catch (error) {
    console.error("Error loading users:", error);
    return { users: [] };
  }
}

export default function Users() {
  const { users } = useLoaderData<typeof loader>();
  const [searchQuery, setSearchQuery] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserRole, setNewUserRole] = useState("user");

  const handleCreateUser = async () => {
    // TODO: Implement user creation API call
    console.log("Creating user:", { email: newUserEmail, role: newUserRole });
    setCreateDialogOpen(false);
    setNewUserEmail("");
    setNewUserRole("user");
  };

  const handleDeleteUser = async (userId: string) => {
    if (confirm("Are you sure you want to delete this user?")) {
      // TODO: Implement user deletion API call
      console.log("Deleting user:", userId);
    }
  };

  const filteredUsers = users.filter((user: any) =>
    user.email?.toLowerCase().includes(searchQuery.toLowerCase())
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
              <img
                src="https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png"
                alt="Al Ummah Now"
                className="h-10 w-10 rounded-lg"
              />
              <div>
                <h1 className="text-xl font-bold text-[rgb(var(--color-foreground))]">User Management</h1>
                <p className="text-sm text-[rgb(var(--color-muted-foreground))]">Al Ummah Now Admin</p>
              </div>
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
                <CardDescription>Manage user accounts and permissions</CardDescription>
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
                      <Label htmlFor="role">Role</Label>
                      <select
                        id="role"
                        className="flex h-9 w-full rounded-md border border-[rgb(var(--color-input))] bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--color-ring))]"
                        value={newUserRole}
                        onChange={(e) => setNewUserRole(e.target.value)}
                      >
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                      </select>
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
                    <TableHead>Role</TableHead>
                    <TableHead>Created At</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredUsers.map((user: any) => (
                    <TableRow key={user.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <Mail className="h-4 w-4 text-[rgb(var(--color-muted-foreground))]" />
                          {user.email}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {user.role === "admin" ? (
                            <Shield className="h-4 w-4 text-[rgb(var(--color-primary))]" />
                          ) : (
                            <User className="h-4 w-4 text-[rgb(var(--color-muted-foreground))]" />
                          )}
                          <span className={user.role === "admin" ? "text-[rgb(var(--color-primary))]" : ""}>
                            {user.role}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {new Date(user.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="icon">
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDeleteUser(user.id)}
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
    </div>
  );
}
