/**
 * @fileoverview Account Switcher UI component
 *
 * Server-rendered HTML for account switching dropdown.
 * Displays up to 3 logged-in accounts with ability to:
 * - Switch between active accounts
 * - Add new account (if under 3 accounts)
 * - Sign out individual accounts
 * - Sign out all accounts
 *
 * This component is designed for use in profile/settings contexts,
 * NOT during OAuth flows (use select-account.ts for that).
 */

/**
 * Account data for display in switcher
 */
export interface AccountSwitcherAccount {
	userId: string;
	email: string;
	name?: string;
	avatarUrl?: string;
	lastUsed: string;
	isActive: boolean;
}

/**
 * Props for account switcher component
 */
export interface AccountSwitcherProps {
	accounts: AccountSwitcherAccount[];
	/** Base URL for actions (e.g., /session) */
	actionBaseUrl?: string;
	/** Show account count in trigger */
	showAccountCount?: boolean;
}

/**
 * Render account switcher dropdown HTML
 *
 * Creates a server-rendered HTML dropdown component that shows
 * all logged-in accounts with quick switch functionality.
 *
 * @param props - Account switcher properties
 * @returns Complete HTML component as string
 */
export function renderAccountSwitcher(props: AccountSwitcherProps): string {
	const {
		accounts,
		actionBaseUrl = '/session',
		showAccountCount = true,
	} = props;

	const activeAccount = accounts.find((a) => a.isActive);
	const canAddAccount = accounts.length < 3;

	if (!activeAccount) {
		return renderLoadingSkeleton();
	}

	return `
<div class="account-switcher" x-data="{ open: false }" @click.away="open = false">
  <!-- Trigger Button -->
  <button
    type="button"
    @click="open = !open"
    class="
      flex items-center gap-3
      px-3 py-2
      bg-white
      border border-gray-300
      rounded-full
      hover:bg-gray-50 hover:border-gray-400
      transition-all duration-200
      min-w-[200px]
      focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
    "
    aria-expanded="false"
    aria-haspopup="true"
    x-bind:aria-expanded="open"
  >
    <!-- Active Account Avatar -->
    <div
      class="
        w-8 h-8
        rounded-full
        flex items-center justify-center
        text-white font-semibold text-sm
        flex-shrink-0
      "
      style="background-color: ${getAvatarColor(activeAccount.email)}"
      aria-hidden="true"
    >
      ${getInitials(activeAccount.email)}
    </div>

    <!-- Active Account Info -->
    <div class="flex-1 min-w-0 text-left">
      <div class="text-sm font-medium text-gray-900 truncate">
        ${escapeHtml(activeAccount.email)}
      </div>
      ${
				showAccountCount && accounts.length > 1
					? `
      <div class="text-xs text-gray-500">
        ${accounts.length} account${accounts.length > 1 ? 's' : ''}
      </div>
      `
					: ''
			}
    </div>

    <!-- Chevron Icon -->
    <svg
      class="w-5 h-5 text-gray-500 transition-transform duration-200"
      x-bind:class="{ 'rotate-180': open }"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
    </svg>
  </button>

  <!-- Dropdown Menu -->
  <div
    x-show="open"
    x-transition:enter="transition ease-out duration-150"
    x-transition:enter-start="opacity-0 transform scale-95"
    x-transition:enter-end="opacity-100 transform scale-100"
    x-transition:leave="transition ease-in duration-100"
    x-transition:leave-start="opacity-100 transform scale-100"
    x-transition:leave-end="opacity-0 transform scale-95"
    class="
      absolute right-0 mt-2
      w-80
      bg-white
      rounded-xl
      shadow-lg
      border border-gray-200
      overflow-hidden
      z-50
    "
    style="display: none;"
    role="menu"
    aria-orientation="vertical"
  >
    <!-- Dropdown Header -->
    <div class="px-4 py-3 border-b border-gray-200 bg-gray-50">
      <div class="text-xs font-semibold text-gray-500 uppercase tracking-wide">
        Signed In Accounts
      </div>
    </div>

    <!-- Accounts List -->
    <div class="py-2">
      ${accounts.map((account) => renderAccountItem(account, actionBaseUrl)).join('')}
    </div>

    <!-- Divider -->
    <div class="h-px bg-gray-200 my-1"></div>

    <!-- Add Account Option -->
    ${canAddAccount ? renderAddAccountOption(actionBaseUrl) : ''}

    <!-- Sign Out All Option -->
    ${renderSignOutAllOption(actionBaseUrl)}
  </div>
</div>
  `;
}

/**
 * Render a single account item in the dropdown
 */
function renderAccountItem(
	account: AccountSwitcherAccount,
	actionBaseUrl: string
): string {
	const isActive = account.isActive;

	return `
    <div class="px-2 py-1 ${isActive ? 'bg-blue-50' : ''} group hover:bg-gray-50 transition-colors">
      <div class="flex items-center gap-3 px-2 py-2">
        <!-- Switch Account Form (if not active) -->
        ${
					!isActive
						? `
        <form method="POST" action="${escapeHtml(actionBaseUrl)}/switch" class="flex-1">
          <input type="hidden" name="userId" value="${escapeHtml(account.userId)}" />
          <button
            type="submit"
            class="
              w-full
              flex items-center gap-3
              text-left
              rounded-lg
              px-2 py-1
              hover:bg-gray-100
              transition-colors
              focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-inset
            "
          >
        `
						: `
        <div class="flex-1 flex items-center gap-3 px-2 py-1">
        `
				}

            <!-- Avatar -->
            <div
              class="
                w-8 h-8
                rounded-full
                flex items-center justify-center
                text-white font-semibold text-sm
                flex-shrink-0
              "
              style="background-color: ${getAvatarColor(account.email)}"
              aria-hidden="true"
            >
              ${getInitials(account.email)}
            </div>

            <!-- Account Details -->
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-gray-900 truncate">
                ${escapeHtml(account.email)}
              </div>
              <div class="text-xs text-gray-500">
                ${isActive ? 'Active now' : `Last used ${formatRelativeTime(account.lastUsed)}`}
              </div>
            </div>

            <!-- Active Indicator -->
            ${
							isActive
								? `
            <div class="flex-shrink-0">
              <svg class="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 20 20" aria-label="Active">
                <circle cx="10" cy="10" r="4" />
              </svg>
            </div>
            `
								: ''
						}

        ${!isActive ? '</button></form>' : '</div>'}

        <!-- Sign Out Button (hidden for active, shown on hover for others) -->
        ${
					!isActive
						? `
        <form method="POST" action="${escapeHtml(actionBaseUrl)}/signout/${escapeHtml(account.userId)}" class="flex-shrink-0">
          <button
            type="submit"
            class="
              p-2
              rounded-lg
              text-gray-400
              hover:text-red-600 hover:bg-red-50
              transition-all
              opacity-0 group-hover:opacity-100
              focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-red-500
            "
            title="Sign out ${escapeHtml(account.email)}"
            aria-label="Sign out ${escapeHtml(account.email)}"
            onclick="return confirm('Sign out of ${escapeHtml(account.email)}?');"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </form>
        `
						: ''
				}
      </div>
    </div>
  `;
}

/**
 * Render "Add another account" option
 */
function renderAddAccountOption(actionBaseUrl: string): string {
	return `
    <form method="GET" action="${escapeHtml(actionBaseUrl)}/add">
      <button
        type="submit"
        class="
          w-full
          flex items-center gap-3
          px-4 py-3
          text-left
          hover:bg-gray-50
          transition-colors
          focus:outline-none focus:bg-gray-100
        "
      >
        <!-- Plus Icon -->
        <div
          class="
            w-8 h-8
            rounded-full
            bg-gray-100
            flex items-center justify-center
            text-gray-600
            flex-shrink-0
          "
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
        </div>

        <span class="text-sm font-medium text-gray-900">Add another account</span>
      </button>
    </form>
  `;
}

/**
 * Render "Sign out of all accounts" option
 */
function renderSignOutAllOption(actionBaseUrl: string): string {
	return `
    <form method="POST" action="${escapeHtml(actionBaseUrl)}/signout-all">
      <button
        type="submit"
        class="
          w-full
          flex items-center gap-3
          px-4 py-3
          text-left
          text-red-600
          hover:bg-red-50
          transition-colors
          focus:outline-none focus:bg-red-100
        "
        onclick="return confirm('Sign out of all accounts? You will need to log in again.');"
      >
        <!-- Sign Out Icon -->
        <div
          class="
            w-8 h-8
            rounded-full
            bg-red-100
            flex items-center justify-center
            text-red-600
            flex-shrink-0
          "
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
        </div>

        <span class="text-sm font-medium">Sign out of all accounts</span>
      </button>
    </form>
  `;
}

/**
 * Render loading skeleton state
 */
function renderLoadingSkeleton(): string {
	return `
<div class="account-switcher">
  <div class="
    flex items-center gap-3
    px-3 py-2
    bg-white
    border border-gray-300
    rounded-full
    min-w-[200px]
    animate-pulse
  ">
    <div class="w-8 h-8 rounded-full bg-gray-200"></div>
    <div class="flex-1 space-y-2">
      <div class="h-3 bg-gray-200 rounded w-24"></div>
      <div class="h-2 bg-gray-200 rounded w-16"></div>
    </div>
  </div>
</div>
  `;
}

/**
 * Get consistent avatar color based on email
 *
 * @param email - Email address
 * @returns Hex color code
 */
function getAvatarColor(email: string): string {
	const colors = [
		'#1976d2', // Blue
		'#388e3c', // Green
		'#d32f2f', // Red
		'#7b1fa2', // Purple
		'#f57c00', // Orange
		'#0097a7', // Cyan
	];
	const index = email.charCodeAt(0) % colors.length;
	return colors[index];
}

/**
 * Get initials from email address
 *
 * @param email - Email address
 * @returns First letter of email in uppercase
 */
function getInitials(email: string): string {
	return email.charAt(0).toUpperCase();
}

/**
 * Format relative time display
 *
 * @param dateString - ISO date string
 * @returns Human-readable relative time
 */
function formatRelativeTime(dateString: string): string {
	const date = new Date(dateString);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);

	if (diffMins < 1) return 'just now';
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
	return `${Math.floor(diffMins / 1440)}d ago`;
}

/**
 * Escape HTML special characters to prevent XSS
 *
 * @param str - String to escape
 * @returns Escaped string safe for HTML
 */
function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}
