import { Link, useLocation, useSearchParams } from "react-router";
import {
  LayoutDashboard,
  Users,
  Shield,
  Key,
  Monitor,
  FileText,
  Flag,
  ChevronLeft,
  Menu,
  X,
  Palette,
  Trash2,
  KeyRound,
} from "lucide-react";
import { Button } from "./ui/button";
import { AccountSwitcher } from "@al-ummah-now/ui";
import { otherApps } from "../lib/app-links";
import { langOf } from "../lib/deletion-copy";
import { shellCopy, withLang, type NavKey } from "../lib/shell-copy";
import { ThemeToggle } from "./theme-toggle";
import { cn } from "../lib/utils";
import { useState, useCallback } from "react";

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
  { key: "clients", href: "/clients", icon: <Key className="h-5 w-5" /> },
  { key: "audit", href: "/audit", icon: <FileText className="h-5 w-5" /> },
  { key: "moderation", href: "/moderation", icon: <Flag className="h-5 w-5" /> },
  { key: "themes", href: "/themes", icon: <Palette className="h-5 w-5" /> },
  { key: "deleted", href: "/deleted", icon: <Trash2 className="h-5 w-5" /> },
  { key: "security", href: "/security", icon: <KeyRound className="h-5 w-5" /> },
];

interface AdminLayoutProps {
  children: React.ReactNode;
  user?: { id: string; email: string } | null;
  authServerUrl?: string;
  /** epoch s: staff grace end while this admin has no passkey sign-in (AUTH-PASSKEYS) */
  passkeyGraceUntil?: number;
}

export function AdminLayout({ children, user, authServerUrl, passkeyGraceUntil }: AdminLayoutProps) {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const lang = langOf(searchParams);
  const t = shellCopy(lang);
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
  const closeMobileMenu = useCallback(() => {
    setMobileOpen(false);
  }, []);

  const isActive = (href: string) => {
    if (href === "/") {
      return location.pathname === "/";
    }
    return location.pathname.startsWith(href);
  };

  return (
    <div data-shell="page" className="min-h-screen bg-[var(--color-background)]">
      {/* Top Navigation: dark in every theme and mode (AlUmmahNow docs/design/NAV.md) */}
      <nav data-shell="header" className="shell-header fixed top-0 inset-x-0 z-50 border-b border-[var(--fanous-c-nav-border)] text-[var(--fanous-c-nav-text)]">
        <div className="px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {/* Mobile menu toggle */}
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden text-[var(--fanous-c-nav-icon)] hover:bg-[var(--fanous-c-nav-hover)] hover:text-[var(--fanous-c-nav-text)]"
                onClick={() => setMobileOpen(!mobileOpen)}
                aria-label={mobileOpen ? t.closeMenu : t.openMenu}
                aria-expanded={mobileOpen}
                aria-controls="admin-rail"
              >
                {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
              </Button>
              {/* Desktop collapse toggle */}
              <Button
                variant="ghost"
                size="icon"
                className="hidden lg:flex text-[var(--fanous-c-nav-icon)] hover:bg-[var(--fanous-c-nav-hover)] hover:text-[var(--fanous-c-nav-text)]"
                onClick={toggleCollapsed}
                title={collapsed ? t.expand : t.collapse}
                aria-label={collapsed ? t.expand : t.collapse}
                aria-pressed={collapsed}
              >
                {collapsed ? <Menu className="h-5 w-5" /> : <ChevronLeft className="h-5 w-5 rtl:-scale-x-100" />}
              </Button>
            </div>
            <Link to={withLang("/", lang)} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
              <img
                src="https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png"
                alt={t.brand}
                className="h-9 w-9 rounded-lg"
              />
              <div className="hidden sm:block">
                <h1 className="text-lg font-bold text-[var(--fanous-c-nav-text)]">{t.brand}</h1>
                <p className="text-xs text-[var(--fanous-c-nav-active-text)]">{t.app}</p>
              </div>
            </Link>
            <div className="flex items-center gap-2">
              {user && authServerUrl && (
                <AccountSwitcher
                  authServerUrl={authServerUrl}
                  currentUser={user}
                  apps={otherApps(authServerUrl)}
                  clientId="1448ed27-39a6-417d-b4c8-07f881e81269"
                />
              )}
            </div>
          </div>
        </div>
      </nav>

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
          "shell-rail fixed start-0 top-[57px] bottom-0 z-40 transition-all duration-300",
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

          {/* Light / dark, at the foot of the rail (NAV.md: apps with a side rail put it there) */}
          <div className={cn("shell-foot flex items-center p-3", collapsed && !mobileOpen ? "lg:justify-center" : "")}>
            <ThemeToggle lang={lang} />
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main
        className={cn(
          "pt-[57px] transition-all duration-300",
          // Desktop: adjust padding based on collapsed state
          collapsed ? "lg:ps-16" : "lg:ps-56",
          // Mobile: no side padding
          "ps-0"
        )}
      >
        {/* Page content is English unless a page sets its own language (?lang=ar dialogs and pages) */}
        <div className="p-6" lang={lang === "ar" ? "en" : undefined} dir={lang === "ar" ? "ltr" : undefined}>
          {passkeyGraceUntil ? (
            <div role="status" data-testid="passkey-grace-banner" className="mb-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)] p-3 text-sm text-[var(--color-foreground)]">
              Add a passkey by {new Date(passkeyGraceUntil * 1000).toLocaleDateString("en-GB", { dateStyle: "long", timeZone: "UTC" })}: after that, the admin tools need a passkey sign-in.{" "}
              <Link className="font-semibold underline" to="/passkey-needed?mode=grace">Add a passkey</Link>
            </div>
          ) : null}
          {children}
        </div>
      </main>
    </div>
  );
}
