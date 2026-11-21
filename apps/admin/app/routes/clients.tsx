import { formatDate } from "../lib/date-utils";
import { pagesCopy } from "../lib/pages-copy";
import { useState, useEffect } from "react";
import type { MetaFunction, LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { ConfirmDialog } from "../components/confirm-dialog";
import { deletionCopy, dirOf, langOf } from "../lib/deletion-copy";
import { confirmCopy } from "../lib/confirm-copy";
import { Plus, Key, Trash2, RefreshCw, Copy, Check, Globe, Lock, Settings } from "lucide-react";
import { AdminLayout } from "../components/admin-layout";
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
import { requireAuth } from "../lib/auth.server";
import { logger } from "../lib/logger.server";
import { getAuthServerUrl } from "../lib/config";
import {
  listClients,
  createClient,
  updateClient,
  deleteClient as deleteOAuthClient,
  rotateClientSecret,
  isErrorResponse,
  type ActingUser,
} from "../lib/admin-api.server";
import { getCloudflare } from "../lib/cloudflare-context";

export const meta: MetaFunction = () => {
  return [
    { title: "OAuth Clients - Al Ummah Now Admin" },
    { name: "description", content: "Manage OAuth clients" },
  ];
};

interface OAuthClient {
  id: string;
  client_id: string;
  name: string;
  client_type: 'public' | 'confidential';
  allowed_grants: string[];
  redirect_uris: string[];
  scopes: string[];
  metadata: Record<string, unknown>;
  enabled: boolean;
  created_at: number;
}

interface LoaderData {
  clients: OAuthClient[];
  authServerUrl: string;
  user: { id: string; email: string } | null;
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
    if (error instanceof Response) {
      throw error;
    }
    throw new Response(null, {
      status: 302,
      headers: { Location: "/login" },
    });
  }

  // Construct acting user for M2M API calls
  const actingUser: ActingUser = {
    id: currentUser.id,
    email: currentUser.email,
    roles: currentUser.roles || [],
  };

  const authServerUrl = getAuthServerUrl(request, env);
  const user = { id: currentUser.id, email: currentUser.email };

  try {
    // Fetch clients via M2M API
    const clientsResponse = await listClients(env, actingUser);

    if (isErrorResponse(clientsResponse)) {
      logger.error("Error loading clients:", { error: clientsResponse.error });
      return { clients: [], authServerUrl, user };
    }

    return { clients: clientsResponse.clients, authServerUrl, user };
  } catch (error) {
    logger.error("Error loading clients:", { error });
    return { clients: [], authServerUrl, user };
  }
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getCloudflare(context).env as {
    AUTH_STORAGE: KVNamespace;
    AUTH_SERVER_URL?: string;
    ADMIN_CLIENT_ID?: string;
    ADMIN_CLIENT_SECRET?: string;
  };

  let currentUser: { id: string; email: string; roles: string[] };
  try {
    currentUser = await requireAuth(request, env, true) as { id: string; email: string; roles: string[] };
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }
    return { error: "Unauthorized" };
  }

  // Construct acting user for M2M API calls
  const actingUser: ActingUser = {
    id: currentUser.id,
    email: currentUser.email,
    roles: currentUser.roles || [],
  };

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create") {
    const name = formData.get("name") as string;
    const redirectUrisStr = formData.get("redirect_uris") as string;
    const redirectUris = redirectUrisStr ? redirectUrisStr.split("\n").filter(u => u.trim()) : [];
    const grantTypes = formData.getAll("grant_types") as string[];
    const scopes = formData.getAll("scopes") as string[];
    const metadataStr = formData.get("metadata") as string;

    let metadata: Record<string, unknown> = {};
    try {
      if (metadataStr && metadataStr.trim()) {
        metadata = JSON.parse(metadataStr);
      }
    } catch {
      return { error: "Invalid metadata JSON" };
    }

    const result = await createClient(env, actingUser, {
      name,
      redirect_uris: redirectUris.length > 0 ? redirectUris : undefined,
      grant_types: grantTypes.length > 0 ? grantTypes : ["authorization_code", "refresh_token"],
      scopes: scopes.length > 0 ? scopes : ["openid", "profile", "email"],
      metadata,
    });

    if (isErrorResponse(result)) {
      return { error: result.error };
    }

    // Return both client_id and client_secret for the confirmation dialog
    return {
      success: true,
      created_client_id: result.client_id,
      client_secret: result.client_secret,
    };
  }

  if (intent === "delete") {
    const clientId = formData.get("client_id") as string;

    // Soft delete: disabled at once, restorable from Recently deleted for 30 days
    const reason = String(formData.get("reason") ?? "").trim() || undefined;
    const result = await deleteOAuthClient(env, actingUser, clientId, reason);

    if (isErrorResponse(result)) {
      return { error: result.error };
    }

    return { success: true };
  }

  if (intent === "rotate_secret") {
    const clientId = formData.get("client_id") as string;

    const result = await rotateClientSecret(env, actingUser, clientId);

    if (isErrorResponse(result)) {
      return { error: result.error };
    }

    return { success: true, newSecret: result.client_secret };
  }

  if (intent === "update") {
    const clientId = formData.get("client_id") as string;
    const redirectUris = (formData.get("redirect_uris") as string).split("\n").filter(u => u.trim());
    const grantTypes = formData.getAll("grant_types") as string[];
    const scopes = formData.getAll("scopes") as string[];
    const metadataStr = formData.get("metadata") as string;

    let metadata: Record<string, unknown> = {};
    try {
      if (metadataStr && metadataStr.trim()) {
        metadata = JSON.parse(metadataStr);
      }
    } catch {
      return { error: "Invalid metadata JSON" };
    }

    const result = await updateClient(env, actingUser, clientId, {
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      scopes,
      metadata,
    });

    if (isErrorResponse(result)) {
      return { error: result.error };
    }

    return { success: true };
  }

  return { error: "Unknown action" };
}

interface FetcherData {
  success?: boolean;
  error?: string;
  created_client_id?: string;
  client_secret?: string;
  newSecret?: string;
}

export default function ClientsPage() {
  const { clients, user, authServerUrl } = useLoaderData<LoaderData>();
  const fetcher = useFetcher<FetcherData>();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [rotating, setRotating] = useState<OAuthClient | null>(null);
  const [searchParams] = useSearchParams();
  const deleteLang = langOf(searchParams);
  const deleteCopy = deletionCopy(deleteLang);
  const copy = confirmCopy(deleteLang);
  const lang = deleteLang;
  const t = pagesCopy(lang).clients;
  const c = pagesCopy(lang).common;
  const [secretDialogOpen, setSecretDialogOpen] = useState(false);
  const [selectedClient, setSelectedClient] = useState<OAuthClient | null>(null);
  const [createdClientId, setCreatedClientId] = useState<string | null>(null);
  const [newClientSecret, setNewClientSecret] = useState<string | null>(null);
  const [copiedClientId, setCopiedClientId] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state for create
  const [newClientName, setNewClientName] = useState("");
  const [newRedirectUris, setNewRedirectUris] = useState("");
  const [newGrantTypes, setNewGrantTypes] = useState<string[]>(["authorization_code", "refresh_token"]);
  const [newScopes, setNewScopes] = useState<string[]>(["openid", "profile", "email"]);
  const [newMetadata, setNewMetadata] = useState("{}");

  // Open create dialog
  const openCreateDialog = () => {
    setNewClientName("");
    setNewRedirectUris("");
    setNewGrantTypes(["authorization_code", "refresh_token"]);
    setNewScopes(["openid", "profile", "email"]);
    setNewMetadata("{}");
    setCreateDialogOpen(true);
  };

  const copyClientId = () => {
    if (createdClientId) {
      navigator.clipboard.writeText(createdClientId);
      setCopiedClientId(true);
      setTimeout(() => setCopiedClientId(false), 2000);
    }
  };

  const copySecret = () => {
    if (newClientSecret) {
      navigator.clipboard.writeText(newClientSecret);
      setCopiedSecret(true);
      setTimeout(() => setCopiedSecret(false), 2000);
    }
  };

  // Form state for edit
  const [editRedirectUris, setEditRedirectUris] = useState("");
  const [editAllowedGrants, setEditAllowedGrants] = useState<string[]>([]);
  const [editScopes, setEditScopes] = useState<string[]>([]);
  const [editMetadata, setEditMetadata] = useState("{}");

  const isLoading = fetcher.state !== "idle";

  // Handle fetcher responses - setState in effect is valid for React Router fetcher pattern
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (fetcher.data) {
      if (fetcher.data.error) {
        setError(fetcher.data.error);
      } else if (fetcher.data.success) {
        setError(null);

        // Handle new client creation - show both client_id and client_secret
        if (fetcher.data.created_client_id && fetcher.data.client_secret) {
          setCreatedClientId(fetcher.data.created_client_id);
          setNewClientSecret(fetcher.data.client_secret);
          setSecretDialogOpen(true);
          setCreateDialogOpen(false);
          setNewClientName("");
          setNewRedirectUris("");
          setNewGrantTypes(["authorization_code", "refresh_token"]);
          setNewScopes(["openid", "profile", "email"]);
          setNewMetadata("{}");
        }

        // Handle client secret from rotate (only secret, no client_id change)
        if (fetcher.data.newSecret) {
          setCreatedClientId(null); // Clear since this is just a rotation
          setNewClientSecret(fetcher.data.newSecret);
          setSecretDialogOpen(true);
        }

        // Close dialogs on success
        if (deleteDialogOpen) {
          setDeleteDialogOpen(false);
          setSelectedClient(null);
        }
        if (editDialogOpen) {
          setEditDialogOpen(false);
          setSelectedClient(null);
        }
      }
    }
  }, [fetcher.data, deleteDialogOpen, editDialogOpen]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleCreate = () => {
    setError(null);
    const formData = new FormData();
    formData.append("intent", "create");
    formData.append("name", newClientName);
    formData.append("redirect_uris", newRedirectUris);
    newGrantTypes.forEach(grant => formData.append("grant_types", grant));
    newScopes.forEach(scope => formData.append("scopes", scope));
    formData.append("metadata", newMetadata);

    fetcher.submit(formData, { method: "POST" });
  };

  const handleDelete = ({ reason }: { reason: string }) => {
    if (!selectedClient) return;
    setError(null);

    const formData = new FormData();
    formData.append("intent", "delete");
    formData.append("client_id", selectedClient.client_id);
    if (reason) formData.append("reason", reason);

    fetcher.submit(formData, { method: "POST" });
  };

  const handleUpdate = () => {
    if (!selectedClient) return;
    setError(null);

    const formData = new FormData();
    formData.append("intent", "update");
    formData.append("client_id", selectedClient.client_id);
    formData.append("redirect_uris", editRedirectUris);
    editAllowedGrants.forEach(grant => formData.append("grant_types", grant));
    editScopes.forEach(scope => formData.append("scopes", scope));
    formData.append("metadata", editMetadata);

    fetcher.submit(formData, { method: "POST" });
  };

  const handleRotateSecret = (client: OAuthClient) => {
    setError(null);

    const formData = new FormData();
    formData.append("intent", "rotate_secret");
    formData.append("client_id", client.client_id);

    fetcher.submit(formData, { method: "POST" });
  };

  const openEditDialog = (client: OAuthClient) => {
    setSelectedClient(client);
    setEditRedirectUris(client.redirect_uris.join("\n"));
    setEditAllowedGrants(client.allowed_grants);
    setEditScopes(client.scopes || []);
    setEditMetadata(JSON.stringify(client.metadata || {}, null, 2));
    setEditDialogOpen(true);
  };

  const toggleGrant = (grant: string, grants: string[], setGrants: (g: string[]) => void) => {
    if (grants.includes(grant)) {
      setGrants(grants.filter(g => g !== grant));
    } else {
      setGrants([...grants, grant]);
    }
  };

  const availableGrants = ["authorization_code", "refresh_token", "client_credentials"].map((value) => ({ value, label: t.grantNames[value] ?? value }));

  const availableScopes = [
    // Scope names are protocol values (shown as they are); the hint is in the page's language
    { value: "openid", label: "OpenID" },
    { value: "profile", label: "Profile" },
    { value: "email", label: "Email" },
    { value: "offline_access", label: "Offline Access" },
    { value: "admin", label: "Admin" },
    { value: "admin:users", label: "Admin: Users" },
    { value: "admin:roles", label: "Admin: Roles" },
    { value: "admin:clients", label: "Admin: Clients" },
    { value: "admin:audit", label: "Admin: Audit" },
  ].map((scope) => ({ ...scope, description: t.scopeHints[scope.value] ?? "" }));

  const toggleScope = (scope: string, scopes: string[], setScopes: (s: string[]) => void) => {
    if (scopes.includes(scope)) {
      setScopes(scopes.filter(s => s !== scope));
    } else {
      setScopes([...scopes, scope]);
    }
  };

  const typeBadge = (client: OAuthClient) => (
    <Badge variant={client.client_type === "confidential" ? "default" : "secondary"}>
      {client.client_type === "confidential" ? (
        <><Lock className="me-1 h-3 w-3" aria-hidden="true" /> {t.confidential}</>
      ) : (
        <><Globe className="me-1 h-3 w-3" aria-hidden="true" /> {t.public}</>
      )}
    </Badge>
  );
  const grantBadges = (client: OAuthClient) =>
    client.allowed_grants.map((grant) => (
      <Badge key={grant} variant="outline" className="text-xs">
        {t.grantNames[grant] ?? grant.replace(/_/g, " ")}
      </Badge>
    ));
  const scopeBadges = (client: OAuthClient) => (
    <>
      {(client.scopes || []).slice(0, 3).map((scope) => (
        <Badge key={scope} variant="secondary" className="text-xs" dir="ltr">
          {scope}
        </Badge>
      ))}
      {(client.scopes || []).length > 3 && (
        <Badge variant="secondary" className="text-xs">
          {t.plus(client.scopes.length - 3)}
        </Badge>
      )}
    </>
  );
  const redirectList = (client: OAuthClient) => (
    <>
      {client.redirect_uris.slice(0, 2).map((uri, i) => (
        <div key={i} className="text-xs text-muted-foreground truncate" dir="ltr" title={uri}>
          {uri}
        </div>
      ))}
      {client.redirect_uris.length > 2 && <div className="text-xs text-muted-foreground">{t.more(client.redirect_uris.length - 2)}</div>}
    </>
  );
  const clientActions = (client: OAuthClient) => (
    <>
      <Button variant="ghost" size="sm" onClick={() => openEditDialog(client)} title={t.edit} aria-label={t.editOf(client.name)}>
        <Settings className="h-4 w-4" aria-hidden="true" />
      </Button>
      {client.client_type === "confidential" && (
        <Button variant="ghost" size="sm" onClick={() => setRotating(client)} title={t.rotate} aria-label={t.rotateOf(client.name)}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setSelectedClient(client);
          setDeleteDialogOpen(true);
        }}
        className="text-destructive hover:text-destructive"
        title={t.delete}
        aria-label={t.deleteOf(client.name)}
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </Button>
    </>
  );

  return (
    <AdminLayout user={user} authServerUrl={authServerUrl} localized>
      <div className="mb-6">
        <div className="flex flex-wrap justify-between items-center gap-3">
          <div>
            <h2 className="text-3xl font-bold text-[var(--color-foreground)] mb-2">{t.title}</h2>
            <p className="text-[var(--color-muted-foreground)]">{t.intro}</p>
          </div>
          <Button onClick={openCreateDialog}>
            <Plus className="me-2 h-4 w-4" aria-hidden="true" />
            {t.add}
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive" dir="auto">
          {error === "Invalid metadata JSON" && lang === "ar" ? "البيانات الوصفية ليست JSON صحيحًا." : error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t.tableTitle}</CardTitle>
          <CardDescription>{t.count(clients.length)}</CardDescription>
        </CardHeader>
        <CardContent>
          {clients.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {t.empty}
            </div>
          ) : (
            <>
              {/* Phone: a card per client; a table from md up */}
              <ul className="space-y-3 md:hidden" data-testid="client-cards">
                {clients.map((client) => (
                  <li key={client.id} className="rounded-lg border border-[var(--color-border)] p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium"><bdi>{client.name}</bdi></div>
                        <div className="font-mono text-xs text-muted-foreground break-all" dir="ltr">{client.client_id}</div>
                      </div>
                      {typeBadge(client)}
                    </div>
                    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                      <dt className="text-muted-foreground">{t.grants}</dt>
                      <dd className="flex flex-wrap gap-1">{grantBadges(client)}</dd>
                      <dt className="text-muted-foreground">{t.scopes}</dt>
                      <dd className="flex flex-wrap gap-1">{scopeBadges(client)}</dd>
                      <dt className="text-muted-foreground">{t.redirects}</dt>
                      <dd className="min-w-0">{redirectList(client)}</dd>
                      <dt className="text-muted-foreground">{c.created}</dt>
                      <dd>{formatDate(client.created_at, lang)}</dd>
                    </dl>
                    <div className="mt-3 flex justify-end gap-2">{clientActions(client)}</div>
                  </li>
                ))}
              </ul>
              <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{c.name}</TableHead>
                  <TableHead>{t.clientId}</TableHead>
                  <TableHead>{t.type}</TableHead>
                  <TableHead>{t.grants}</TableHead>
                  <TableHead>{t.scopes}</TableHead>
                  <TableHead>{t.redirects}</TableHead>
                  <TableHead>{c.created}</TableHead>
                  <TableHead className="text-end">{c.actions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clients.map((client) => (
                  <TableRow key={client.id}>
                    <TableCell className="font-medium"><bdi>{client.name}</bdi></TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground" dir="ltr">{client.client_id}</TableCell>
                    <TableCell>{typeBadge(client)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">{grantBadges(client)}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1 max-w-[150px]">{scopeBadges(client)}</div>
                    </TableCell>
                    <TableCell>
                      <div className="max-w-[200px]">{redirectList(client)}</div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{formatDate(client.created_at, lang)}</TableCell>
                    <TableCell className="text-end">
                      <div className="flex justify-end gap-2">{clientActions(client)}</div>
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

      {/* Create Client Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-md" dir={dirOf(lang)} lang={lang}>
          <DialogHeader>
            <DialogTitle>{t.createTitle}</DialogTitle>
            <DialogDescription>{t.createIntro}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="client_name">{t.nameLabel}</Label>
              <Input
                id="client_name"
                value={newClientName}
                onChange={(e) => setNewClientName(e.target.value)}
                placeholder={t.namePlaceholder}
              />
              <p className="text-xs text-muted-foreground">{t.nameHint}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="redirect_uris">{t.redirectsLabel}</Label>
              <textarea
                id="redirect_uris"
                className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                dir="ltr"
                placeholder="https://example.com/callback"
                value={newRedirectUris}
                onChange={(e) => setNewRedirectUris(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>{t.grantTypes}</Label>
              <div className="space-y-2">
                {availableGrants.map((grant) => (
                  <label key={grant.value} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={newGrantTypes.includes(grant.value)}
                      onChange={() => toggleGrant(grant.value, newGrantTypes, setNewGrantTypes)}
                      className="rounded border-[var(--color-input)] accent-[var(--color-primary)]"
                    />
                    <span className="text-sm">{grant.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Scopes</Label>
              <div className="grid grid-cols-2 gap-2">
                {availableScopes.map((scope) => (
                  <label key={scope.value} className="flex items-center gap-2" title={scope.description}>
                    <input
                      type="checkbox"
                      checked={newScopes.includes(scope.value)}
                      onChange={() => toggleScope(scope.value, newScopes, setNewScopes)}
                      className="rounded border-[var(--color-input)] accent-[var(--color-primary)]"
                    />
                    <span className="text-sm" dir="ltr">{scope.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new_metadata">{t.metadata}</Label>
              <textarea
                id="new_metadata"
                className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                placeholder="{}"
                value={newMetadata}
                onChange={(e) => setNewMetadata(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t.metadataHint}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              {c.cancel}
            </Button>
            <Button onClick={handleCreate} disabled={isLoading || !newClientName.trim()}>
              {isLoading ? t.creating : t.createButton}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Client Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-md" dir={dirOf(lang)} lang={lang}>
          <DialogHeader>
            <DialogTitle>{t.editTitle(selectedClient?.name ?? "")}</DialogTitle>
            <DialogDescription>
              {t.editIntro} <bdi className="font-mono">{selectedClient?.client_id}</bdi>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit_redirect_uris">{t.redirectsLabel}</Label>
              <textarea
                id="edit_redirect_uris"
                dir="ltr"
                className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={editRedirectUris}
                onChange={(e) => setEditRedirectUris(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>{t.allowedGrants}</Label>
              <div className="space-y-2">
                {availableGrants.map((grant) => (
                  <label key={grant.value} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={editAllowedGrants.includes(grant.value)}
                      onChange={() => toggleGrant(grant.value, editAllowedGrants, setEditAllowedGrants)}
                      className="rounded border-[var(--color-input)] accent-[var(--color-primary)]"
                    />
                    <span className="text-sm">{grant.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Scopes</Label>
              <div className="grid grid-cols-2 gap-2">
                {availableScopes.map((scope) => (
                  <label key={scope.value} className="flex items-center gap-2" title={scope.description}>
                    <input
                      type="checkbox"
                      checked={editScopes.includes(scope.value)}
                      onChange={() => toggleScope(scope.value, editScopes, setEditScopes)}
                      className="rounded border-[var(--color-input)] accent-[var(--color-primary)]"
                    />
                    <span className="text-sm" dir="ltr">{scope.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit_metadata">{t.metadata}</Label>
              <textarea
                id="edit_metadata"
                className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                placeholder="{}"
                value={editMetadata}
                onChange={(e) => setEditMetadata(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              {c.cancel}
            </Button>
            <Button onClick={handleUpdate} disabled={isLoading}>
              {isLoading ? (lang === "ar" ? c.saving : "Saving...") : t.saveChanges}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation: soft delete, restorable from Recently deleted */}
      <ConfirmDialog
        open={deleteDialogOpen}
        title={deleteCopy.deleteTitle("client")}
        description={deleteCopy.deleteBody("client", selectedClient?.name ?? "")}
        confirmLabel={deleteCopy.deleteConfirm}
        cancelLabel={deleteCopy.cancel}
        reason={{ label: deleteCopy.reasonLabel, placeholder: deleteCopy.reasonPlaceholder }}
        busy={isLoading}
        error={deleteDialogOpen ? error : null}
        dir={dirOf(deleteLang)}
        lang={deleteLang}
        onCancel={() => setDeleteDialogOpen(false)}
        onConfirm={handleDelete}
      />

      {/* Rotating ends the old secret at once: ask first */}
      <ConfirmDialog
        open={!!rotating}
        title={copy.rotateSecret.title}
        description={rotating ? copy.rotateSecret.body(rotating.name, rotating.client_id) : ""}
        confirmLabel={copy.rotateSecret.confirm}
        cancelLabel={copy.cancel}
        dir={dirOf(deleteLang)}
        lang={deleteLang}
        onCancel={() => setRotating(null)}
        onConfirm={() => {
          if (rotating) handleRotateSecret(rotating);
          setRotating(null);
        }}
      />

      {/* Credentials Display Dialog (shown after client creation or secret rotation) */}
      <Dialog open={secretDialogOpen} onOpenChange={(open) => {
        setSecretDialogOpen(open);
        if (!open) {
          setCreatedClientId(null);
          setNewClientSecret(null);
        }
      }}>
        <DialogContent dir={dirOf(lang)} lang={lang}>
          <DialogHeader>
            <DialogTitle>
              <Key className="inline me-2 h-5 w-5" aria-hidden="true" />
              {createdClientId ? t.credentialsTitle : t.secretTitle}
            </DialogTitle>
            <DialogDescription>{createdClientId ? t.credentialsIntro : t.secretIntro}</DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            {/* Show Client ID only for new client creation */}
            {createdClientId && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t.clientId}</Label>
                <div className="flex items-center gap-2">
                  <code className="ui-code flex-1 p-3 rounded-md font-mono text-sm break-all" dir="ltr">
                    {createdClientId}
                  </code>
                  <Button variant="outline" size="sm" onClick={copyClientId} aria-label={copiedClientId ? c.copied : t.copyId}>
                    {copiedClientId ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            )}
            {/* Always show Client Secret */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">{t.secret}</Label>
              <div className="flex items-center gap-2">
                <code className="ui-code flex-1 p-3 rounded-md font-mono text-sm break-all" dir="ltr">
                  {newClientSecret}
                </code>
                <Button variant="outline" size="sm" onClick={copySecret} aria-label={copiedSecret ? c.copied : t.copySecret}>
                  {copiedSecret ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <p className="text-sm text-[var(--color-warning-text)]">
              {t.keepSafe}
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => {
              setSecretDialogOpen(false);
              setCreatedClientId(null);
              setNewClientSecret(null);
            }}>
              {t.done}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
