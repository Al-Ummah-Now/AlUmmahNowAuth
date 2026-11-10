import type { LoaderFunctionArgs } from "react-router";
import { errorMessage, themeActor, themesApi, type ThemeEnv } from "../lib/themes.server";

/** Downloads the theme package zip (theme.json + assets/). */
export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as ThemeEnv;
  const actor = await themeActor(request, env);
  const source = new URL(request.url).searchParams.get("source") === "draft" ? "draft" : "published";
  try {
    const upstream = await themesApi(env, actor, request).exportZip(params.id!, source);
    return new Response(upstream.body, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": upstream.headers.get("Content-Disposition") ?? `attachment; filename="${params.id}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return new Response(errorMessage(error), { status: (error as { status?: number }).status ?? 502, headers: { "Content-Type": "text/plain" } });
  }
}
