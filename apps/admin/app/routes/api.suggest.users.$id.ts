import type { LoaderFunctionArgs } from "react-router";
import { resolveUser } from "../lib/suggest-users.server";
import { getCloudflare } from "../lib/cloudflare-context";

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  return resolveUser(request, getCloudflare(context).env as Parameters<typeof resolveUser>[1], params.id ?? "");
}
