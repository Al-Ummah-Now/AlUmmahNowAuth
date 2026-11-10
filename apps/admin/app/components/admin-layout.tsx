import { Link, useLocation } from "react-router";
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
} from "lucide-react";
import { Button } from "./ui/button";
import { AccountSwitcher } from "@al-ummah-now/ui";
import { cn } from "../lib/utils";
import { useState, useCallback } from "react";

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
}

const navItems: NavItem[] = [
  { label: "Dashboard", href: "/", icon: <LayoutDashboard className="h-5 w-5" /> },
  { label: "Users", href: "/users", icon: <Users className="h-5 w-5" /> },
  { label: "Roles", href: "/roles", icon: <Shield className="h-5 w-5" /> },
  { label: "Sessions", href: "/sessions", icon: <Monitor className="h-5 w-5" /> },
  { label: "OAuth Clients", href: "/clients", icon: <Key className="h-5 w-5" /> },
  { label: "Audit Logs", href: "/audit", icon: <FileText className="h-5 w-5" /> },
  { label: "Moderation", href: "/moderation", icon: <Flag className="h-5 w-5" /> },
];

interface AdminLayoutProps {
  children: React.ReactNode;
  user?: { id: string; email: string } | null;
  authServerUrl?: string;
}

export function AdminLayout({ children, user, authServerUrl }: AdminLayoutProps) {
  const location = useLocation();
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
    <div className="min-h-screen bg-[rgb(var(--color-background))]">
      {/* Top Navigation */}
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-card))]">
        <div className="px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {/* Mobile menu toggle */}
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden"
                onClick={() => setMobileOpen(!mobileOpen)}
              >
                {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
              </Button>
              {/* Desktop collapse toggle */}
              <Button
                variant="ghost"
                size="icon"
                className="hidden lg:flex"
                onClick={toggleCollapsed}
                title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              >
                {collapsed ? <Menu className="h-5 w-5" /> : <ChevronLeft className="h-5 w-5" />}
              </Button>
            </div>
            <Link to="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
              <img
                src="https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png"
                alt="Al Ummah Now"
                className="h-9 w-9 rounded-lg"
              />
              <div className="hidden sm:block">
                <h1 className="text-lg font-bold text-[rgb(var(--color-foreground))]">Al Ummah Now</h1>
                <p className="text-xs text-[rgb(var(--color-muted-foreground))]">Admin Dashboard</p>
              </div>
            </Link>
            <div className="flex items-center gap-2">
              {user && authServerUrl && (
                <AccountSwitcher
                  authServerUrl={authServerUrl}
                  currentUser={user}
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

      {/* Left Sidebar */}
      <aside
        className={cn(
          "fixed left-0 top-[57px] bottom-0 z-40 border-r border-[rgb(var(--color-border))] bg-[rgb(var(--color-card))] transition-all duration-300",
          // Desktop: show based on collapsed state
          "hidden lg:block",
          collapsed ? "lg:w-16" : "lg:w-56",
          // Mobile: slide in/out
          mobileOpen && "block w-56"
        )}
      >
        <div className="flex flex-col h-full">
          {/* Navigation Items */}
          <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
            {navItems.map((item) => (
              <Link
                key={item.href}
                to={item.href}
                onClick={closeMobileMenu}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                  isActive(item.href)
                    ? "bg-[rgb(var(--color-primary))] text-[rgb(var(--color-primary-foreground))]"
                    : "text-[rgb(var(--color-muted-foreground))] hover:bg-[rgb(var(--color-muted))] hover:text-[rgb(var(--color-foreground))]"
                )}
                title={collapsed ? item.label : undefined}
              >
                {item.icon}
                {!collapsed && <span>{item.label}</span>}
              </Link>
            ))}
          </nav>

        </div>
      </aside>

      {/* Main Content */}
      <main
        className={cn(
          "pt-[57px] transition-all duration-300",
          // Desktop: adjust padding based on collapsed state
          "lg:pl-56",
          collapsed && "lg:pl-16",
          // Mobile: no left padding
          "pl-0"
        )}
      >
        <div className="p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
