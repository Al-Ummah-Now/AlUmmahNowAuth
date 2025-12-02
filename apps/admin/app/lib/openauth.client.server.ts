// OpenAuth client for admin dashboard
import { createClient } from "@meywd/openauth/client";
import { createSubjects } from "@meywd/openauth/subject";
import * as v from "valibot";
import { getAuthServerUrl } from "./config";

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
export function getOpenAuthClient(request?: Request, env?: { AUTH_SERVER_URL?: string }) {
  const issuer = getAuthServerUrl(request, env);

  return createClient({
    clientID: "admin-dashboard",
    issuer,
  });
}

export { subjects };
