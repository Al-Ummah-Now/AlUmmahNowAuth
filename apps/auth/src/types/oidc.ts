/**
 * @fileoverview OIDC parameter types and error codes
 *
 * This module defines types for OpenID Connect authorize flow parameters,
 * error responses, and authorization decision logic.
 */

import type { AccountSession } from './sessions';

/**
 * OIDC prompt parameter values
 */
export type PromptValue = 'none' | 'login' | 'consent' | 'select_account';

/**
 * OIDC authorize request parameters
 * Combines standard OAuth 2.0 and OIDC extension parameters
 */
export interface OIDCAuthorizeParams {
	// Standard OAuth 2.0
	client_id: string;
	redirect_uri: string;
	response_type: string;
	scope?: string;
	state?: string;
	code_challenge?: string;
	code_challenge_method?: 'S256' | 'plain';

	// OIDC Extensions
	prompt?: PromptValue;
	login_hint?: string;
	account_hint?: string; // User ID hint for specific account
	max_age?: number; // Max auth age in seconds
	acr_values?: string; // Space-separated ACR values
	nonce?: string;

	// Custom Extensions
	action?: 'add_account'; // Force add account flow
	ui_locales?: string;
}

/**
 * OIDC error response
 */
export interface OIDCError {
	error: string;
	error_description?: string;
	state?: string;
}

/**
 * OIDC error codes as defined in OpenID Connect Core 1.0
 */
export const OIDC_ERRORS = {
	LOGIN_REQUIRED: 'login_required',
	CONSENT_REQUIRED: 'consent_required',
	ACCOUNT_SELECTION_REQUIRED: 'account_selection_required',
	INTERACTION_REQUIRED: 'interaction_required',
	INVALID_REQUEST: 'invalid_request',
	UNAUTHORIZED_CLIENT: 'unauthorized_client',
	ACCESS_DENIED: 'access_denied',
	SERVER_ERROR: 'server_error',
} as const;

/**
 * Authorization decision result
 * Determines what action to take in the authorize flow
 */
export interface AuthorizationDecision {
	/** Whether UI should be displayed to the user */
	shouldShowUI: boolean;
	/** Type of UI to show (if shouldShowUI is true) */
	uiType?: 'login' | 'select_account' | 'consent' | 'mfa';
	/** Error response for prompt=none failures */
	error?: OIDCError;
	/** Selected account for silent authentication */
	selectedAccount?: AccountSession;
	/** Email to pre-fill in login form */
	prefilledEmail?: string;
}
