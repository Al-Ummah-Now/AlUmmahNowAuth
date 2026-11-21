import { formatDate } from "../../../../packages/ui/src/format.ts";
import { Link, useLocation, useRouteLoaderData, useSearchParams } from "react-router";
import {
  LayoutDashboard,
  Users,
  Shield,
  AppWindow,
  Monitor,
  FileText,
  Flag,
  Palette,
  Trash2,
  KeyRound,
  FileKey,
} from "lucide-react";
import { AccountSwitcher } from "@al-ummah-now/ui";
import { otherApps } from "../lib/app-links";
import { langOf } from "../lib/deletion-copy";
import { langSwitchHref, shellCopy, withLang, type NavKey } from "../lib/shell-copy";
import { Brand, EnvBadge, LangButton, MenuButton } from "./site-header";
import { ThemeToggle } from "./theme-toggle";
import { cn } from "../lib/utils";
import { useState } from "react";

interface NavItem {
  key: NavKey;
  href: string;
  icon: React.ReactNode;
}

const navItems: NavItem[] = [
  { key: "dashboard", href: "/", icon: <LayoutDashboard className="h-5 w-5" /> },
  { key: "users", href: "/users", icon: <Users className="h-5 w-5" /> },
  { key: "roles", href: "/roles", icon: <Shield className="h-5 w-5" /> },
  { key: "sessions", href: "/sessions", icon: <Monitor className="h-5 w-5" /> },
  { key: "clients", href: "/clients", icon: <AppWindow className="h-5 w-5" /> },
  { key: "audit", href: "/audit", icon: <FileText className="h-5 w-5" /> },
  { key: "moderation", href: "/moderation", icon: <Flag className="h-5 w-5" /> },
  { key: "themes", href: "/themes", icon: <Palette className="h-5 w-5" /> },
  { key: "deleted", href: "/deleted", icon: <Trash2 className="h-5 w-5" /> },
  { key: "security", href: "/security", icon: <KeyRound className="h-5 w-5" /> },
  { key: "signingKeys", href: "/signing-keys", icon: <FileKey className="h-5 w-5" /> },
];

interface AdminLayoutProps {
  children: React.ReactNode;
  user?: { id: string; email: string } | null;
  authServerUrl?: string;
  /** epoch s: staff grace end while this admin has no passkey sign-in (AUTH-PASSKEYS) */
  passkeyGraceUntil?: number;
  /** The page is written in both languages: its content follows ?lang= (others stay English). */
  localized?: boolean;
}

export function AdminLayout({ children, user, authServerUrl, passkeyGraceUntil, localized }: AdminLayoutProps) {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const lang = langOf(searchParams);
  const t = shellCopy(lang);
  const environment = useRouteLoaderData<{ environment?: string }>("root")?.environment;
  // Use lazy initializer to load from localStorage - avoids effect-based setState
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("sidebar-collapsed");
      return stored === "true";
    }
    return false;
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  // Persist collapsed state to localStorage
  const toggleCollapsed = () => {
    const newValue = !collapsed;
    setCollapsed(newValue);
    localStorage.setItem("sidebar-collapsed", String(newValue));
  };

  // Close mobile menu when navigating - called on link clicks
  const closeMobileMenu = () => setMobileOpen(false);

  const isActive = (href: string) => {
    if (href === "/") {
      return location.pathname === "/";
    }
    return location.pathname.startsWith(href);
  };

  return (
    <div data-shell="page" className="min-h-screen bg-[var(--color-background)]">
      {/* The shared header (AlUmmahNow docs/design/NAV.md "Header"): drawer toggle, brand, QA/stage
          badge, then language, light/dark and the account menu (no links to other sites: they are
          in the account menu's apps). Dark in every
          theme and mode; a theme's header material is its background (.shell-header) */}
      <header data-shell="header" data-testid="aun-header" className="aun-header shell-header" style={{ zIndex: 50 }}>
        {/* The drawer toggle (the videos site's: lucide menu in every state). Phones and tablets:
            open the drawer. Desktop: collapse the rail */}
        <span className="contents lg:hidden">
          <MenuButton
            label={mobileOpen ? t.closeMenu : t.openMenu}
            onClick={() => setMobileOpen(!mobileOpen)}
            expanded={mobileOpen}
            controls="admin-rail"
          />
        </span>
        <span className="hidden lg:contents">
          <MenuButton label={collapsed ? t.expand : t.collapse} onClick={toggleCollapsed} pressed={collapsed} />
        </span>
        <Brand lang={lang} href={withLang("/", lang)} app={t.app} />
        <EnvBadge environment={environment} lang={lang} />
        <div className="aun-header-tools">
          <LangButton lang={lang} href={langSwitchHref(location.pathname, location.search, lang)} />
          <ThemeToggle lang={lang} />
          {user && authServerUrl && (
            <AccountSwitcher
              authServerUrl={authServerUrl}
              currentUser={user}
              apps={otherApps(authServerUrl)}
              clientId="1448ed27-39a6-417d-b4c8-07f881e81269"
            />
          )}
        </div>
      </header>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Side rail (the drawer on phones) */}
      <aside
        id="admin-rail"
        data-shell="sidebar"
        className={cn(
          // below the header: 56px on phones, 64px from 640px (NAV.md "Header")
          "shell-rail fixed start-0 top-14 sm:top-16 bottom-0 z-40 transition-all duration-300",
          // Desktop: show based on collapsed state
          "hidden lg:block",
          collapsed ? "lg:w-16" : "lg:w-56",
          // Mobile: slide in/out
          mobileOpen && "block w-56"
        )}
      >
        <div className="flex flex-col h-full">
          {/* Navigation Items */}
          <nav aria-label={t.navLabel} className="flex-1 p-3 space-y-1 overflow-y-auto">
            {navItems.map((item) => (
              <Link
                key={item.href}
                to={withLang(item.href, lang)}
                onClick={closeMobileMenu}
                aria-current={isActive(item.href) ? "page" : undefined}
                className="shell-link flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors"
                title={collapsed ? t.nav[item.key] : undefined}
                aria-label={collapsed ? t.nav[item.key] : undefined}
              >
                {item.icon}
                {(!collapsed || mobileOpen) && <span>{t.nav[item.key]}</span>}
              </Link>
            ))}
          </nav>

        </div>
      </aside>

      {/* Main Content */}
      <main
        className={cn(
          // the header is sticky above it (NAV.md "Header")
          "transition-all duration-300",
          // Desktop: adjust padding based on collapsed state
          collapsed ? "lg:ps-16" : "lg:ps-56",
          // Mobile: no side padding
          "ps-0"
        )}
      >
        {/* Page content follows ?lang= on pages written in both languages (localized); the rest stay English */}
        <div className="p-4 md:p-6" lang={lang === "ar" && !localized ? "en" : undefined} dir={lang === "ar" && !localized ? "ltr" : undefined}>
          {passkeyGraceUntil ? (
            <div role="status" data-testid="passkey-grace-banner" className="mb-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)] p-3 text-sm text-[var(--color-foreground)]">
              {localized && lang === "ar" ? (
                <>
                  أضف مفتاح مرور قبل {formatDate(passkeyGraceUntil * 1000, "ar", { dateStyle: "long", timeZone: "UTC" })}: بعد ذلك تحتاج أدوات الإدارة إلى تسجيل الدخول بمفتاح مرور.{" "}
                  <Link className="font-semibold underline" to="/passkey-needed?mode=grace&lang=ar">إضافة مفتاح مرور</Link>
                </>
              ) : (
                <>
                  Add a passkey by {formatDate(passkeyGraceUntil * 1000, "en", { dateStyle: "long", timeZone: "UTC" })}: after that, the admin tools need a passkey sign-in.{" "}
                  <Link className="font-semibold underline" to="/passkey-needed?mode=grace">Add a passkey</Link>
                </>
              )}
            </div>
          ) : null}
          {children}
        </div>
      </main>
    </div>
  );
}
