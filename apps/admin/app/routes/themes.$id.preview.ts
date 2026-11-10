import type { ActionFunctionArgs } from "react-router";
import { errorMessage, themeActor, themesApi, type ThemeEnv } from "../lib/themes.server";

/** The builder's live preview: Auth renders the real page for the edited theme (scripts removed). */
export async function action({ request, context, params }: ActionFunctionArgs) {
  const env = context?.cloudflare?.env as ThemeEnv;
  const actor = await themeActor(request, env);
  const body = (await request.json()) as { theme?: unknown; page?: string; lang?: string; scheme?: string };
  try {
    const html = await themesApi(env, actor, request).preview({
      theme: body.theme,
      themeId: params.id,
      page: String(body.page ?? "sign-in"),
      lang: body.lang === "ar" ? "ar" : "en",
      scheme: body.scheme === "dark" ? "dark" : "light",
    });
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https:",
      },
    });
  } catch (error) {
    return new Response(errorMessage(error), { status: (error as { status?: number }).status ?? 502, headers: { "Content-Type": "text/plain" } });
  }
}

export function loader() {
  return new Response("Method not allowed", { status: 405 });
}
