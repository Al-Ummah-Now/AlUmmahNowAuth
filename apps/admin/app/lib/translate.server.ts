/**
 * Translate for staff-set English/Arabic fields (L10N rule, owner 2026-11-16):
 * client display names, theme name/description and the sign-in site title.
 *
 * The service is AlUmmahNow admin-api `POST /api/translate/fields` (Workers AI
 * through api-videos: the site's wording rules, the CMS glossary, Quran text
 * refused, a per-staff daily cap and an audit row). This server calls it with
 * the signed-in staff member's own access token, never from the browser and
 * never with a shared key: admin-api takes Auth admin tokens on that one
 * route only (AlUmmahNow token-audience ROUTE_AUDIENCES) and still checks
 * content:translate against the staff member's roles.
 *
 * Off (and invisible) unless VIDEOS_ADMIN_API_URL is set.
 */
import { getAuthenticatedUser, requireAuth, type SessionEnv } from "./auth.server";
import { logger } from "./logger.server";
import type { Lang } from "../../../../packages/ui/src/l10n/localized";

export type TranslateEnv = SessionEnv & {
  AUTH_SERVER_URL?: string;
  APP_URL?: string;
  ADMIN_CLIENT_ID?: string;
  /** AlUmmahNow admin-api origin, e.g. https://admin.api.alummahnow.net. Unset: no Translate buttons. */
  VIDEOS_ADMIN_API_URL?: string;
};

/** Same caps as admin-api (AlUmmahNow shared-types ADMIN_FIELD_TRANSLATE_LIMITS). */
export const TRANSLATE_LIMITS = { texts: 50, chars: 20_000, textChars: 5_000 } as const;
/** The fields this site translates (the audit and the prompt read it). */
export const TRANSLATE_FIELDS = ["clients.name", "themes.name", "themes.description", "themes.title"] as const;
export type TranslateField = (typeof TRANSLATE_FIELDS)[number];

export interface TranslateRequest {
  from: Lang;
  to: Lang;
  texts: string[];
  field: TranslateField;
}

export interface TranslateItem {
  /** The suggestion ('' when refused) */
  text: string;
  /** Quran text is never machine-translated: the admin pastes the official text. */
  refused?: "quran";
  quran?: Array<{ range: string; label: string }>;
}

export type TranslateResult =
  | { ok: true; items: TranslateItem[] }
  | { ok: false; status: number; code: string };

export function translateEnabled(env: Partial<TranslateEnv> | undefined): boolean {
  return !!env?.VIDEOS_ADMIN_API_URL?.trim();
}

const LANGS: readonly string[] = ["en", "ar"];

/** The request's problem as a code, or null when it is fine. */
export function validateTranslate(body: unknown): string | null {
  const b = body as Partial<TranslateRequest> | null;
  if (!b || typeof b !== "object") return "invalid_request";
  if (!LANGS.includes(b.from as string) || !LANGS.includes(b.to as string)) return "invalid_language";
  if (b.from === b.to) return "same_language";
  if (!(TRANSLATE_FIELDS as readonly string[]).includes(b.field as string)) return "invalid_field";
  if (!Array.isArray(b.texts) || !b.texts.length || b.texts.length > TRANSLATE_LIMITS.texts) return "too_many_texts";
  let chars = 0;
  for (const t of b.texts) {
    if (typeof t !== "string") return "invalid_request";
    if (t.length > TRANSLATE_LIMITS.textChars) return "text_too_long";
    chars += t.length;
  }
  return chars > TRANSLATE_LIMITS.chars ? "too_much_text" : null;
}

/**
 * Translates for the signed-in admin. Throws the sign-in redirect when the
 * session is gone (requireAuth also refreshes the tokens ahead of expiry).
 */
export async function translateFields(request: Request, env: TranslateEnv, body: TranslateRequest, fetcher: typeof fetch = fetch): Promise<TranslateResult> {
  if (!translateEnabled(env)) return { ok: false, status: 404, code: "feature_off" };
  const user = await requireAuth(request, env, true);
  // requireAuth refreshed the session's tokens; read the current access token (one row, by key)
  const session = await getAuthenticatedUser(request, env);
  const token = session?.tokens.access;
  if (!token) return { ok: false, status: 401, code: "unauthorized" };

  const url = `${env.VIDEOS_ADMIN_API_URL!.trim().replace(/\/$/, "")}/api/translate/fields`;
  let res: Response;
  try {
    res = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ from: body.from, to: body.to, texts: body.texts, field: body.field }),
    });
  } catch (error) {
    logger.error("[Translate] admin-api unreachable", { error: error instanceof Error ? error.message : String(error) });
    return { ok: false, status: 503, code: "unavailable" };
  }
  const answer = (await res.json().catch(() => null)) as
    | { success?: boolean; code?: string; error?: string; result?: { items?: Array<{ text?: unknown; refused?: unknown; quran?: unknown }> } }
    | null;
  if (!res.ok || !answer?.success) {
    const code = typeof answer?.code === "string" ? answer.code : typeof answer?.error === "string" && answer.error.length < 60 ? answer.error : "translation_failed";
    // Texts are never logged
    logger.warn("[Translate] Refused", { status: res.status, code, userId: (user as { id?: string }).id });
    return { ok: false, status: res.status === 401 || res.status === 403 || res.status === 429 || res.status === 503 ? res.status : 502, code };
  }
  const items = (answer.result?.items ?? []).map((i): TranslateItem => ({
    text: typeof i.text === "string" ? i.text : "",
    ...(i.refused === "quran" ? { refused: "quran" as const } : {}),
    ...(Array.isArray(i.quran) ? { quran: i.quran as TranslateItem["quran"] } : {}),
  }));
  if (items.length !== body.texts.length) return { ok: false, status: 502, code: "translation_failed" };
  return { ok: true, items };
}
