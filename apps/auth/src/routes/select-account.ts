/**
 * @fileoverview Account selector route handlers
 *
 * Handles the account selection UI during OIDC authorize flow:
 * - GET /select-account: Display account selection UI
 * - POST /select-account: Process account selection
 */

import { BrowserSessionService } from '../services/browser-session.service';
import { AccountSessionService } from '../services/account-session.service';
import { validateClient } from '../middleware/client-validation';
import { renderAccountSelector } from '../ui/select-account';
import { uiLocale } from '../ui/confirm-dialog';
import type { AccountSelectorAccount } from '../ui/select-account';
import { SESSION_CONSTRAINTS } from '../types/sessions';
import type { BrowserSession } from '../types/sessions';

/**
 * Handle GET /select-account
 *
 * Display account selection UI with all logged-in accounts
 */
export async function handleSelectAccountGet(
	request: Request,
	env: Env,
	browserSession: BrowserSession | null
): Promise<Response> {
	const url = new URL(request.url);
	const clientId = url.searchParams.get('client_id');
	const redirectUri = url.searchParams.get('redirect_uri');
	const state = url.searchParams.get('state');
	const scope = url.searchParams.get('scope');
	const codeChallenge = url.searchParams.get('code_challenge');
	const codeChallengeMethod = url.searchParams.get('code_challenge_method');
	const nonce = url.searchParams.get('nonce');

	// Validate required parameters
	if (!clientId || !redirectUri) {
		return new Response(
			`<html><body><h1>Error</h1><p>Missing required parameters</p></body></html>`,
			{ status: 400, headers: { 'Content-Type': 'text/html' } }
		);
	}

	// Validate client
	const clientValidation = await validateClient(env.AUTH_DB, clientId, redirectUri);
	if (!clientValidation.valid) {
		return new Response(
			`<html><body><h1>Authorization Error</h1><p>${clientValidation.error}</p></body></html>`,
			{ status: 400, headers: { 'Content-Type': 'text/html' } }
		);
	}

	// Require browser session
	if (!browserSession) {
		// No session - redirect to login
		const loginUrl = new URL('/authorize', url.origin);
		loginUrl.searchParams.set('client_id', clientId);
		loginUrl.searchParams.set('redirect_uri', redirectUri);
		if (state) loginUrl.searchParams.set('state', state);
		if (scope) loginUrl.searchParams.set('scope', scope);
		if (codeChallenge) {
			loginUrl.searchParams.set('code_challenge', codeChallenge);
			loginUrl.searchParams.set('code_challenge_method', codeChallengeMethod || 'S256');
		}
		if (nonce) loginUrl.searchParams.set('nonce', nonce);
		return Response.redirect(loginUrl.toString(), 302);
	}

	// Get all accounts in browser session
	const browserSessionService = new BrowserSessionService(env.AUTH_DB);
	const sessionWithAccounts = await browserSessionService.getBrowserSessionWithAccounts(
		browserSession.id
	);

	if (!sessionWithAccounts || sessionWithAccounts.accounts.length === 0) {
		// No accounts - redirect to login
		const loginUrl = new URL('/authorize', url.origin);
		loginUrl.searchParams.set('client_id', clientId);
		loginUrl.searchParams.set('redirect_uri', redirectUri);
		if (state) loginUrl.searchParams.set('state', state);
		if (scope) loginUrl.searchParams.set('scope', scope);
		if (codeChallenge) {
			loginUrl.searchParams.set('code_challenge', codeChallenge);
			loginUrl.searchParams.set('code_challenge_method', codeChallengeMethod || 'S256');
		}
		if (nonce) loginUrl.searchParams.set('nonce', nonce);
		return Response.redirect(loginUrl.toString(), 302);
	}

	// Map accounts to UI format
	const accounts: AccountSelectorAccount[] = sessionWithAccounts.accounts.map((account) => ({
		userId: account.userId,
		email: account.user.email,
		name: account.user.name,
		avatarUrl: account.user.avatarUrl,
		lastUsed: account.lastUsed,
		isActive: account.isActive,
	}));

	// Determine if "Use another account" should be shown
	const allowAddAccount =
		sessionWithAccounts.accounts.length < SESSION_CONSTRAINTS.MAX_ACCOUNTS_PER_BROWSER;

	// Render account selector UI
	const html = renderAccountSelector({
		accounts,
		clientId,
		clientName: clientValidation.client!.name,
		redirectUri,
		state: state || undefined,
		scope: scope || undefined,
		codeChallenge: codeChallenge || undefined,
		codeChallengeMethod: codeChallengeMethod || undefined,
		nonce: nonce || undefined,
		allowAddAccount,
		locale: uiLocale(request),
	});

	return new Response(html, {
		status: 200,
		headers: { 'Content-Type': 'text/html' },
	});
}

/**
 * Handle POST /select-account
 *
 * Process account selection and redirect back to authorize with account_hint
 */
export async function handleSelectAccountPost(
	request: Request,
	env: Env,
	browserSession: BrowserSession | null
): Promise<Response> {
	const url = new URL(request.url);

	// Parse form data
	const formData = await request.formData();
	const userId = formData.get('user_id') as string;
	const clientId = formData.get('client_id') as string;
	const redirectUri = formData.get('redirect_uri') as string;
	const state = formData.get('state') as string | null;
	const scope = formData.get('scope') as string | null;
	const codeChallenge = formData.get('code_challenge') as string | null;
	const codeChallengeMethod = formData.get('code_challenge_method') as string | null;
	const nonce = formData.get('nonce') as string | null;

	// Validate required parameters
	if (!userId || !clientId || !redirectUri) {
		return new Response(
			`<html><body><h1>Error</h1><p>Missing required parameters</p></body></html>`,
			{ status: 400, headers: { 'Content-Type': 'text/html' } }
		);
	}

	// Validate client
	const clientValidation = await validateClient(env.AUTH_DB, clientId, redirectUri);
	if (!clientValidation.valid) {
		return new Response(
			`<html><body><h1>Authorization Error</h1><p>${clientValidation.error}</p></body></html>`,
			{ status: 400, headers: { 'Content-Type': 'text/html' } }
		);
	}

	// Require browser session
	if (!browserSession) {
		return new Response(
			`<html><body><h1>Error</h1><p>No active session</p></body></html>`,
			{ status: 401, headers: { 'Content-Type': 'text/html' } }
		);
	}

	// Set the selected account as active
	const accountSessionService = new AccountSessionService(env.AUTH_DB);
	const account = await accountSessionService.setActiveAccountByUserId(
		browserSession.id,
		userId
	);

	if (!account) {
		return new Response(
			`<html><body><h1>Error</h1><p>Account not found in session</p></body></html>`,
			{ status: 404, headers: { 'Content-Type': 'text/html' } }
		);
	}

	// Get the user's email for login_hint
	const browserSessionService = new BrowserSessionService(env.AUTH_DB);
	const sessionWithAccounts = await browserSessionService.getBrowserSessionWithAccounts(browserSession.id);
	const selectedAccount = sessionWithAccounts?.accounts.find(a => a.userId === userId);
	const loginHint = selectedAccount?.user.email;

	// Redirect to authorize with prompt=none - the session is already switched in D1
	// OpenAuth's enterprise issuer will use the D1SessionAdapter to find the active account
	// and issue tokens without requiring re-login (silent auth via D1 session)
	const authorizeUrl = new URL('/authorize', url.origin);
	authorizeUrl.searchParams.set('client_id', clientId);
	authorizeUrl.searchParams.set('redirect_uri', redirectUri);
	authorizeUrl.searchParams.set('response_type', 'code');
	// Use prompt=none to get tokens silently for the already-active session
	authorizeUrl.searchParams.set('prompt', 'none');
	if (loginHint) authorizeUrl.searchParams.set('login_hint', loginHint);
	if (state) authorizeUrl.searchParams.set('state', state);
	if (scope) authorizeUrl.searchParams.set('scope', scope);
	if (codeChallenge) {
		authorizeUrl.searchParams.set('code_challenge', codeChallenge);
		authorizeUrl.searchParams.set('code_challenge_method', codeChallengeMethod || 'S256');
	}
	if (nonce) authorizeUrl.searchParams.set('nonce', nonce);

	return Response.redirect(authorizeUrl.toString(), 302);
}
