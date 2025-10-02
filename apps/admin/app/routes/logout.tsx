import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { logger } from "~/lib/logger.server";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as { AUTH_DB?: D1Database; AUTH_STORAGE?: KVNamespace };
  const ctx = context?.cloudflare?.ctx as ExecutionContext;

  // Initialize logger
  if (env?.AUTH_DB) {
    logger.setDatabase(env.AUTH_DB, true);
    if (ctx) logger.setContext(ctx);
  }

  logger.logLoader('logout', request);

  // Get session cookie
  const cookieHeader = request.headers.get("Cookie");
  if (cookieHeader) {
    const cookies = Object.fromEntries(
      cookieHeader.split("; ").map(c => {
        const [key, ...v] = c.split("=");
        return [key, v.join("=")];
      })
    );

    const sessionToken = cookies["auth_session"];

    // Delete session from KV storage
    if (sessionToken && env?.AUTH_STORAGE) {
      try {
        await env.AUTH_STORAGE.delete(`session:${sessionToken}`);
        logger.logAuth('User logged out', { sessionToken: sessionToken.substring(0, 10) + '...' });
      } catch (error) {
        logger.error('Error deleting session', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  // Clear the session cookie and redirect to home
  return redirect("/", {
    headers: {
      "Set-Cookie": "auth_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    },
  });
}

export default function Logout() {
  return (
    <div className="min-h-screen bg-[rgb(var(--color-background))] flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[rgb(var(--color-primary))] mx-auto mb-4"></div>
        <p className="text-[rgb(var(--color-foreground))]">Logging out...</p>
      </div>
    </div>
  );
}
