import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { getAppUrl } from "../lib/config";
import { getOpenAuthClient } from "../lib/openauth.client.server";
import { logger } from "../lib/logger.server";

// Redirect directly to auth server instead of showing a login page
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as { APP_URL?: string; AUTH_SERVER_URL?: string };
  const ctx = context?.cloudflare?.ctx as ExecutionContext;

  // Initialize logger
  logger.setDatabase(null, false);
  if (ctx) logger.setContext(ctx);
  
  logger.logLoader('login', request);

  const appUrl = getAppUrl(request, env);
  const client = getOpenAuthClient(request, env);

  // Generate authorize URL using OpenAuth client
  // Use prompt=select_account to show account picker on first login
  logger.debug('Generating authorize URL for login');
  const { url: baseAuthorizeUrl } = await client.authorize(`${appUrl}/auth/callback`, "code");
  const authorizeUrl = `${baseAuthorizeUrl}&prompt=select_account`;
  logger.info('Redirecting to auth server', { authorizeUrl });

  return redirect(authorizeUrl);
}

export default function Login() {
  // This should never render as loader redirects
  return (
    <div className="min-h-screen bg-[rgb(var(--color-background))] flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[rgb(var(--color-primary))] mx-auto mb-4"></div>
        <p className="text-[rgb(var(--color-foreground))]">Redirecting to authentication...</p>
      </div>
    </div>
  );
}
