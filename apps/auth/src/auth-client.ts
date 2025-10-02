// OpenAuth client for the auth app itself
import { createClient } from "@openauthjs/openauth/client";
import { createSubjects } from "@openauthjs/openauth/subject";
import * as v from "valibot";

// Define subjects matching the server
export const subjects = createSubjects({
  user: v.object({
    id: v.string(),
    email: v.pipe(v.string(), v.email()),
    role: v.string(),
  }),
});

export function getAuthClient(issuerUrl: string, clientID: string = "web-app") {
  return createClient({
    clientID,
    issuer: issuerUrl,
  });
}
