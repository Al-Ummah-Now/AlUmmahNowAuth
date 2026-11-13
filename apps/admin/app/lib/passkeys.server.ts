import { requireAuth } from "./auth.server";
import type { ActingUser } from "./admin-api.server";
import type { PasskeyClaims } from "../../../../packages/ui/src/passkey-policy.ts";

export type AdminEnv = { AUTH_DB?: D1Database; AUTH_STORAGE: KVNamespace; AUTH_SERVER_URL?: string; APP_URL?: string; ADMIN_CLIENT_ID?: string; ADMIN_CLIENT_SECRET?: string };

export interface AdminSessionUser extends ActingUser {
  claims?: PasskeyClaims;
  passkeyGraceUntil?: number;
}

/** The signed-in admin (redirects to sign-in, the account picker or "Passkey needed"). */
export async function adminUserOf(request: Request, env: AdminEnv): Promise<AdminSessionUser> {
  try {
    const user = (await requireAuth(request, env, true)) as AdminSessionUser;
    return { ...user, roles: user.roles || [] };
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response(null, { status: 302, headers: { Location: "/login" } });
  }
}

export function actingOf(user: AdminSessionUser): ActingUser {
  return { id: user.id, email: user.email, roles: user.roles };
}

export const isSuperAdmin = (roles: string[]) => roles.some((r) => r.trim().toLowerCase().replace(/[\s-]+/g, "_") === "super_admin");
