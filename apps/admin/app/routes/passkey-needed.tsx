import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { getAppUrl, getAuthServerUrl } from "../lib/config";
import { forbiddenLocale } from "../lib/forbidden";
import { loginPath, safeReturnPath } from "../lib/sign-in";

export const meta: MetaFunction = () => [{ title: "Passkey needed - Al Ummah Now Admin" }];

/**
 * Staff passkeys (AUTH-PASSKEYS): an admin whose token has no passkey sign-in
 * past their deadline lands here instead of the admin (and, in the grace
 * period, from the banner). Not an error page: it says why and offers
 * "Add a passkey" (the auth host's setup page, which comes back to a
 * prompt=login sign-in so the new token carries the passkey) and
 * "Sign in with a passkey". en/ar from ?lang=, Light/Dark from the theme.
 */
const COPY = {
  en: {
    title: "Passkey needed",
    grace: "Add a passkey",
    body: "Staff sign in to the admin tools with a passkey: your face, fingerprint or screen lock, or a security key.",
    hint: "If you already have a passkey, sign in with it. Otherwise add one now; it takes a few seconds.",
    add: "Add a passkey",
    signIn: "Sign in with a passkey",
    lost: "Lost your passkey? Ask another admin to send you a setup link.",
    other: "العربية",
  },
  ar: {
    title: "يلزم مفتاح مرور",
    grace: "أضف مفتاح مرور",
    body: "يسجّل فريق العمل الدخول إلى أدوات الإدارة بمفتاح مرور: بوجهك أو ببصمتك أو بقفل الشاشة أو بمفتاح أمان.",
    hint: "إن كان لديك مفتاح مرور فسجّل الدخول به، وإلا فأضف مفتاحًا الآن؛ فالأمر يستغرق ثواني.",
    add: "إضافة مفتاح مرور",
    signIn: "الدخول بمفتاح مرور",
    lost: "فقدت مفتاح المرور؟ اطلب من مشرف آخر أن يرسل إليك رابط إعداد.",
    other: "English",
  },
} as const;

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as { APP_URL?: string; AUTH_SERVER_URL?: string };
  const url = new URL(request.url);
  const locale = forbiddenLocale(request);
  const returnTo = safeReturnPath(url.searchParams.get("redirect"));
  const appUrl = getAppUrl(request, env);
  // After adding one, sign in again (prompt=login) so the admin's token says "passkey"
  const signInAgain = `${appUrl}${loginPath(returnTo, "login")}`;
  const setup = new URL("/passkeys/setup", getAuthServerUrl(request, env));
  setup.searchParams.set("return_to", signInAgain);
  if (locale === "ar") setup.searchParams.set("lang", "ar");
  const otherLanguage = new URL(url);
  otherLanguage.searchParams.set("lang", locale === "ar" ? "en" : "ar");
  return {
    locale,
    grace: url.searchParams.get("mode") === "grace",
    addUrl: setup.toString(),
    signInUrl: loginPath(returnTo, "login"),
    otherLanguageUrl: otherLanguage.pathname + otherLanguage.search,
  };
}

export default function PasskeyNeeded() {
  const { locale, grace, addUrl, signInUrl, otherLanguageUrl } = useLoaderData<typeof loader>();
  const t = COPY[locale];
  const button = "block w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-center";
  return (
    <div lang={locale} dir={locale === "ar" ? "rtl" : "ltr"} className="min-h-screen bg-[rgb(var(--color-background))] flex items-center justify-center p-5">
      <main className="rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-card,var(--color-background)))] p-8 max-w-[440px] w-full" data-testid="passkey-needed">
        <h1 className="text-2xl font-semibold mb-3 text-[rgb(var(--color-foreground))]">{grace ? t.grace : t.title}</h1>
        <p className="text-sm leading-relaxed mb-2 text-[rgb(var(--color-muted-foreground))]">{t.body}</p>
        <p className="text-sm leading-relaxed mb-6 text-[rgb(var(--color-muted-foreground))]">{t.hint}</p>
        <div className="flex flex-col gap-3">
          <a href={addUrl} data-testid="passkey-needed-add" className={`${button} bg-[rgb(var(--color-primary))] text-[rgb(var(--color-primary-foreground))]`}>
            {t.add}
          </a>
          <a href={signInUrl} data-testid="passkey-needed-signin" className={`${button} border border-[rgb(var(--color-border))] text-[rgb(var(--color-foreground))]`}>
            {t.signIn}
          </a>
        </div>
        <p className="text-xs mt-6 text-[rgb(var(--color-muted-foreground))]">{t.lost}</p>
        <p className="text-xs mt-3">
          <a href={otherLanguageUrl} className="underline text-[rgb(var(--color-foreground))]" lang={locale === "ar" ? "en" : "ar"}>
            {t.other}
          </a>
        </p>
      </main>
    </div>
  );
}
