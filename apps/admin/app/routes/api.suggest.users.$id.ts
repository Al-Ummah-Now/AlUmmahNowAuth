import type { LoaderFunctionArgs } from "react-router";
import { resolveUser } from "../lib/suggest-users.server";

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  return resolveUser(request, context?.cloudflare?.env as Parameters<typeof resolveUser>[1], params.id ?? "");
}
