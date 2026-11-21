import type { LoaderFunctionArgs } from "react-router";
import { suggestUsers } from "../lib/suggest-users.server";
import { getCloudflare } from "../lib/cloudflare-context";

export async function loader({ request, context }: LoaderFunctionArgs) {
  return suggestUsers(request, getCloudflare(context).env as Parameters<typeof suggestUsers>[1]);
}
