import { useState, useEffect } from "react";
import { ChevronDown, Check, Plus, LogOut } from "lucide-react";

interface Account {
  id: string;
  email: string;
  isActive: boolean;
  lastUsed?: string;
}

export interface AccountSwitcherProps {
  authServerUrl: string;
  currentUser?: { id: string; email: string } | null;
  /** OAuth client ID for adding accounts (e.g., 'admin-dashboard') */
  clientId?: string;
}

export function AccountSwitcher({ authServerUrl, currentUser, clientId = 'admin-dashboard' }: AccountSwitcherProps) {
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
        const data = await response.json() as { accounts?: Array<{ userId: string; email: string; isActive: boolean; lastUsed?: string }> };
        if (data.accounts && data.accounts.length > 0) {
          accountsList = data.accounts.map((a: { userId: string; email: string; isActive: boolean; lastUsed?: string }) => ({
            id: a.userId,
            email: a.email,
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
      const response = await fetch(`${authServerUrl}/session/accounts/${userId}/activate`, {
        method: 'POST',
        credentials: 'include',
      });
      if (response.ok) {
        window.location.reload();
      }
    } catch (error) {
      console.error('Failed to switch account:', error);
    }
  }

  async function handleSignOutAccount(userId: string) {
    try {
      const response = await fetch(`${authServerUrl}/session/accounts/${userId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (response.ok) {
        await loadAccounts();
        // If we signed out the active account, redirect to login
        const activeAccount = accounts.find(a => a.isActive);
        if (activeAccount?.id === userId) {
          window.location.href = '/login';
        }
      }
    } catch (error) {
      console.error('Failed to sign out account:', error);
    }
  }

  function handleAddAccount() {
    const redirectUri = encodeURIComponent(window.location.origin + '/auth/callback');
    window.location.href = `${authServerUrl}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}&prompt=select_account`;
  }

  function handleSignOutAll() {
    window.location.href = '/logout?all=true';
  }

  function getInitial(email: string) {
    return email.charAt(0).toUpperCase();
  }

  function getAvatarColor(email: string) {
    const colors = [
      'bg-blue-500', 'bg-green-500', 'bg-purple-500',
      'bg-orange-500', 'bg-pink-500', 'bg-teal-500'
    ];
    const index = email.charCodeAt(0) % colors.length;
    return colors[index];
  }

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

  return (
    <div className="relative">
      <button
        type="button"
        className="inline-flex items-center justify-center gap-2 px-2 py-2 rounded-md text-sm font-medium transition-colors hover:bg-[rgb(var(--color-muted))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-medium ${getAvatarColor(activeAccount?.email || '')}`}>
          {getInitial(activeAccount?.email || '')}
        </div>
        <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />

          {/* Dropdown */}
          <div className="absolute right-0 top-full mt-2 w-72 bg-[rgb(var(--color-card))] border border-[rgb(var(--color-border))] rounded-lg shadow-lg z-50">
            <div className="px-3 py-2 border-b border-[rgb(var(--color-border))]">
              <p className="text-xs font-medium text-[rgb(var(--color-muted-foreground))]">
                Signed in accounts
              </p>
            </div>

            <div className="max-h-64 overflow-y-auto py-1">
              {accounts.map((account) => (
                <div
                  key={account.id}
                  className={`flex items-center gap-3 px-3 py-2 hover:bg-[rgb(var(--color-muted))] cursor-pointer ${account.isActive ? 'bg-[rgb(var(--color-muted))]/50' : ''}`}
                  onClick={() => !account.isActive && handleSwitchAccount(account.id)}
                >
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-medium flex-shrink-0 ${getAvatarColor(account.email)}`}>
                    {getInitial(account.email)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[rgb(var(--color-foreground))] truncate">
                      {account.email}
                    </p>
                    <p className="text-xs text-[rgb(var(--color-muted-foreground))]">
                      {account.isActive ? 'Active' : `Last used ${formatRelativeTime(account.lastUsed)}`}
                    </p>
                  </div>
                  {account.isActive && (
                    <Check className="h-4 w-4 text-green-500 flex-shrink-0" />
                  )}
                  <button
                    className="p-1 hover:bg-[rgb(var(--color-muted))] rounded opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSignOutAccount(account.id);
                    }}
                    title="Sign out"
                  >
                    <LogOut className="h-3 w-3 text-[rgb(var(--color-muted-foreground))]" />
                  </button>
                </div>
              ))}
            </div>

            <div className="border-t border-[rgb(var(--color-border))] py-1">
              {accounts.length < 5 && (
                <button
                  className="flex items-center gap-3 w-full px-3 py-2 hover:bg-[rgb(var(--color-muted))] text-left"
                  onClick={handleAddAccount}
                >
                  <div className="w-8 h-8 rounded-full bg-[rgb(var(--color-muted))] flex items-center justify-center">
                    <Plus className="h-4 w-4 text-[rgb(var(--color-muted-foreground))]" />
                  </div>
                  <span className="text-sm text-[rgb(var(--color-foreground))]">
                    Add another account
                  </span>
                </button>
              )}
              <button
                className="flex items-center gap-3 w-full px-3 py-2 hover:bg-[rgb(var(--color-muted))] text-left"
                onClick={handleSignOutAll}
              >
                <div className="w-8 h-8 rounded-full bg-red-500/10 flex items-center justify-center">
                  <LogOut className="h-4 w-4 text-red-500" />
                </div>
                <span className="text-sm text-red-500">
                  Sign out of all accounts
                </span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
