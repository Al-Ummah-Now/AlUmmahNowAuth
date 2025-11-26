// OpenAuth client for admin dashboard
import { createClient } from "@openauthjs/openauth/client";
import { createSubjects } from "@openauthjs/openauth/subject";
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
export function getOpenAuthClient(request?: Request, env?: Record<string, any>) {
  const issuer = getAuthServerUrl(request, env);

  return createClient({
    clientID: "admin-dashboard",
    issuer,
  });
}

export { subjects };
