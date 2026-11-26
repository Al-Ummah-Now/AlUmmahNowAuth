import { formatNumber } from "../../../../packages/ui/src/format.ts";
import { Email } from "../components/email";
import { AdminTime, adminDate, useAdminTime } from "../components/admin-time";
import { pageTitle } from "../lib/admin-copy";
import { pagesCopy } from "../lib/pages-copy";
import { withLang } from "../lib/shell-copy";
import { useState, useEffect, useRef } from "react";
import type { MetaFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useNavigate, useRevalidator, useSearchParams } from "react-router";
import { Plus, Settings, Trash2, Mail, User, Pencil, KeyRound } from "lucide-react";
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
import { ConfirmDialog } from "../components/confirm-dialog";
import { deletionCopy, dirOf, langOf } from "../lib/deletion-copy";
import { UserRoleManager } from "../components/user-role-manager";
import { AdminLayout } from "../components/admin-layout";
import { UserAutocomplete } from "../components/autocomplete";
import { requireAuth, requireStepUp } from "../lib/auth.server";
import { getAuthServerUrl } from "../lib/config";
import { LoadErrorBanner } from "../components/load-error-banner";
import { logger } from "../lib/logger.server";
import { resolveUserDisplayName } from "../../../../packages/ui/src/display-name";
import { SystemAccountsSection, type SystemAccountRow } from "../components/system-accounts-section";
import { isSuperAdmin, systemAccountsCopy } from "../lib/system-accounts";
// Role assignment uses M2M auth through admin-api.server.ts
import {
  listUsers,
  listSystemAccounts,
  listRoles,
  getUserRoles,
  createUser,
  updateUser,
  deleteUser,
  assignUserRole,
  removeUserRole,
  isErrorResponse,
  type ActingUser,
  type Role,
} from "../lib/admin-api.server";
import { getCloudflare } from "../lib/cloudflare-context";

export const meta: MetaFunction = ({ location }) => [{ title: pageTitle("users", langOf(location.search)) }];

interface UserRow {
  id: string;
  email: string;
  name?: string;
  created_at: string;
  roles: Array<{ id: string; name: string }>;
}

type RoleChange = { roleId: string; operation: "add" | "remove" };
type RoleChangeFailure = RoleChange & { error: string };
type PartialEdit = { emailSaved: boolean; applied: RoleChange[]; failures: RoleChangeFailure[] };
type EditUserResult =
  | { success: true }
  | { error: string }
  | PartialEdit;

interface LoaderData {
  users: UserRow[];
  allRoles: Array<{ id: string; name: string; is_system: boolean; description?: string }>;
  user: { id: string; email: string } | null;
  authServerUrl: string;
  /** Set when users or roles could not be fetched, so the page never shows a failure as "no users". */
  loadError?: string;
  /** Super admins only: the system accounts the list leaves out (null for everyone else) */
  systemAccounts?: SystemAccountRow[] | null;
}

/** Super admins: the read-only System accounts section's rows (a failure is a load error, never "none"). */
async function loadSystemAccounts(
  env: Parameters<typeof listSystemAccounts>[0],
  actingUser: ActingUser,
  request: Request
): Promise<{ systemAccounts: SystemAccountRow[] | null; systemError?: string }> {
  if (!isSuperAdmin(actingUser.roles)) return { systemAccounts: null };
  try {
    const res = await listSystemAccounts(env, actingUser, request);
    if (isErrorResponse(res)) return { systemAccounts: null, systemError: `System accounts: ${res.error}` };
    return {
      systemAccounts: res.users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        status: u.status,
        deleted_at: u.deleted_at ?? null,
        roles: (u.roles ?? []).map((r) => ({ id: r.id, name: r.name })),
      })),
    };
  } catch (error) {
    return { systemAccounts: null, systemError: `System accounts: ${error instanceof Error ? error.message : "Request failed"}` };
  }
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
    // ?q= (e.g. from a moderation request): load the users whose email matches
    const q = new URL(request.url).searchParams.get("q")?.trim();
    const usersResponse = await listUsers(env, actingUser, q ? { email: q, skipCount: true } : { skipCount: true }, request);

    if (isErrorResponse(usersResponse)) {
      console.error("Error fetching users:", usersResponse.error);
      return { users: [], allRoles: [], user: { id: currentUser.id, email: currentUser.email }, authServerUrl, loadError: usersResponse.error };
    }

    // Transform the API response to match component expectations
    const users = usersResponse.users.map((user) => ({
      id: user.id,
      email: user.email,
      // The platform's display-name rule (name, then first + last)
      name: resolveUserDisplayName(user),
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

    const { systemAccounts, systemError } = await loadSystemAccounts(env, actingUser, request);
    const loadError = [isErrorResponse(rolesResponse) ? `Roles: ${rolesResponse.error}` : undefined, systemError].filter(Boolean).join("; ") || undefined;
    return { users, allRoles, user: { id: currentUser.id, email: currentUser.email }, authServerUrl, loadError, systemAccounts };
  } catch (error) {
    console.error("Error loading users:", error);
    return {
      users: [],
      allRoles: [],
      user: { id: currentUser.id, email: currentUser.email },
      authServerUrl,
      loadError: error instanceof Error ? error.message : "Request failed",
    };
  }
}

export async function action({ request, context }: LoaderFunctionArgs) {
  const env = getCloudflare(context).env as {
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

  // High-risk (AUTH-PASSKEYS, AD5): role changes and deletes need a sign-in
  // within 15 minutes; otherwise sign in again and come back here
  if (["assignRole", "removeRole", "editUser", "deleteUser"].includes(intent)) {
    requireStepUp(currentUser, request, "/users");
  }

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

      if (!email) {
        return { error: "Email is required" };
      }

      // Create user via M2M API
      // Note: OpenAuth's userApiRoutes doesn't support initialRole, so we assign roles separately
      const result = await createUser(env, actingUser, {
        email,
        sendInvite: false,
      });

      if (isErrorResponse(result)) {
        return { error: result.error };
      }

      // Assign all selected roles after user creation
      const roleAssignmentErrors: string[] = [];
      for (const roleId of roleIds) {
        const roleResult = await assignUserRole(env, actingUser, result.id, roleId);
        if (isErrorResponse(roleResult)) {
          const errorMsg = `Failed to assign role ${roleId}: ${roleResult.error}`;
          console.error('[createUser] Role assignment failed:', errorMsg);
          roleAssignmentErrors.push(errorMsg);
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

    if (intent === "editUser") {
      const userId = formData.get("userId");
      const email = formData.get("email");
      if (typeof userId !== "string" || !userId) {
        return { error: "Missing userId" };
      }
      if (email !== null && (typeof email !== "string" || !email.trim())) {
        return { error: "Email is required" };
      }

      const toAdd = new Set(formData.getAll("addRoleId"));
      const toRemove = new Set(formData.getAll("removeRoleId"));
      const changes: RoleChange[] = [];
      for (const roleId of toRemove) {
        if (typeof roleId !== "string" || !roleId || toAdd.has(roleId)) {
          return { error: "Invalid role change" };
        }
        changes.push({ roleId, operation: "remove" });
      }
      for (const roleId of toAdd) {
        if (typeof roleId !== "string" || !roleId) {
          return { error: "Invalid role change" };
        }
        changes.push({ roleId, operation: "add" });
      }

      // Apply only the roles the administrator changed. Checking the current
      // assignments makes a retry safe if a prior request saved some changes.
      const currentRoles = new Map<string, number | null>();
      if (changes.length > 0) {
        const current = await getUserRoles(env, actingUser, userId);
        if (isErrorResponse(current)) return { error: current.error };
        current.roles.forEach((role) => currentRoles.set(role.id, role.expires_at));
      }

      if (email !== null) {
        const result = await updateUser(env, actingUser, userId, { email });
        if (isErrorResponse(result)) return { error: result.error };
      }

      const applied: RoleChange[] = [];
      const failures: RoleChangeFailure[] = [];
      for (const change of changes) {
        const { roleId, operation } = change;
        const adding = operation === "add";
        const expiresAt = currentRoles.get(roleId);
        const alreadyApplied = adding
          ? expiresAt === null || (expiresAt !== undefined && expiresAt > Date.now())
          : !currentRoles.has(roleId);
        if (alreadyApplied) {
          applied.push(change);
          continue;
        }

        const mutateRole = adding ? assignUserRole : removeUserRole;
        const result = await mutateRole(env, actingUser, userId, roleId);
        if (isErrorResponse(result)) {
          failures.push({ ...change, error: result.error });
        } else {
          applied.push(change);
        }
      }

      const result: EditUserResult = failures.length > 0
        ? { emailSaved: email !== null, applied, failures }
        : { success: true };
      return result;
    }

    if (intent === "deleteUser") {
      const userId = formData.get("userId") as string;

      if (!userId) {
        return { error: "Missing userId" };
      }

      // Soft delete via M2M API: restorable from Recently deleted for 30 days
      const reason = String(formData.get("reason") ?? "").trim() || undefined;
      const result = await deleteUser(env, actingUser, userId, reason);

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
  const { users, allRoles, user, authServerUrl, loadError, systemAccounts } = useLoaderData<LoaderData>();
  const revalidator = useRevalidator();
  const fetcher = useFetcher();
  const editFetcher = useFetcher<EditUserResult>();
  const [searchParams] = useSearchParams();
  const [searchQuery, setSearchQuery] = useState(() => searchParams.get("q") ?? "");
  const navigate = useNavigate();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newUserEmail, setNewUserEmail] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [roleManagerOpen, setRoleManagerOpen] = useState<string | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [editEmail, setEditEmail] = useState("");
  const [editRoleIds, setEditRoleIds] = useState<string[]>([]);
  const [editBaseline, setEditBaseline] = useState({ email: "", roleIds: [] as string[] });
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const deleteLang = langOf(searchParams);
  const deleteCopy = deletionCopy(deleteLang);
  // ?view=system (the Errors page links here): the System accounts section first
  const systemView = searchParams.get("view") === "system";
  const systemCopy = systemAccountsCopy(deleteLang);
  const lang = deleteLang;
  const t = pagesCopy(lang).users;
  const c = pagesCopy(lang).common;
  // People by name: display name, else email (rule: never a bare "-")
  const nameOf = (u: { name?: string; email: string }) => u.name?.trim() || u.email;
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverWarning, setServerWarning] = useState<string | null>(null);
  const [editServerError, setEditServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [partialEdit, setPartialEdit] = useState<PartialEdit | null>(null);
  const isEditSubmitting = editFetcher.state !== "idle";
  // Track previous fetcher state to detect state transitions (not just idle with old data)
  // Use separate refs for create and edit to avoid interference
  const prevFetcherStateForCreateRef = useRef<string>(fetcher.state);
  const prevFetcherStateForEditRef = useRef(editFetcher.state);

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

  useEffect(() => {
    const prevState = prevFetcherStateForEditRef.current;
    prevFetcherStateForEditRef.current = editFetcher.state;
    const data = editFetcher.data;
    if (editFetcher.state !== "idle" || prevState === "idle" || !data) return;

    queueMicrotask(() => {
      if ("success" in data) {
        setEditDialogOpen(false);
        setEditingUser(null);
      } else if ("error" in data) {
        setEditServerError(data.error);
      } else {
        setPartialEdit(data);
        setEditBaseline((saved) => {
          const roleIds = new Set(saved.roleIds);
          for (const { roleId, operation } of data.applied) {
            if (operation === "add") roleIds.add(roleId);
            else roleIds.delete(roleId);
          }
          return { email: data.emailSaved ? editEmail : saved.email, roleIds: [...roleIds] };
        });
      }
    });
  }, [editFetcher.state, editFetcher.data, editEmail]);

  // Simple email format validation
  const isValidEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const handleCreateUser = () => {
    // Validate email format before submitting
    if (!newUserEmail.trim()) {
      setEmailError(t.emailRequired);
      return;
    }
    if (!isValidEmail(newUserEmail)) {
      setEmailError(t.emailInvalid);
      return;
    }
    setEmailError(null);
    setServerError(null);

    // Submit form data for createUser action
    const formData = new FormData();
    formData.append("intent", "createUser");
    formData.append("email", newUserEmail);
    selectedRoles.forEach((roleId) => formData.append("roleId", roleId));

    setIsSubmitting(true);
    fetcher.submit(formData, { method: "POST" });
    // Dialog stays open - will be closed by useEffect on success
  };

  const handleEditUser = (user: UserRow) => {
    const roleIds = user.roles.map(({ id }) => id);
    setEditingUser(user);
    setEditEmail(user.email);
    setEditRoleIds(roleIds);
    setEditBaseline({ email: user.email, roleIds });
    setEditServerError(null);
    setPartialEdit(null);
    setEditDialogOpen(true);
  };

  const handleSaveEdit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingUser || isEditSubmitting) return;

    setEditServerError(null);
    setPartialEdit(null);
    const formData = new FormData();
    formData.set("intent", "editUser");
    formData.set("userId", editingUser.id);
    if (editEmail !== editBaseline.email) formData.set("email", editEmail);
    for (const id of editRoleIds) {
      if (!editBaseline.roleIds.includes(id)) formData.append("addRoleId", id);
    }
    for (const id of editBaseline.roleIds) {
      if (!editRoleIds.includes(id)) formData.append("removeRoleId", id);
    }
    editFetcher.submit(formData, { method: "POST" });
  };

  // Assigned roles remain visible if the role catalog could not be loaded.
  const editRoleOptions = new Map([...allRoles, ...(editingUser?.roles ?? [])].map((role) => [role.id, role.name]));

  const handleConfirmDelete = ({ reason }: { reason: string }) => {
    if (!deletingUserId) return;

    fetcher.submit(
      { intent: "deleteUser", userId: deletingUserId, reason },
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

  type Row = (typeof users)[number];
  const rolesOf = (u: Row) =>
    u.roles.length === 0 ? (
      <span className="text-sm text-[var(--color-muted-foreground)]">{t.noRoles}</span>
    ) : (
      u.roles.map((role) => <UserRoleBadge key={role.id} role={role.name} lang={lang} />)
    );
  const actionsOf = (u: Row) => (
    <>
      <Button variant="ghost" size="sm" onClick={() => handleEditUser(u)} title={t.editOf(nameOf(u))}>
        <Pencil className="h-4 w-4 me-1" aria-hidden="true" />
        {t.edit}
      </Button>
      <Button variant="ghost" size="icon" onClick={() => openRoleManager(u.id)} title={t.manageRoles(nameOf(u))} aria-label={t.manageRoles(nameOf(u))}>
        <Settings className="h-4 w-4" aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="sm" asChild title={t.passkeysOf(nameOf(u))}>
        <a href={`/users/${encodeURIComponent(u.id)}/passkeys${lang === "ar" ? "?lang=ar" : ""}`}>
          <KeyRound className="h-4 w-4 me-1" aria-hidden="true" />
          {t.passkeys}
        </a>
      </Button>
      <Button variant="ghost" size="sm" onClick={() => handleDeleteUser(u.id)} title={t.deleteOf(nameOf(u))}>
        <Trash2 className="h-4 w-4 me-1 text-[var(--color-destructive-text)]" aria-hidden="true" />
        {t.delete}
      </Button>
    </>
  );

  return (
    <AdminLayout user={user} authServerUrl={authServerUrl}>
      <div className="mb-6">
        <h2 className="text-3xl font-bold text-[var(--color-foreground)] mb-2">{t.title}</h2>
        <p className="text-[var(--color-muted-foreground)]">{t.intro}</p>
      </div>

      <LoadErrorBanner title={c.couldNotLoad(t.what)} error={loadError} />

      {systemAccounts && (
        <div className="mb-4 flex justify-end">
          <Button
            variant="outline"
            size="sm"
            data-testid="system-accounts-toggle"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              if (systemView) next.delete("view");
              else next.set("view", "system");
              navigate({ search: next.toString() ? `?${next}` : "" });
            }}
          >
            {systemView ? (
              systemCopy.hide
            ) : (
              <>
                {systemCopy.show}
                {/* A count badge, isolated: brackets around a number flip in WebKit's RTL layout */}
                <span className="rounded-full bg-[var(--color-muted)] px-2 text-xs font-semibold" data-testid="system-accounts-count">
                  <bdi>{formatNumber(systemAccounts.length, deleteLang)}</bdi>
                </span>
              </>
            )}
          </Button>
        </div>
      )}

      {systemAccounts && systemView && <SystemAccountsSection accounts={systemAccounts} lang={deleteLang} />}

      <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>{t.cardTitle}</CardTitle>
                <CardDescription>{t.cardIntro}</CardDescription>
              </div>
              <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
                <DialogTrigger asChild>
                  <Button>
                    <Plus className="h-4 w-4 me-2" aria-hidden="true" />
                    {t.create}
                  </Button>
                </DialogTrigger>
                <DialogContent data-testid="create-user-dialog" data-selected-roles={JSON.stringify(selectedRoles)} dir={dirOf(lang)} lang={lang}>
                  <DialogHeader>
                    <DialogTitle>{t.createTitle}</DialogTitle>
                    <DialogDescription>{t.createIntro}</DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                      <Label htmlFor="email">{c.email}</Label>
                      <Input
                        id="email"
                        type="email"
                        dir="ltr"
                        placeholder={t.emailPlaceholder}
                        value={newUserEmail}
                        onChange={(e) => {
                          setNewUserEmail(e.target.value);
                          setEmailError(null); // Clear error when user types
                        }}
                        className={emailError ? "border-[var(--color-destructive-text)]" : ""}
                      />
                      {emailError && (
                        <p className="text-sm text-[var(--color-destructive-text)]" role="alert">{emailError}</p>
                      )}
                    </div>
                    {serverError && (
                      <div className="p-3 text-sm ui-alert-error rounded-md" role="alert">
                        {serverError}
                      </div>
                    )}
                    {serverWarning && (
                      <div className="p-3 text-sm ui-alert-warning rounded-md" role="alert" data-testid="role-assignment-warning">
                        ⚠️ {serverWarning}
                      </div>
                    )}
                    <div className="grid gap-2">
                      <Label htmlFor="roles">{t.initialRoles}</Label>
                      <div className="space-y-2" data-testid="roles-list" data-available-roles={JSON.stringify(allRoles.map(r => ({ id: r.id, name: r.name })))}>
                        {allRoles.map((role) => (
                          <label key={role.id} className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              data-role-id={role.id}
                              data-role-name={role.name}
                              checked={selectedRoles.includes(role.id)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedRoles([...selectedRoles, role.id]);
                                } else {
                                  setSelectedRoles(selectedRoles.filter((id) => id !== role.id));
                                }
                              }}
                              className="h-4 w-4 rounded border-[var(--color-input)]"
                            />
                            <span className="text-sm">{role.name}</span>
                            {role.description && (
                              <span className="text-xs text-[var(--color-muted-foreground)]">
                                — <bdi>{role.description}</bdi>
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
                      {c.cancel}
                    </Button>
                    <Button onClick={handleCreateUser} disabled={isSubmitting}>
                      {isSubmitting ? t.creating : t.create}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </CardHeader>
          <CardContent>
            <div className="mb-4">
              <UserAutocomplete
                mode="search"
                name="q"
                label={t.searchLabel}
                placeholder={t.searchPlaceholder}
                lang={lang}
                defaultValue={searchQuery}
                onQueryChange={setSearchQuery}
                // Enter: the server-side search (every user, not only the loaded page)
                onSearch={(q) => navigate(withLang(q ? `/users?q=${encodeURIComponent(q)}` : "/users", lang))}
                // A suggestion: the list narrowed to that user
                hrefFor={(s) => withLang(`/users?q=${encodeURIComponent(s.secondary ?? s.label)}`, lang)}
                className="max-w-sm"
                testId="users-search"
              />
            </div>

            {loadError && users.length === 0 ? null : users.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <User className="h-12 w-12 text-[var(--color-muted-foreground)] mb-4" aria-hidden="true" />
                <h3 className="text-lg font-semibold mb-2">{t.emptyTitle}</h3>
                <p className="text-sm text-[var(--color-muted-foreground)] mb-4">{t.emptyText}</p>
                <Button onClick={() => setCreateDialogOpen(true)}>
                  <Plus className="h-4 w-4 me-2" aria-hidden="true" />
                  {t.create}
                </Button>
              </div>
            ) : (
              <>
                {/* Phone: one card per user; a table from md up */}
                <ul className="space-y-3 md:hidden" data-testid="user-cards">
                  {filteredUsers.map((u) => (
                    <li key={u.id} className="rounded-lg border border-[var(--color-border)] p-3" data-testid="user-card">
                      <div className="font-medium"><bdi>{nameOf(u)}</bdi></div>
                      {u.name?.trim() && <div className="text-sm text-[var(--color-muted-foreground)]"><Email value={u.email} /></div>}
                      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                        <dt className="text-[var(--color-muted-foreground)]">{t.colRoles}</dt>
                        <dd className="flex flex-wrap gap-1">{rolesOf(u)}</dd>
                        <dt className="text-[var(--color-muted-foreground)]">{t.colCreated}</dt>
                        <dd><AdminTime value={u.created_at} lang={lang} dateOnly /></dd>
                      </dl>
                      <div className="mt-3 flex flex-wrap justify-end gap-2">{actionsOf(u)}</div>
                    </li>
                  ))}
                </ul>
                <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.colUser}</TableHead>
                    <TableHead>{t.colRoles}</TableHead>
                    <TableHead>{t.colCreated}</TableHead>
                    <TableHead className="text-end">{c.actions}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredUsers.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <User className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden="true" />
                          <div>
                            <div><bdi>{nameOf(user)}</bdi></div>
                            {user.name?.trim() && (
                              <div className="flex items-center gap-1 text-xs font-normal text-[var(--color-muted-foreground)]">
                                <Mail className="h-3 w-3" aria-hidden="true" />
                                <Email value={user.email} />
                              </div>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">{rolesOf(user)}</div>
                      </TableCell>
                      <TableCell><AdminTime value={user.created_at} lang={lang} dateOnly /></TableCell>
                      <TableCell className="text-end">
                        <div className="flex justify-end gap-2">{actionsOf(user)}</div>
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
          userEmail={nameOf(u)}
          currentRoles={u.roles}
          allRoles={allRoles}
        />
      ))}

      {/* Edit User Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={(open) => {
        if (!isEditSubmitting) setEditDialogOpen(open);
      }}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto" dir={dirOf(lang)} lang={lang}>
          <DialogHeader>
            <DialogTitle>{t.editTitle}</DialogTitle>
            <DialogDescription>{t.editIntro}</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSaveEdit}>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="email">{c.email}</Label>
                <Input
                  id="email"
                  type="email"
                  dir="ltr"
                  required
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                  disabled={isEditSubmitting}
                />
              </div>
              <fieldset className="grid gap-2" disabled={isEditSubmitting}>
                <legend className="mb-2 text-sm font-medium">{t.colRoles}</legend>
                {editRoleOptions.size === 0 && <p className="text-sm text-muted-foreground">{t.noRoles}</p>}
                {[...editRoleOptions].map(([id, name]) => (
                  <label key={id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={editRoleIds.includes(id)}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setEditRoleIds((ids) => checked ? [...ids, id] : ids.filter((roleId) => roleId !== id));
                      }}
                      className="h-4 w-4 rounded border-[var(--color-input)]"
                    />
                    <bdi className="text-sm">{name}</bdi>
                  </label>
                ))}
              </fieldset>
              {editServerError && (
                <div className="p-3 text-sm ui-alert-error rounded-md" role="alert">
                  {editServerError}
                </div>
              )}
              {partialEdit && (
                <div className="p-3 text-sm ui-alert-warning rounded-md" role="alert">
                  <p>{partialEdit.emailSaved && `${t.editEmailSaved} `}{t.editRoleError}</p>
                  <ul className="list-disc ps-4">
                    {partialEdit.failures.map(({ operation, roleId, error }) => {
                      const name = editRoleOptions.get(roleId) ?? roleId;
                      return (
                        <li key={roleId}>
                          {operation === "add" ? t.roleAddFailed(name) : t.roleRemoveFailed(name)}
                          {" · "}<bdi>{error}</bdi>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditDialogOpen(false)} disabled={isEditSubmitting}>
                {c.cancel}
              </Button>
              <Button type="submit" disabled={isEditSubmitting}>
                {isEditSubmitting ? c.saving : c.save}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation: soft delete, restorable from Recently deleted */}
      <ConfirmDialog
        open={deleteDialogOpen}
        title={deleteCopy.deleteTitle("user")}
        description={deleteCopy.deleteBody("user", (() => { const u = users.find((x) => x.id === deletingUserId); return u ? nameOf(u) : ""; })())}
        confirmLabel={deleteCopy.deleteConfirm}
        cancelLabel={deleteCopy.cancel}
        reason={{ label: deleteCopy.reasonLabel, placeholder: deleteCopy.reasonPlaceholder }}
        dir={dirOf(deleteLang)}
        lang={deleteLang}
        onCancel={() => {
          setDeleteDialogOpen(false);
          setDeletingUserId(null);
        }}
        onConfirm={handleConfirmDelete}
      />
    </AdminLayout>
  );
}
