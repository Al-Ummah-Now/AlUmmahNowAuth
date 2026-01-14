/**
 * @fileoverview Admin Sessions Dashboard UI component
 *
 * Server-rendered HTML for admin session management dashboard.
 * Provides comprehensive view of:
 * - System-wide session statistics
 * - Active sessions across all users
 * - Device breakdown
 * - Suspicious activity alerts
 * - Session search/filter capabilities
 * - Bulk session management
 *
 * This component is designed for admin dashboard use only.
 */

/**
 * Session statistics data
 */
export interface SessionStats {
	totalSessions: number;
	activeSessions: number;
	loginsLast24h: number;
	deviceBreakdown: {
		desktop: number;
		mobile: number;
		tablet: number;
		unknown: number;
	};
}

/**
 * Suspicious activity data
 */
export interface SuspiciousActivity {
	multipleIPsInShortTime?: Array<{
		userId: string;
		email: string;
		ipCount: number;
	}>;
	failedThenSuccessfulLogins?: Array<{
		userId: string;
		email: string;
		failedAttempts: number;
	}>;
}

/**
 * Admin session entry for display
 */
export interface AdminSessionEntry {
	id: string;
	userId: string;
	email: string;
	deviceType: 'desktop' | 'mobile' | 'tablet' | 'unknown';
	deviceName: string | null;
	ipAddress: string | null;
	lastUsed: string;
	isActive: boolean;
	createdAt: string;
}

/**
 * Props for admin sessions dashboard
 */
export interface AdminSessionsProps {
	stats: SessionStats;
	sessions: AdminSessionEntry[];
	suspicious: SuspiciousActivity;
	/** Current filter values */
	filters?: {
		deviceType?: string;
		search?: string;
	};
	/** Base URL for user profile links */
	userBaseUrl?: string;
	/** Base URL for session actions */
	actionBaseUrl?: string;
}

/**
 * Render admin sessions dashboard HTML
 *
 * Creates a server-rendered HTML admin dashboard showing all sessions
 * with statistics, filtering, and management capabilities.
 *
 * @param props - Admin sessions properties
 * @returns Complete HTML component as string
 */
export function renderAdminSessionsDashboard(props: AdminSessionsProps): string {
	const {
		stats,
		sessions,
		suspicious,
		filters = {},
		userBaseUrl = '/admin/users',
		actionBaseUrl = '/admin/sessions',
	} = props;

	const hasSuspiciousActivity =
		(suspicious.multipleIPsInShortTime?.length || 0) > 0 ||
		(suspicious.failedThenSuccessfulLogins?.length || 0) > 0;

	return `
<div class="admin-sessions-dashboard max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
  <!-- Page Header -->
  <header class="mb-8">
    <h1 class="text-2xl sm:text-3xl font-bold text-gray-900 mb-2">
      Session Management
    </h1>
    <p class="text-sm sm:text-base text-gray-600">
      Monitor and manage active user sessions across the platform
    </p>
  </header>

  <!-- Stats Grid -->
  ${renderStatsGrid(stats, hasSuspiciousActivity, suspicious)}

  <!-- Device Breakdown -->
  ${renderDeviceBreakdown(stats.deviceBreakdown)}

  <!-- Suspicious Activity Alert -->
  ${hasSuspiciousActivity ? renderSuspiciousActivityAlert(suspicious, userBaseUrl) : ''}

  <!-- Sessions Table -->
  ${renderSessionsTable(sessions, filters, userBaseUrl, actionBaseUrl)}
</div>
  `;
}

/**
 * Render statistics grid
 */
function renderStatsGrid(
	stats: SessionStats,
	hasSuspiciousActivity: boolean,
	suspicious: SuspiciousActivity
): string {
	const suspiciousCount =
		(suspicious.multipleIPsInShortTime?.length || 0) +
		(suspicious.failedThenSuccessfulLogins?.length || 0);

	return `
<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
  <!-- Total Sessions Card -->
  <div class="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
    <div class="flex items-center justify-between mb-2">
      <h3 class="text-sm font-medium text-gray-600">Total Sessions</h3>
      <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
      </svg>
    </div>
    <div class="text-3xl font-bold text-gray-900">${stats.totalSessions}</div>
    <p class="text-xs text-gray-500 mt-1">Across all users</p>
  </div>

  <!-- Active Sessions Card -->
  <div class="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
    <div class="flex items-center justify-between mb-2">
      <h3 class="text-sm font-medium text-gray-600">Active Now</h3>
      <svg class="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    </div>
    <div class="text-3xl font-bold text-green-600">${stats.activeSessions}</div>
    <p class="text-xs text-gray-500 mt-1">In last hour</p>
  </div>

  <!-- Today's Logins Card -->
  <div class="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
    <div class="flex items-center justify-between mb-2">
      <h3 class="text-sm font-medium text-gray-600">Today's Logins</h3>
      <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    </div>
    <div class="text-3xl font-bold text-gray-900">${stats.loginsLast24h}</div>
    <p class="text-xs text-gray-500 mt-1">Last 24 hours</p>
  </div>

  <!-- Suspicious Activity Card -->
  <div class="bg-white border ${hasSuspiciousActivity ? 'border-orange-400 bg-orange-50' : 'border-gray-200'} rounded-xl p-5 shadow-sm">
    <div class="flex items-center justify-between mb-2">
      <h3 class="text-sm font-medium ${hasSuspiciousActivity ? 'text-orange-900' : 'text-gray-600'}">
        Suspicious
      </h3>
      <svg class="w-5 h-5 ${hasSuspiciousActivity ? 'text-orange-500' : 'text-gray-400'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    </div>
    <div class="text-3xl font-bold ${hasSuspiciousActivity ? 'text-orange-600' : 'text-gray-900'}">
      ${suspiciousCount}
    </div>
    <p class="text-xs ${hasSuspiciousActivity ? 'text-orange-700' : 'text-gray-500'} mt-1">
      ${hasSuspiciousActivity ? 'Needs review' : 'All clear'}
    </p>
  </div>
</div>
  `;
}

/**
 * Render device breakdown section
 */
function renderDeviceBreakdown(breakdown: SessionStats['deviceBreakdown']): string {
	return `
<div class="bg-white border border-gray-200 rounded-xl p-6 mb-8 shadow-sm">
  <h2 class="text-lg font-semibold text-gray-900 mb-6">Sessions by Device Type</h2>
  <div class="grid grid-cols-2 sm:grid-cols-4 gap-6">
    <!-- Desktop -->
    <div class="flex items-center gap-3">
      <div class="w-12 h-12 rounded-xl bg-blue-100 flex items-center justify-center text-blue-600 flex-shrink-0">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
      </div>
      <div>
        <div class="text-2xl font-bold text-gray-900">${breakdown.desktop}</div>
        <div class="text-sm text-gray-600">Desktop</div>
      </div>
    </div>

    <!-- Mobile -->
    <div class="flex items-center gap-3">
      <div class="w-12 h-12 rounded-xl bg-green-100 flex items-center justify-center text-green-600 flex-shrink-0">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
      </div>
      <div>
        <div class="text-2xl font-bold text-gray-900">${breakdown.mobile}</div>
        <div class="text-sm text-gray-600">Mobile</div>
      </div>
    </div>

    <!-- Tablet -->
    <div class="flex items-center gap-3">
      <div class="w-12 h-12 rounded-xl bg-purple-100 flex items-center justify-center text-purple-600 flex-shrink-0">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
      </div>
      <div>
        <div class="text-2xl font-bold text-gray-900">${breakdown.tablet}</div>
        <div class="text-sm text-gray-600">Tablet</div>
      </div>
    </div>

    <!-- Unknown -->
    <div class="flex items-center gap-3">
      <div class="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center text-gray-600 flex-shrink-0">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
        </svg>
      </div>
      <div>
        <div class="text-2xl font-bold text-gray-900">${breakdown.unknown}</div>
        <div class="text-sm text-gray-600">Unknown</div>
      </div>
    </div>
  </div>
</div>
  `;
}

/**
 * Render suspicious activity alert
 */
function renderSuspiciousActivityAlert(
	suspicious: SuspiciousActivity,
	userBaseUrl: string
): string {
	return `
<div class="bg-orange-50 border border-orange-300 rounded-xl p-6 mb-8">
  <div class="flex items-start gap-3 mb-4">
    <div class="w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center text-orange-600 flex-shrink-0">
      <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    </div>
    <div>
      <h3 class="text-lg font-semibold text-orange-900">Suspicious Activity Detected</h3>
      <p class="text-sm text-orange-800 mt-1">The following accounts may require investigation</p>
    </div>
  </div>

  <div class="space-y-6">
    ${
			suspicious.multipleIPsInShortTime && suspicious.multipleIPsInShortTime.length > 0
				? `
    <div>
      <h4 class="text-sm font-semibold text-orange-900 mb-3">Multiple IPs in Short Time</h4>
      <div class="space-y-2">
        ${suspicious.multipleIPsInShortTime
					.map(
						(item) => `
        <div class="bg-white border border-orange-200 rounded-lg p-4 flex items-center justify-between gap-4">
          <div class="flex-1 min-w-0">
            <a
              href="${escapeHtml(userBaseUrl)}/${escapeHtml(item.userId)}/sessions"
              class="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
            >
              ${escapeHtml(item.email)}
            </a>
            <p class="text-xs text-gray-600 mt-1">
              ${item.ipCount} different IPs in 24 hours
            </p>
          </div>
          <a
            href="${escapeHtml(userBaseUrl)}/${escapeHtml(item.userId)}/sessions"
            class="
              px-4 py-2
              text-sm font-medium
              text-orange-700
              bg-white
              border border-orange-300
              rounded-lg
              hover:bg-orange-50
              transition-colors
              whitespace-nowrap
            "
          >
            Investigate
          </a>
        </div>
        `
					)
					.join('')}
      </div>
    </div>
    `
				: ''
		}

    ${
			suspicious.failedThenSuccessfulLogins && suspicious.failedThenSuccessfulLogins.length > 0
				? `
    <div>
      <h4 class="text-sm font-semibold text-orange-900 mb-3">Failed Attempts Before Success</h4>
      <div class="space-y-2">
        ${suspicious.failedThenSuccessfulLogins
					.map(
						(item) => `
        <div class="bg-white border border-orange-200 rounded-lg p-4 flex items-center justify-between gap-4">
          <div class="flex-1 min-w-0">
            <a
              href="${escapeHtml(userBaseUrl)}/${escapeHtml(item.userId)}/sessions"
              class="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
            >
              ${escapeHtml(item.email)}
            </a>
            <p class="text-xs text-gray-600 mt-1">
              ${item.failedAttempts} failed attempts before successful login
            </p>
          </div>
          <a
            href="${escapeHtml(userBaseUrl)}/${escapeHtml(item.userId)}/sessions"
            class="
              px-4 py-2
              text-sm font-medium
              text-orange-700
              bg-white
              border border-orange-300
              rounded-lg
              hover:bg-orange-50
              transition-colors
              whitespace-nowrap
            "
          >
            Investigate
          </a>
        </div>
        `
					)
					.join('')}
      </div>
    </div>
    `
				: ''
		}
  </div>
</div>
  `;
}

/**
 * Render sessions table with filters
 */
function renderSessionsTable(
	sessions: AdminSessionEntry[],
	filters: AdminSessionsProps['filters'],
	userBaseUrl: string,
	actionBaseUrl: string
): string {
	return `
<div class="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
  <!-- Table Header with Filters -->
  <div class="p-6 border-b border-gray-200">
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <h2 class="text-lg font-semibold text-gray-900">Active Sessions</h2>

      <!-- Filter Form -->
      <form method="GET" class="flex flex-col sm:flex-row gap-3">
        <!-- Device Type Filter -->
        <select
          name="device_type"
          class="
            px-3 py-2
            bg-white
            border border-gray-300
            rounded-lg
            text-sm
            focus:outline-none focus:ring-2 focus:ring-blue-500
            min-w-[150px]
          "
          onchange="this.form.submit()"
        >
          <option value="">All Devices</option>
          <option value="desktop" ${filters?.deviceType === 'desktop' ? 'selected' : ''}>Desktop</option>
          <option value="mobile" ${filters?.deviceType === 'mobile' ? 'selected' : ''}>Mobile</option>
          <option value="tablet" ${filters?.deviceType === 'tablet' ? 'selected' : ''}>Tablet</option>
          <option value="unknown" ${filters?.deviceType === 'unknown' ? 'selected' : ''}>Unknown</option>
        </select>

        <!-- Search Input -->
        <div class="relative">
          <input
            type="text"
            name="search"
            value="${escapeHtml(filters?.search || '')}"
            placeholder="Search by email..."
            class="
              px-3 py-2 pl-10
              bg-white
              border border-gray-300
              rounded-lg
              text-sm
              focus:outline-none focus:ring-2 focus:ring-blue-500
              min-w-[200px]
            "
          />
          <svg class="w-5 h-5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
      </form>
    </div>
  </div>

  <!-- Table -->
  <div class="overflow-x-auto">
    <table class="w-full">
      <thead class="bg-gray-50 border-b border-gray-200">
        <tr>
          <th class="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">User</th>
          <th class="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Device</th>
          <th class="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">IP Address</th>
          <th class="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Last Active</th>
          <th class="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Status</th>
          <th class="px-6 py-3 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider">Actions</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-200">
        ${
					sessions.length === 0
						? `
        <tr>
          <td colspan="6" class="px-6 py-12 text-center text-gray-500">
            No sessions found
          </td>
        </tr>
        `
						: sessions.map((session) => renderSessionRow(session, userBaseUrl, actionBaseUrl)).join('')
				}
      </tbody>
    </table>
  </div>
</div>
  `;
}

/**
 * Render a single session row
 */
function renderSessionRow(
	session: AdminSessionEntry,
	userBaseUrl: string,
	_actionBaseUrl: string
): string {
	const DeviceIcon = getDeviceIcon(session.deviceType);

	return `
<tr class="hover:bg-gray-50 transition-colors">
  <td class="px-6 py-4 whitespace-nowrap">
    <a
      href="${escapeHtml(userBaseUrl)}/${escapeHtml(session.userId)}"
      class="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
    >
      ${escapeHtml(session.email)}
    </a>
  </td>
  <td class="px-6 py-4 whitespace-nowrap">
    <div class="flex items-center gap-2">
      ${DeviceIcon}
      <span class="text-sm text-gray-900">${escapeHtml(session.deviceName || 'Unknown')}</span>
    </div>
  </td>
  <td class="px-6 py-4 whitespace-nowrap">
    <code class="text-sm text-gray-600">${escapeHtml(session.ipAddress || 'N/A')}</code>
  </td>
  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
    ${formatDateTime(session.lastUsed)}
  </td>
  <td class="px-6 py-4 whitespace-nowrap">
    ${
			session.isActive
				? `
    <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
      Active
    </span>
    `
				: `
    <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
      Idle
    </span>
    `
		}
  </td>
  <td class="px-6 py-4 whitespace-nowrap text-right">
    <a
      href="${escapeHtml(userBaseUrl)}/${escapeHtml(session.userId)}/sessions"
      class="
        px-3 py-1.5
        text-sm font-medium
        text-blue-600
        hover:text-blue-800 hover:underline
      "
    >
      Manage
    </a>
  </td>
</tr>
  `;
}

/**
 * Get device icon based on type
 */
function getDeviceIcon(deviceType: string): string {
	const iconClass = 'w-4 h-4 text-gray-500';

	switch (deviceType) {
		case 'mobile':
			return `
<svg class="${iconClass}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
</svg>
      `;
		case 'tablet':
			return `
<svg class="${iconClass}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
</svg>
      `;
		case 'desktop':
			return `
<svg class="${iconClass}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
</svg>
      `;
		default:
			return `
<svg class="${iconClass}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
</svg>
      `;
	}
}

/**
 * Format date and time for display
 *
 * @param dateString - ISO date string
 * @returns Formatted date and time
 */
function formatDateTime(dateString: string): string {
	const date = new Date(dateString);
	return date.toLocaleString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
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
