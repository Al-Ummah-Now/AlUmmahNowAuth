import { useState, useEffect } from "react";
import type { MetaFunction, LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { ArrowLeft, Plus, Key, Trash2, RefreshCw, Copy, Check, Globe, Lock, Settings } from "lucide-react";
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

export const meta: MetaFunction = () => {
  return [
    { title: "OAuth Clients - Al Ummah Now Admin" },
    { name: "description", content: "Manage OAuth clients" },
  ];
};

interface OAuthClient {
  id: string;
  client_id: string;
  client_type: "public" | "confidential";
  allowed_grants: string[];
  redirect_uris: string[];
  created_at: number;
}

interface LoaderData {
  clients: OAuthClient[];
  authServerUrl: string;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as {
    AUTH_DB: D1Database;
    AUTH_STORAGE: KVNamespace;
    AUTH_SERVER_URL?: string;
    ADMIN_CLIENT_ID?: string;
    ADMIN_CLIENT_SECRET?: string;
  };
  const ctx = context?.cloudflare?.ctx as ExecutionContext;

  // Initialize logger
  if (env?.AUTH_DB) {
    logger.setDatabase(env.AUTH_DB, true);
    if (ctx) logger.setContext(ctx);
  }

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

  try {
    // Fetch clients via M2M API
    const clientsResponse = await listClients(env, actingUser);

    if (isErrorResponse(clientsResponse)) {
      logger.error("Error loading clients:", { error: clientsResponse.error });
      return { clients: [], authServerUrl };
    }

    return { clients: clientsResponse.clients, authServerUrl };
  } catch (error) {
    logger.error("Error loading clients:", { error });
    return { clients: [], authServerUrl };
  }
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context?.cloudflare?.env as {
    AUTH_DB: D1Database;
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
    const clientId = formData.get("client_id") as string;
    const clientType = formData.get("client_type") as "public" | "confidential";
    const redirectUris = (formData.get("redirect_uris") as string).split("\n").filter(u => u.trim());
    const allowedGrants = formData.getAll("allowed_grants") as string[];

    const result = await createClient(env, actingUser, {
      client_id: clientId,
      client_type: clientType,
      redirect_uris: redirectUris,
      allowed_grants: allowedGrants.length > 0 ? allowedGrants : ["authorization_code", "refresh_token"],
    });

    if (isErrorResponse(result)) {
      return { error: result.error };
    }

    return { success: true, client_secret: result.client_secret };
  }

  if (intent === "delete") {
    const clientId = formData.get("client_id") as string;

    const result = await deleteOAuthClient(env, actingUser, clientId);

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
    const allowedGrants = formData.getAll("allowed_grants") as string[];

    const result = await updateClient(env, actingUser, clientId, {
      redirect_uris: redirectUris,
      allowed_grants: allowedGrants,
    });

    if (isErrorResponse(result)) {
      return { error: result.error };
    }

    return { success: true };
  }

  return { error: "Unknown action" };
}

export default function ClientsPage() {
  const { clients } = useLoaderData<LoaderData>();
  const fetcher = useFetcher<{ success?: boolean; error?: string; client_secret?: string; newSecret?: string }>();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [secretDialogOpen, setSecretDialogOpen] = useState(false);
  const [selectedClient, setSelectedClient] = useState<OAuthClient | null>(null);
  const [newClientSecret, setNewClientSecret] = useState<string | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state for create
  const [newClientId, setNewClientId] = useState("");
  const [newClientType, setNewClientType] = useState<"public" | "confidential">("public");
  const [newRedirectUris, setNewRedirectUris] = useState("");
  const [newAllowedGrants, setNewAllowedGrants] = useState<string[]>(["authorization_code", "refresh_token"]);

  // Form state for edit
  const [editRedirectUris, setEditRedirectUris] = useState("");
  const [editAllowedGrants, setEditAllowedGrants] = useState<string[]>([]);

  const isLoading = fetcher.state !== "idle";

  // Handle fetcher responses
  useEffect(() => {
    if (fetcher.data) {
      if (fetcher.data.error) {
        setError(fetcher.data.error);
      } else if (fetcher.data.success) {
        setError(null);

        // Handle client secret from create
        if (fetcher.data.client_secret) {
          setNewClientSecret(fetcher.data.client_secret);
          setSecretDialogOpen(true);
          setCreateDialogOpen(false);
          setNewClientId("");
          setNewClientType("public");
          setNewRedirectUris("");
          setNewAllowedGrants(["authorization_code", "refresh_token"]);
        }

        // Handle client secret from rotate
        if (fetcher.data.newSecret) {
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

  const handleCreate = () => {
    setError(null);
    const formData = new FormData();
    formData.append("intent", "create");
    formData.append("client_id", newClientId);
    formData.append("client_type", newClientType);
    formData.append("redirect_uris", newRedirectUris);
    newAllowedGrants.forEach(grant => formData.append("allowed_grants", grant));

    fetcher.submit(formData, { method: "POST" });
  };

  const handleDelete = () => {
    if (!selectedClient) return;
    setError(null);

    const formData = new FormData();
    formData.append("intent", "delete");
    formData.append("client_id", selectedClient.client_id);

    fetcher.submit(formData, { method: "POST" });
  };

  const handleUpdate = () => {
    if (!selectedClient) return;
    setError(null);

    const formData = new FormData();
    formData.append("intent", "update");
    formData.append("client_id", selectedClient.client_id);
    formData.append("redirect_uris", editRedirectUris);
    editAllowedGrants.forEach(grant => formData.append("allowed_grants", grant));

    fetcher.submit(formData, { method: "POST" });
  };

  const handleRotateSecret = (client: OAuthClient) => {
    setError(null);

    const formData = new FormData();
    formData.append("intent", "rotate_secret");
    formData.append("client_id", client.client_id);

    fetcher.submit(formData, { method: "POST" });
  };

  const copySecret = () => {
    if (newClientSecret) {
      navigator.clipboard.writeText(newClientSecret);
      setCopiedSecret(true);
      setTimeout(() => setCopiedSecret(false), 2000);
    }
  };

  const openEditDialog = (client: OAuthClient) => {
    setSelectedClient(client);
    setEditRedirectUris(client.redirect_uris.join("\n"));
    setEditAllowedGrants(client.allowed_grants);
    setEditDialogOpen(true);
  };

  const toggleGrant = (grant: string, grants: string[], setGrants: (g: string[]) => void) => {
    if (grants.includes(grant)) {
      setGrants(grants.filter(g => g !== grant));
    } else {
      setGrants([...grants, grant]);
    }
  };

  const availableGrants = [
    { value: "authorization_code", label: "Authorization Code" },
    { value: "refresh_token", label: "Refresh Token" },
    { value: "client_credentials", label: "Client Credentials" },
  ];

  return (
    <div className="container mx-auto py-6 px-4 max-w-6xl">
      <div className="mb-6">
        <Link to="/" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Dashboard
        </Link>
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold">OAuth Clients</h1>
            <p className="text-muted-foreground mt-1">Manage OAuth client applications</p>
          </div>
          <Button onClick={() => setCreateDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add Client
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Registered Clients</CardTitle>
          <CardDescription>
            {clients.length} OAuth client{clients.length !== 1 ? "s" : ""} registered
          </CardDescription>
        </CardHeader>
        <CardContent>
          {clients.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No OAuth clients registered yet. Click "Add Client" to create one.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client ID</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Grants</TableHead>
                  <TableHead>Redirect URIs</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clients.map((client) => (
                  <TableRow key={client.id}>
                    <TableCell className="font-mono text-sm">{client.client_id}</TableCell>
                    <TableCell>
                      <Badge variant={client.client_type === "confidential" ? "default" : "secondary"}>
                        {client.client_type === "confidential" ? (
                          <><Lock className="mr-1 h-3 w-3" /> Confidential</>
                        ) : (
                          <><Globe className="mr-1 h-3 w-3" /> Public</>
                        )}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {client.allowed_grants.map((grant) => (
                          <Badge key={grant} variant="outline" className="text-xs">
                            {grant.replace(/_/g, " ")}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="max-w-[200px]">
                        {client.redirect_uris.slice(0, 2).map((uri, i) => (
                          <div key={i} className="text-xs text-muted-foreground truncate" title={uri}>
                            {uri}
                          </div>
                        ))}
                        {client.redirect_uris.length > 2 && (
                          <div className="text-xs text-muted-foreground">
                            +{client.redirect_uris.length - 2} more
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(client.created_at * 1000).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEditDialog(client)}
                          title="Edit"
                        >
                          <Settings className="h-4 w-4" />
                        </Button>
                        {client.client_type === "confidential" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRotateSecret(client)}
                            title="Rotate Secret"
                          >
                            <RefreshCw className="h-4 w-4" />
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
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
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

      {/* Create Client Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create OAuth Client</DialogTitle>
            <DialogDescription>
              Register a new OAuth client application
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="client_id">Client ID</Label>
              <Input
                id="client_id"
                placeholder="my-app"
                value={newClientId}
                onChange={(e) => setNewClientId(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="client_type">Client Type</Label>
              <Select value={newClientType} onValueChange={(v) => setNewClientType(v as "public" | "confidential")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">
                    <div className="flex items-center">
                      <Globe className="mr-2 h-4 w-4" />
                      Public (SPAs, Mobile Apps)
                    </div>
                  </SelectItem>
                  <SelectItem value="confidential">
                    <div className="flex items-center">
                      <Lock className="mr-2 h-4 w-4" />
                      Confidential (Server-side)
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {newClientType === "public"
                  ? "For apps that cannot securely store secrets"
                  : "For server-side apps that can store secrets securely"}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="redirect_uris">Redirect URIs (one per line)</Label>
              <textarea
                id="redirect_uris"
                className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                placeholder="https://example.com/callback"
                value={newRedirectUris}
                onChange={(e) => setNewRedirectUris(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Allowed Grants</Label>
              <div className="space-y-2">
                {availableGrants.map((grant) => (
                  <label key={grant.value} className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={newAllowedGrants.includes(grant.value)}
                      onChange={() => toggleGrant(grant.value, newAllowedGrants, setNewAllowedGrants)}
                      className="rounded border-gray-300"
                    />
                    <span className="text-sm">{grant.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={isLoading || !newClientId || !newRedirectUris}>
              {isLoading ? "Creating..." : "Create Client"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Client Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Client: {selectedClient?.client_id}</DialogTitle>
            <DialogDescription>
              Update client configuration
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit_redirect_uris">Redirect URIs (one per line)</Label>
              <textarea
                id="edit_redirect_uris"
                className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={editRedirectUris}
                onChange={(e) => setEditRedirectUris(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Allowed Grants</Label>
              <div className="space-y-2">
                {availableGrants.map((grant) => (
                  <label key={grant.value} className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={editAllowedGrants.includes(grant.value)}
                      onChange={() => toggleGrant(grant.value, editAllowedGrants, setEditAllowedGrants)}
                      className="rounded border-gray-300"
                    />
                    <span className="text-sm">{grant.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleUpdate} disabled={isLoading}>
              {isLoading ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Client</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the client "{selectedClient?.client_id}"?
              This action cannot be undone and will invalidate all tokens issued to this client.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isLoading}>
              {isLoading ? "Deleting..." : "Delete Client"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Secret Display Dialog */}
      <Dialog open={secretDialogOpen} onOpenChange={(open) => {
        setSecretDialogOpen(open);
        if (!open) setNewClientSecret(null);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Key className="inline mr-2 h-5 w-5" />
              Client Secret
            </DialogTitle>
            <DialogDescription>
              Copy this secret now. It will not be shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="flex items-center gap-2">
              <code className="flex-1 p-3 bg-muted rounded-md font-mono text-sm break-all">
                {newClientSecret}
              </code>
              <Button variant="outline" size="sm" onClick={copySecret}>
                {copiedSecret ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="mt-3 text-sm text-amber-600 dark:text-amber-500">
              Store this secret securely. You will need to rotate it if lost.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => {
              setSecretDialogOpen(false);
              setNewClientSecret(null);
            }}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
