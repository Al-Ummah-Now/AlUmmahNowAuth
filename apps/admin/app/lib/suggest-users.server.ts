/**
 * The user autocomplete's reads (components/autocomplete.tsx), as resource routes:
 *   GET /api/suggest/users?q=   users whose name or email matches, or that id (auth server ?search=)
 *   GET /api/suggest/users?q=&cursor=  a picker's page before anything is typed (newest users; `next`)
 *   GET /api/suggest/users/:id  one user, for the chip of a chosen id
 * Admins only (requireAuth with requireAdmin), like every page here. The browser never holds the
 * M2M credentials: the calls go out from the Worker as the acting admin.
 */
import { requireAuth } from "./auth.server";
import { getUser, isErrorResponse, listUsers, type ActingUser, type User } from "./admin-api.server";
import type { Suggestion } from "./autocomplete-model";

export const SUGGEST_LIMIT = 8;
/** A picker's page before anything is typed */
export const INITIAL_LIMIT = 20;
const MAX_QUERY = 100;

type Env = Parameters<typeof requireAuth>[1] & { ADMIN_CLIENT_SECRET?: string };

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export function toSuggestion(u: Pick<User, "id" | "email" | "name">): Suggestion {
  const name = u.name?.trim();
  return { id: u.id, label: name || u.email, secondary: name ? u.email : null, imageUrl: null };
}

async function actingAdmin(request: Request, env: Env): Promise<ActingUser | Response> {
  try {
    const user = (await requireAuth(request, env, true)) as { id: string; email: string; roles?: string[] };
    return { id: user.id, email: user.email, roles: user.roles ?? [] };
  } catch (error) {
    // requireAuth answers a page request with a redirect; a fetch from the box gets a status instead
    if (error instanceof Response) return json({ error: error.status === 403 ? "forbidden" : "unauthenticated" }, error.status === 403 ? 403 : 401);
    throw error;
  }
}

export async function suggestUsers(request: Request, env: Env): Promise<Response> {
  const actor = await actingAdmin(request, env);
  if (actor instanceof Response) return actor;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY);
  if (!q) {
    // A picker opening (pickers open with content): the newest users, a page at a time, no COUNT
    const cursor = (url.searchParams.get("cursor") ?? "").slice(0, 100) || undefined;
    const res = await listUsers(env, actor, { limit: INITIAL_LIMIT, skipCount: true, ...(cursor ? { cursor } : {}) }, request);
    if (isErrorResponse(res)) return json({ error: "upstream" }, 502);
    return json({ items: res.users.map(toSuggestion), next: res.pagination?.hasMore ? (res.pagination.nextCursor ?? null) : null });
  }
  const res = await listUsers(env, actor, { search: q, limit: SUGGEST_LIMIT }, request);
  if (isErrorResponse(res)) return json({ error: "upstream" }, 502);
  const items = res.users.map(toSuggestion);
  // A pasted id goes first
  items.sort((a, b) => Number(b.id === q) - Number(a.id === q));
  return json({ items });
}

export async function resolveUser(request: Request, env: Env, id: string): Promise<Response> {
  const actor = await actingAdmin(request, env);
  if (actor instanceof Response) return actor;
  const res = await getUser(env, actor, id.slice(0, MAX_QUERY));
  return json({ item: isErrorResponse(res) ? null : toSuggestion(res) });
}
