/**
 * People are shown by name, never by raw id: display name, else first + last, else email
 * (packages/ui/src/display-name.ts). Looks the ids up by primary key in Auth D1 (never a scan),
 * in chunks under D1's bound-parameter limit. Missing or failing lookups just leave the id out.
 */
import { resolveUserDisplayName } from "../../../../packages/ui/src/display-name";
import { logger } from "./logger.server";

export async function userNames(db: D1Database | undefined, ids: Array<string | null | undefined>): Promise<Record<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  const out: Record<string, string> = {};
  if (!db || unique.length === 0) return out;
  try {
    for (let i = 0; i < unique.length; i += 50) {
      const chunk = unique.slice(i, i + 50);
      const { results } = await db
        .prepare(`SELECT id, email, name, metadata FROM users WHERE id IN (${chunk.map(() => "?").join(",")})`)
        .bind(...chunk)
        .all<{ id: string; email: string; name: string | null; metadata: string | null }>();
      for (const row of results ?? []) out[row.id] = resolveUserDisplayName(row) || row.email;
    }
  } catch (error) {
    logger.warn("User names lookup failed", { error: error instanceof Error ? error.message : String(error) });
  }
  return out;
}
