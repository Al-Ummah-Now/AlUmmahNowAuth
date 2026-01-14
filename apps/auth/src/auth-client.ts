// OpenAuth client for the auth app itself
import { createClient } from "@al-ummah-now/openauth/client";
import { createSubjects } from "@al-ummah-now/openauth/subject";
import * as v from "valibot";

// Define subjects matching the server
export const subjects = createSubjects({
  user: v.object({
    id: v.string(),
    email: v.pipe(v.string(), v.email()),
    roles: v.array(v.string()),
  }),
});

export function getAuthClient(issuerUrl: string, clientID: string = "web-app") {
  return createClient({
    clientID,
    issuer: issuerUrl,
  });
}
