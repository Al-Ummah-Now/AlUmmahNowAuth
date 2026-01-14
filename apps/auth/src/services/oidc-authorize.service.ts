/**
 * @fileoverview OIDC Authorize Service for handling OpenID Connect authorize flow
 *
 * This service processes OIDC authorize requests and determines the appropriate
 * action based on:
 * - prompt parameter (none, login, consent, select_account)
 * - login_hint and account_hint parameters
 * - max_age parameter for re-authentication
 * - Existing browser and account sessions
 */

import type {
	OIDCAuthorizeParams,
	AuthorizationDecision,
	OIDCError,
} from '../types/oidc';
import { OIDC_ERRORS } from '../types/oidc';
import type { BrowserSession, AccountSession } from '../types/sessions';
import type { D1Database } from '@cloudflare/workers-types';

export class OIDCAuthorizeService {
	constructor(private db: D1Database) {}

	/**
	 * Process authorize request and determine next action
	 *
	 * This is the main entry point for OIDC authorize flow logic.
	 * It evaluates the request parameters and current session state to decide:
	 * - Whether to show UI (login, account selector, etc.)
	 * - Whether to proceed silently with existing session
	 * - Whether to return an error (for prompt=none failures)
	 *
	 * @param params - OIDC authorize parameters from request
	 * @param browserSession - Current browser session (if exists)
	 * @param activeAccount - Currently active account session (if exists)
	 * @param allAccounts - All account sessions in the browser session
	 * @returns Authorization decision
	 */
	async processAuthorizeRequest(
		params: OIDCAuthorizeParams,
		browserSession: BrowserSession | null,
		activeAccount: AccountSession | null,
		allAccounts: AccountSession[]
	): Promise<AuthorizationDecision> {
		const { prompt, login_hint, account_hint, max_age, action } = params;

		// Handle add_account action - always show login UI
		if (action === 'add_account') {
			return {
				shouldShowUI: true,
				uiType: 'login',
				prefilledEmail: login_hint,
			};
		}

		// Handle prompt=none (silent authentication)
		if (prompt === 'none') {
			return this.handleSilentAuth(
				browserSession,
				activeAccount,
				allAccounts,
				account_hint,
				max_age
			);
		}

		// Handle prompt=login (force login)
		if (prompt === 'login') {
			return {
				shouldShowUI: true,
				uiType: 'login',
				prefilledEmail: login_hint,
			};
		}

		// Handle prompt=select_account
		if (prompt === 'select_account') {
			if (allAccounts.length === 0) {
				return {
					shouldShowUI: true,
					uiType: 'login',
					prefilledEmail: login_hint,
				};
			}
			return {
				shouldShowUI: true,
				uiType: 'select_account',
			};
		}

		// Handle prompt=consent (not implemented yet, for future use)
		if (prompt === 'consent') {
			return {
				shouldShowUI: true,
				uiType: 'consent',
			};
		}

		// Default behavior: Use existing session if valid
		if (browserSession && activeAccount) {
			// Check max_age
			if (max_age !== undefined) {
				const authAge = this.getAuthAgeSeconds(activeAccount.authenticatedAt);
				if (authAge > max_age) {
					return {
						shouldShowUI: true,
						uiType: 'login',
						prefilledEmail: login_hint,
					};
				}
			}

			// Check if specific account is requested
			if (account_hint) {
				const targetAccount = allAccounts.find((a) => a.userId === account_hint);
				if (targetAccount) {
					return {
						shouldShowUI: false,
						selectedAccount: targetAccount,
					};
				}
				// Account hint doesn't match any logged-in account
				return {
					shouldShowUI: true,
					uiType: 'login',
					prefilledEmail: login_hint,
				};
			}

			// Use active account
			return {
				shouldShowUI: false,
				selectedAccount: activeAccount,
			};
		}

		// No session - show login
		return {
			shouldShowUI: true,
			uiType: 'login',
			prefilledEmail: login_hint,
		};
	}

	/**
	 * Handle silent authentication (prompt=none)
	 *
	 * Silent authentication must never show UI. If authentication cannot
	 * proceed silently, an error is returned to the client via redirect.
	 *
	 * Error conditions:
	 * - No browser session → login_required
	 * - No accounts in session → login_required
	 * - Session too old (max_age) → login_required
	 * - Multiple accounts with no active → account_selection_required
	 *
	 * @param browserSession - Current browser session
	 * @param activeAccount - Currently active account
	 * @param allAccounts - All accounts in browser session
	 * @param accountHint - Specific account user ID hint
	 * @param maxAge - Maximum authentication age in seconds
	 * @returns Authorization decision (never shouldShowUI)
	 */
	private handleSilentAuth(
		browserSession: BrowserSession | null,
		activeAccount: AccountSession | null,
		allAccounts: AccountSession[],
		accountHint?: string,
		maxAge?: number
	): AuthorizationDecision {
		// No browser session
		if (!browserSession) {
			return {
				shouldShowUI: false,
				error: {
					error: OIDC_ERRORS.LOGIN_REQUIRED,
					error_description: 'No active session found',
				},
			};
		}

		// No accounts in session
		if (allAccounts.length === 0) {
			return {
				shouldShowUI: false,
				error: {
					error: OIDC_ERRORS.LOGIN_REQUIRED,
					error_description: 'No accounts in session',
				},
			};
		}

		// Account hint provided - find specific account
		if (accountHint) {
			const targetAccount = allAccounts.find((a) => a.userId === accountHint);
			if (!targetAccount) {
				return {
					shouldShowUI: false,
					error: {
						error: OIDC_ERRORS.LOGIN_REQUIRED,
						error_description: 'Requested account not found in session',
					},
				};
			}

			// Check max_age for target account
			if (maxAge !== undefined) {
				const authAge = this.getAuthAgeSeconds(targetAccount.authenticatedAt);
				if (authAge > maxAge) {
					return {
						shouldShowUI: false,
						error: {
							error: OIDC_ERRORS.LOGIN_REQUIRED,
							error_description: 'Session too old, re-authentication required',
						},
					};
				}
			}

			return {
				shouldShowUI: false,
				selectedAccount: targetAccount,
			};
		}

		// Use active account
		if (!activeAccount) {
			// Multiple accounts but none active - needs selection
			if (allAccounts.length > 1) {
				return {
					shouldShowUI: false,
					error: {
						error: OIDC_ERRORS.ACCOUNT_SELECTION_REQUIRED,
						error_description: 'Multiple accounts available, selection required',
					},
				};
			}
			// Single account - use it
			activeAccount = allAccounts[0];
		}

		// Check max_age
		if (maxAge !== undefined) {
			const authAge = this.getAuthAgeSeconds(activeAccount.authenticatedAt);
			if (authAge > maxAge) {
				return {
					shouldShowUI: false,
					error: {
						error: OIDC_ERRORS.LOGIN_REQUIRED,
						error_description: 'Session too old, re-authentication required',
					},
				};
			}
		}

		return {
			shouldShowUI: false,
			selectedAccount: activeAccount,
		};
	}

	/**
	 * Build error redirect URL for OIDC errors
	 *
	 * Constructs a redirect URI with error parameters as specified in
	 * OpenID Connect Core 1.0 section 3.1.2.6.
	 *
	 * @param redirectUri - Client's redirect URI
	 * @param error - OIDC error object
	 * @param state - State parameter to echo back
	 * @returns Complete redirect URL with error parameters
	 */
	buildErrorRedirect(redirectUri: string, error: OIDCError, state?: string): string {
		const url = new URL(redirectUri);
		url.searchParams.set('error', error.error);
		if (error.error_description) {
			url.searchParams.set('error_description', error.error_description);
		}
		if (state) {
			url.searchParams.set('state', state);
		}
		return url.toString();
	}

	/**
	 * Calculate authentication age in seconds
	 *
	 * Used for max_age parameter enforcement. Returns the number of seconds
	 * since the account was authenticated.
	 *
	 * @param authenticatedAt - ISO timestamp of authentication
	 * @returns Age in seconds
	 */
	private getAuthAgeSeconds(authenticatedAt: string): number {
		const authTime = new Date(authenticatedAt).getTime();
		const now = Date.now();
		return Math.floor((now - authTime) / 1000);
	}
}
