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

// Create OpenAuth client
export function getOpenAuthClient(request?: Request, env?: { AUTH_SERVER_URL?: string; ADMIN_CLIENT_ID?: string; OAUTH_CLIENT_ID?: string }) {
  const issuer = getAuthServerUrl(request, env);
  const clientId = getOAuthClientId(env);

  return createClient({
    clientID: clientId,
    issuer,
  });
}

export { subjects };
