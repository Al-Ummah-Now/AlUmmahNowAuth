/**
 * @fileoverview Session List UI component
 *
 * Server-rendered HTML for displaying and managing active sessions/devices.
 * Allows users to:
 * - View all active sessions across devices
 * - Identify current session
 * - Revoke individual sessions
 * - Revoke all other sessions
 *
 * This component is designed for user-facing session management in profile/settings.
 */

/**
 * Device session data for display
 */
export interface DeviceSession {
	id: string;
	browserSessionId: string;
	deviceType: 'desktop' | 'mobile' | 'tablet' | 'unknown';
	deviceName: string | null;
	ipAddress: string | null;
	lastActivity: string;
	createdAt: string;
	isCurrentSession: boolean;
	authMethod?: 'email' | 'google' | 'mfa' | 'password';
}

/**
 * Props for session list component
 */
export interface SessionListProps {
	sessions: DeviceSession[];
	/** Base URL for session actions (e.g., /session/devices) */
	actionBaseUrl?: string;
	/** Show revoke all button when multiple sessions exist */
	showRevokeAll?: boolean;
}

/**
 * Render session list HTML
 *
 * Creates a server-rendered HTML page showing all active sessions
 * with options to manage them.
 *
 * @param props - Session list properties
 * @returns Complete HTML component as string
 */
export function renderSessionList(props: SessionListProps): string {
	const { sessions, actionBaseUrl = '/session/devices', showRevokeAll = true } = props;

	const currentSession = sessions.find((s) => s.isCurrentSession);
	const otherSessions = sessions.filter((s) => !s.isCurrentSession);

	return `
<div class="session-list-container max-w-4xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
  <!-- Page Header -->
  <header class="mb-8">
    <h1 class="text-2xl sm:text-3xl font-bold text-gray-900 mb-2">
      Active Sessions
    </h1>
    <p class="text-sm sm:text-base text-gray-600 leading-relaxed">
      Manage your active sessions across all devices. You can sign out from
      devices you no longer use or don't recognize.
    </p>
  </header>

  ${
		sessions.length === 0
			? renderEmptyState()
			: `
  <!-- Current Session Section -->
  ${currentSession ? renderCurrentSessionSection(currentSession) : ''}

  <!-- Other Sessions Section -->
  ${renderOtherSessionsSection(otherSessions, actionBaseUrl, showRevokeAll)}

  <!-- Security Notice -->
  ${renderSecurityNotice()}
  `
	}
</div>
  `;
}

/**
 * Render current session section
 */
function renderCurrentSessionSection(session: DeviceSession): string {
	return `
<section class="mb-8">
  <h2 class="text-lg font-semibold text-gray-900 mb-4">Current Session</h2>
  ${renderDeviceCard(session, true, '')}
</section>
  `;
}

/**
 * Render other sessions section
 */
function renderOtherSessionsSection(
	sessions: DeviceSession[],
	actionBaseUrl: string,
	showRevokeAll: boolean
): string {
	return `
<section class="mb-8">
  <!-- Section Header -->
  <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
    <h2 class="text-lg font-semibold text-gray-900">
      Other Sessions (${sessions.length})
    </h2>
    ${
			showRevokeAll && sessions.length > 0
				? `
    <form method="POST" action="${escapeHtml(actionBaseUrl)}/revoke-all" class="flex-shrink-0">
      <button
        type="submit"
        class="
          px-4 py-2
          text-sm font-medium
          text-red-600
          bg-red-50
          border border-red-200
          rounded-lg
          hover:bg-red-100 hover:border-red-300
          focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2
          transition-colors
          w-full sm:w-auto
        "
        onclick="return confirm('Sign out from all other devices? You will stay signed in on this device.');"
      >
        Sign out all other devices
      </button>
    </form>
    `
				: ''
		}
  </div>

  <!-- Sessions List -->
  ${
		sessions.length === 0
			? `
  <div class="
    bg-gray-50
    border border-gray-200
    rounded-xl
    p-8
    text-center
  ">
    <svg class="w-12 h-12 mx-auto mb-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
    <p class="text-gray-600 font-medium">No other active sessions</p>
    <p class="text-sm text-gray-500 mt-1">You're only signed in on this device</p>
  </div>
  `
			: `
  <div class="space-y-3">
    ${sessions.map((session) => renderDeviceCard(session, false, actionBaseUrl)).join('')}
  </div>
  `
	}
</section>
  `;
}

/**
 * Render device card
 */
function renderDeviceCard(
	session: DeviceSession,
	isCurrent: boolean,
	actionBaseUrl: string
): string {
	const DeviceIcon = getDeviceIconSvg(session.deviceType);

	return `
<div class="
  bg-white
  border ${isCurrent ? 'border-green-300 bg-green-50/30' : 'border-gray-200'}
  rounded-xl
  p-4 sm:p-5
  hover:shadow-md
  transition-shadow
">
  <div class="flex flex-col sm:flex-row sm:items-start gap-4">
    <!-- Device Icon -->
    <div class="
      flex-shrink-0
      w-12 h-12
      rounded-full
      ${isCurrent ? 'bg-green-100' : 'bg-blue-100'}
      flex items-center justify-center
      ${isCurrent ? 'text-green-600' : 'text-blue-600'}
    ">
      ${DeviceIcon}
    </div>

    <!-- Device Info -->
    <div class="flex-1 min-w-0">
      <!-- Device Name & Badge -->
      <div class="flex flex-wrap items-center gap-2 mb-2">
        <h3 class="text-base font-semibold text-gray-900">
          ${escapeHtml(session.deviceName || 'Unknown Device')}
        </h3>
        ${
					isCurrent
						? `
        <span class="
          inline-flex items-center gap-1
          px-2 py-1
          text-xs font-medium
          text-green-700
          bg-green-100
          rounded-full
        ">
          <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
            <circle cx="10" cy="10" r="4" />
          </svg>
          This device
        </span>
        `
						: ''
				}
      </div>

      <!-- Device Meta Info -->
      <div class="space-y-1 text-sm text-gray-600">
        ${
					session.ipAddress
						? `
        <div class="flex items-center gap-2">
          <svg class="w-4 h-4 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
          </svg>
          <span class="font-mono">${escapeHtml(session.ipAddress)}</span>
        </div>
        `
						: ''
				}

        <div class="flex items-center gap-2">
          <svg class="w-4 h-4 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>
            ${isCurrent ? 'Active now' : `Last active ${formatRelativeTime(session.lastActivity)}`}
          </span>
        </div>

        <div class="flex items-center gap-2">
          <svg class="w-4 h-4 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span>Session started ${formatDate(session.createdAt)}</span>
        </div>
      </div>
    </div>

    <!-- Revoke Button (only for non-current sessions) -->
    ${
			!isCurrent
				? `
    <div class="flex-shrink-0 sm:ml-4">
      <form method="POST" action="${escapeHtml(actionBaseUrl)}/${escapeHtml(session.id)}">
        <input type="hidden" name="_method" value="DELETE" />
        <button
          type="submit"
          class="
            w-full sm:w-auto
            px-4 py-2
            text-sm font-medium
            text-red-600
            bg-white
            border border-red-300
            rounded-lg
            hover:bg-red-50 hover:border-red-400
            focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2
            transition-colors
          "
          onclick="return confirm('Sign out this device?');"
        >
          Sign out
        </button>
      </form>
    </div>
    `
				: ''
		}
  </div>
</div>
  `;
}

/**
 * Render security notice
 */
function renderSecurityNotice(): string {
	return `
<section class="
  bg-blue-50
  border border-blue-200
  rounded-xl
  p-5 sm:p-6
">
  <div class="flex gap-4">
    <div class="flex-shrink-0">
      <div class="
        w-10 h-10
        rounded-full
        bg-blue-100
        flex items-center justify-center
        text-blue-600
      ">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
      </div>
    </div>
    <div class="flex-1">
      <h3 class="text-base font-semibold text-blue-900 mb-2">
        Don't recognize a session?
      </h3>
      <p class="text-sm text-blue-800 leading-relaxed">
        If you see a device or location you don't recognize, sign out
        from that session immediately and change your password to secure your account.
      </p>
    </div>
  </div>
</section>
  `;
}

/**
 * Render empty state when no sessions exist
 */
function renderEmptyState(): string {
	return `
<div class="
  bg-white
  border border-gray-200
  rounded-xl
  p-12
  text-center
">
  <svg class="w-16 h-16 mx-auto mb-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
  </svg>
  <h2 class="text-xl font-semibold text-gray-900 mb-2">No active sessions</h2>
  <p class="text-gray-600">You don't have any active sessions at the moment.</p>
</div>
  `;
}

/**
 * Get device icon SVG based on device type
 */
function getDeviceIconSvg(deviceType: string): string {
	const iconClasses = 'w-6 h-6';

	switch (deviceType) {
		case 'mobile':
			return `
<svg class="${iconClasses}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
</svg>
      `;
		case 'tablet':
			return `
<svg class="${iconClasses}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
</svg>
      `;
		case 'desktop':
			return `
<svg class="${iconClasses}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
</svg>
      `;
		default:
			return `
<svg class="${iconClasses}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
</svg>
      `;
	}
}

/**
 * Format date for display
 *
 * @param dateString - ISO date string
 * @returns Formatted date string
 */
function formatDate(dateString: string): string {
	const date = new Date(dateString);
	return date.toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
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
	if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
	if (diffMins < 1440)
		return `${Math.floor(diffMins / 60)} hour${Math.floor(diffMins / 60) > 1 ? 's' : ''} ago`;
	if (diffMins < 10080)
		return `${Math.floor(diffMins / 1440)} day${Math.floor(diffMins / 1440) > 1 ? 's' : ''} ago`;
	return formatDate(dateString);
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
