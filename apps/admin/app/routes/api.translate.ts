import type { ActionFunctionArgs } from "react-router";
import { translateFields, validateTranslate, type TranslateEnv, type TranslateRequest } from "../lib/translate.server";

/**
 * POST /api/translate { from, to, texts[], field } → { items } | { error }
 * The browser calls this same-origin with its session cookie (SameSite=Strict);
 * the server calls AlUmmahNow admin-api (lib/translate.server.ts). 404 when the
 * service isn't configured.
 */
export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  const env = context?.cloudflare?.env as TranslateEnv;
  const body = (await request.json().catch(() => null)) as TranslateRequest | null;
  const invalid = validateTranslate(body);
  if (invalid) return Response.json({ error: invalid }, { status: 400 });
  const result = await translateFields(request, env, body!);
  if (!result.ok) return Response.json({ error: result.code }, { status: result.status });
  return Response.json({ items: result.items });
}

export function loader() {
  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}
