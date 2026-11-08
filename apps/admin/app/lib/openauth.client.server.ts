// OpenAuth client for admin dashboard
import { createClient } from "@al-ummah-now/openauth/client";
import { createSubjects } from "@al-ummah-now/openauth/subject";
import * as v from "valibot";
import { getAuthServerUrl, getOAuthClientId } from "./config";

// Define subjects matching the auth server
const subjects = createSubjects({
  user: v.object({
    id: v.string(),
    email: v.pipe(v.string(), v.email()),
    roles: v.array(v.string()),
  }),
});

export type Subjects = typeof subjects;

type OpenAuthClient = ReturnType<typeof createClient>;

/**
 * One client per isolate (per issuer + client id). The client caches the
 * issuer's discovery document and JWKS inside itself, so a client per request
 * fetched both on every verify. Rebuilt every 10 minutes so a rotated signing
 * key is picked up.
 */
const CLIENT_TTL_MS = 10 * 60 * 1000;
const clients = new Map<string, { client: OpenAuthClient; createdAt: number }>();

export function getOpenAuthClient(request?: Request, env?: { AUTH_SERVER_URL?: string; ADMIN_CLIENT_ID?: string; OAUTH_CLIENT_ID?: string }) {
  const issuer = getAuthServerUrl(request, env);
  const clientId = getOAuthClientId(env);
  const key = `${issuer}|${clientId}`;
  const now = Date.now();
  const hit = clients.get(key);
  if (hit && now - hit.createdAt < CLIENT_TTL_MS && now >= hit.createdAt) return hit.client;
  const client = createClient({ clientID: clientId, issuer });
  clients.set(key, { client, createdAt: now });
  return client;
}

export { subjects };
