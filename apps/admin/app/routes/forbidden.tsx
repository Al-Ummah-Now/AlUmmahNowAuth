import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { getAppUrl, getAuthServerUrl } from "../lib/config";
import { getOpenAuthClient } from "../lib/openauth.client.server";
import { FORBIDDEN_COPY, forbiddenLocale, profileAppUrl } from "../lib/forbidden";

/**
 * A signed-in user without an admin role. Stays put (no automatic redirect,
 * which looped through the account picker, #219) and offers sign out, another
 * account, or the user's apps. Every link is built here: nothing is taken
 * from the query string except the email, which is only displayed.
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as { APP_URL?: string; AUTH_SERVER_URL?: string; ADMIN_CLIENT_ID?: string };
  const url = new URL(request.url);
  const locale = forbiddenLocale(request);

  const appUrl = getAppUrl(request, env);
  const { url: authorizeUrl } = await getOpenAuthClient(request, env).authorize(`${appUrl}/auth/callback`, "code");
  const switchAccountUrl = new URL(authorizeUrl);
  switchAccountUrl.searchParams.set("prompt", "select_account");

  const otherLanguage = new URL(url);
  otherLanguage.searchParams.set("lang", locale === "ar" ? "en" : "ar");

  return {
    email: url.searchParams.get("email") ?? "",
    locale,
    switchAccountUrl: switchAccountUrl.toString(),
    profileUrl: profileAppUrl(getAuthServerUrl(request, env)),
    otherLanguageUrl: otherLanguage.pathname + otherLanguage.search,
  };
}

export default function Forbidden() {
  const { email, locale, switchAccountUrl, profileUrl, otherLanguageUrl } = useLoaderData<typeof loader>();
  const t = FORBIDDEN_COPY[locale];
  const button = "block w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors";

  return (
    <div
      lang={locale}
      dir={locale === "ar" ? "rtl" : "ltr"}
      className="min-h-screen bg-[#0f172a] flex items-center justify-center p-5 text-[#e2e8f0]"
    >
      <main className="bg-[#1e293b] rounded-xl p-8 max-w-[420px] w-full text-center shadow-lg" data-testid="forbidden">
        <div className="w-16 h-16 bg-red-500 rounded-full flex items-center justify-center mx-auto mb-5 text-3xl" aria-hidden="true">
          &#128274;
        </div>
        <h1 className="text-2xl font-semibold mb-3 text-[#f8fafc]">{t.title}</h1>
        {email && (
          <p className="text-[#94a3b8] text-sm mb-4">
            {t.signedInAs}: <bdi className="text-[#e2e8f0]">{email}</bdi>
          </p>
        )}
        <p className="text-[#94a3b8] text-sm leading-relaxed mb-2">{t.body}</p>
        <p className="text-[#94a3b8] text-sm leading-relaxed mb-6">{t.hint}</p>

        <div className="flex flex-col gap-3">
          <a href={switchAccountUrl} data-testid="forbidden-switch-account" className={`${button} bg-blue-600 hover:bg-blue-500 text-white`}>
            {t.switchAccount}
          </a>
          <a href="/logout" data-testid="forbidden-sign-out" className={`${button} bg-[#334155] hover:bg-[#475569] text-[#f8fafc]`}>
            {t.signOut}
          </a>
          <a href={profileUrl} data-testid="forbidden-your-apps" className={`${button} text-blue-400 hover:text-blue-300`}>
            {t.yourApps}
          </a>
        </div>

        <a href={otherLanguageUrl} className="inline-block mt-6 text-xs text-[#64748b] hover:text-[#94a3b8]" data-testid="forbidden-language">
          {t.otherLanguage}
        </a>
      </main>
    </div>
  );
}
