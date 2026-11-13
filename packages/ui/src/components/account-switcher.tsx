import { useState, useEffect } from "react";
import { ChevronDown, LogIn, LogOut } from "lucide-react";

interface Account {
  id: string;
  email: string;
  /** The account's name (auth's /session list); the email when there is none. */
  name?: string;
  isActive: boolean;
  lastUsed?: string;
}

/** An entry of the account menu's "Al Ummah Now apps" section (AlUmmahNow docs/design/NAV.md). */
export interface AccountMenuApp {
  id: string;
  label: string;
  href: string;
}

export interface AccountSwitcherProps {
  authServerUrl: string;
  currentUser?: { id: string; email: string } | null;
  /** OAuth client ID (kept for compatibility; sign-in goes through the app's login route) */
  clientId?: string;
  /**
   * The app's login route. It must accept `redirect` (a same-origin path to
   * return to) and `prompt` (`none` = silent, `login` = add an account).
   */
  loginPath?: string;
  /** The other Al Ummah Now apps, in the shared order and labels (this app left out). */
  apps?: AccountMenuApp[];
}

/** The app's login URL that returns to the current page. */
export function appLoginUrl(loginPath: string, prompt?: "none" | "login"): string {
  const params = new URLSearchParams({ redirect: window.location.pathname + window.location.search });
  if (prompt) params.set("prompt", prompt);
  return `${loginPath}?${params}`;
}

/**
 * Every account signed in to this browser (listed by the auth server), with
 * switch, add and sign out of one. Switching changes auth's active account
 * and signs in to this app silently as it; signing out of the last account
 * is single sign-out (the app's /logout).
 */
export function AccountSwitcher({ authServerUrl, currentUser, loginPath = "/login", apps = [] }: AccountSwitcherProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadAccounts();
  }, [authServerUrl, currentUser]);

  async function loadAccounts() {
    if (!currentUser) {
      setAccounts([]);
      setIsLoading(false);
      return;
    }

    // Start with current user as fallback
    let accountsList: Account[] = [{
      id: currentUser.id,
      email: currentUser.email,
      isActive: true,
    }];

    // Try to fetch multi-account data from auth server
    try {
      const response = await fetch(`${authServerUrl}/session/accounts`, {
        credentials: 'include',
      });
      if (response.ok) {
        const data = await response.json() as { accounts?: Array<{ userId: string; email: string; name?: string | null; isActive: boolean; lastUsed?: string }> };
        if (data.accounts && data.accounts.length > 0) {
          accountsList = data.accounts.map((a) => ({
            id: a.userId,
            email: a.email,
            name: a.name?.trim() || undefined,
            isActive: a.isActive,
            lastUsed: a.lastUsed,
          }));
        }
      }
    } catch (error) {
      console.error('Failed to load accounts:', error);
    }

    setAccounts(accountsList);
    setIsLoading(false);
  }

  async function handleSwitchAccount(userId: string) {
    try {
      const response = await fetch(`${authServerUrl}/session/switch`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userId }),
      });
      if (response.ok) {
        // Silent sign-in as auth's new active account, back to this page.
        // (The old code put ?returnTo= into redirect_uri, which no longer
        // matched the registered callback, so the issuer rejected it.)
        window.location.href = appLoginUrl(loginPath, 'none');
      } else {
        const errorText = await response.text();
        console.error('[AccountSwitcher] Switch failed:', response.status, errorText);
      }
    } catch (error) {
      console.error('[AccountSwitcher] Failed to switch account:', error);
    }
  }

  async function handleSignOutAccount(userId: string) {
    const others = accounts.filter(a => a.id !== userId);
    // The last account: single sign-out everywhere
    if (others.length === 0) {
      window.location.href = '/logout';
      return;
    }
    const removed = accounts.find(a => a.id === userId);
    try {
      const response = await fetch(`${authServerUrl}/session/accounts/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok) {
        console.error('Failed to sign out account:', response.status);
        return;
      }
      if (userId === currentUser?.id || removed?.isActive) {
        // This app was using that account: sign in silently as auth's new active account
        window.location.href = appLoginUrl(loginPath, 'none');
      } else {
        await loadAccounts();
      }
    } catch (error) {
      console.error('Failed to sign out account:', error);
    }
  }

  function handleAddAccount() {
    window.location.href = appLoginUrl(loginPath, 'login');
  }

  function handleSignOutAll() {
    window.location.href = '/logout';
  }

  function getInitial(text: string) {
    return (Array.from(text.trim())[0] ?? '?').toUpperCase();
  }

  const nameOf = (a?: Account) => a?.name || a?.email || '';

  function formatRelativeTime(dateStr?: string) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  }

  if (isLoading || !currentUser) {
    return null;
  }

  const activeAccount = accounts.find(a => a.isActive) || accounts[0];
  const name = nameOf(activeAccount);
  const several = accounts.length > 1;
  const others = accounts.filter((a) => a !== activeAccount);

  // The shared nav contract (AlUmmahNow docs/design/NAV.md, NAV_CSS): avatar + name, then
  // who · your accounts · add · Al Ummah Now apps · sign out
  return (
    <div className="relative">
      <button
        type="button"
        data-testid="account-menu"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className="aun-acct-btn"
        onClick={() => setIsOpen(!isOpen)}
      >
        {/* No aria-label: the visible name is the button's name (axe label-content-name-mismatch) */}
        <span className="aun-avatar" aria-hidden="true">{getInitial(name)}</span>
        <span className="sr-only">Account menu: </span>
        <span className="aun-acct-name" dir="auto">{name}</span>
        <ChevronDown className="aun-caret" aria-hidden="true" />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="aun-menu" role="menu" onKeyDown={(e) => e.key === 'Escape' && setIsOpen(false)}>
            {/* The current account, only here (the Google pattern); the others follow under "More accounts" */}
            <div className="aun-menu-who" data-testid="account-who">
              <span className="aun-avatar aun-avatar--lg" aria-hidden="true">{getInitial(name)}</span>
              <span className="aun-menu-who-text">
                <span className="aun-menu-who-name" dir="auto">{name}</span>
                {activeAccount && activeAccount.email !== name && <EmailText email={activeAccount.email} className="aun-menu-who-sub" />}
              </span>
            </div>
            <div className="aun-menu-sep" role="separator" />
            {others.length > 0 && (
              <>
                <span className="aun-menu-label">More accounts</span>
                {others.map((account) => {
                  const label = nameOf(account);
                  return (
                    <div key={account.id} className="aun-acct-row" data-testid="account-item" data-email={account.email}>
                      <button
                        type="button"
                        role="menuitem"
                        className="aun-menu-item"
                        aria-label={`Switch to ${label}`}
                        onClick={() => handleSwitchAccount(account.id)}
                      >
                        <span className="aun-avatar" aria-hidden="true">{getInitial(label)}</span>
                        <span className="aun-acct-text">
                          <span className="aun-acct-label" dir="auto">{label}</span>
                          {account.email !== label && <EmailText email={account.email} className="aun-acct-email" />}
                        </span>
                      </button>
                      <button
                        type="button"
                        data-testid="account-sign-out"
                        className="aun-acct-signout"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSignOutAccount(account.id);
                        }}
                        aria-label={`Sign out of ${label}`}
                        title={`Sign out of ${label}`}
                      >
                        <LogOut className="aun-flip" aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </>
            )}
            {accounts.length < 5 && (
              <button type="button" role="menuitem" data-testid="account-add" className="aun-menu-item" onClick={handleAddAccount}>
                <LogIn className="aun-menu-icon aun-flip" aria-hidden="true" />
                <span className="aun-menu-text">Sign in to another account</span>
              </button>
            )}
            {apps.length > 0 && (
              <>
                <div className="aun-menu-sep" role="separator" />
                <div role="group" aria-labelledby="account-apps-label" data-testid="account-apps">
                  <span className="aun-menu-label" id="account-apps-label">Al Ummah Now apps</span>
                  {apps.map((app) => (
                    <a key={app.id} role="menuitem" className="aun-menu-item" href={app.href} data-app={app.id}>
                      {/* The app's own favicon: a separate file (never inlined in the CSS), loaded when the menu shows it */}
                      <img className="aun-app-icon" data-app={app.id} src={`/aun-nav/icons/${app.id}.webp`} width={32} height={32} alt="" loading="lazy" decoding="async" />
                      <span className="aun-menu-text">{app.label}</span>
                    </a>
                  ))}
                </div>
              </>
            )}
            <div className="aun-menu-sep" role="separator" />
            <button type="button" role="menuitem" data-testid="account-sign-out-current" className="aun-menu-item" onClick={() => handleSignOutAccount(currentUser.id)}>
              <LogOut className="aun-menu-icon aun-flip" aria-hidden="true" />
              <span className="aun-menu-text">Sign out</span>
            </button>
            {several && (
              <button type="button" role="menuitem" className="aun-menu-item aun-menu-item--danger" onClick={handleSignOutAll}>
                <LogOut className="aun-menu-icon aun-flip" aria-hidden="true" />
                <span className="aun-menu-text">Sign out of all accounts</span>
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * An email that keeps its domain when it does not fit (AlUmmahNow docs/design/NAV.md): the local
 * part shrinks with an ellipsis, "@domain" stays whole, and the full address is the tooltip.
 */
function EmailText({ email, className }: { email: string; className: string }) {
  const at = email.lastIndexOf('@');
  if (at <= 0) return <span className={className} dir="ltr" title={email}>{email}</span>;
  return (
    <span className={`${className} aun-email`} dir="ltr" title={email}>
      <span className="aun-email-local">{email.slice(0, at)}</span>
      <span className="aun-email-domain">{email.slice(at)}</span>
    </span>
  );
}
