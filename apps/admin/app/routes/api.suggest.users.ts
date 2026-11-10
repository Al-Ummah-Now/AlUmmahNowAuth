import type { LoaderFunctionArgs } from "react-router";
import { suggestUsers } from "../lib/suggest-users.server";

export async function loader({ request, context }: LoaderFunctionArgs) {
  return suggestUsers(request, context?.cloudflare?.env as Parameters<typeof suggestUsers>[1]);
}
