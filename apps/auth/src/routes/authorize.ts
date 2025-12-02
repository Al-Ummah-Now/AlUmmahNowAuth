/**
 * @fileoverview OIDC authorize endpoint handler
 *
 * Handles OAuth 2.0 / OpenID Connect authorization requests with support for:
 * - prompt parameter (none, login, consent, select_account)
 * - login_hint and account_hint for pre-filling/selecting accounts
 * - max_age for re-authentication enforcement
 * - PKCE (Proof Key for Code Exchange)
 * - Silent authentication (prompt=none) for SSO
 *
 * This function is called from the main fetch handler before delegating
 * to OpenAuth's authorize flow.
 */

import { OIDCAuthorizeService } from '../services/oidc-authorize.service';
import { BrowserSessionService } from '../services/browser-session.service';
import { AccountSessionService } from '../services/account-session.service';
import { validateClient } from '../middleware/client-validation';
import { generateAuthorizationCode } from '../utils/authorization-code';
import type { OIDCAuthorizeParams } from '../types/oidc';
import type { BrowserSession, AccountSession } from '../types/sessions';

/**
 * Handle OIDC authorize request
 *
 * Main OIDC authorize endpoint. Determines the appropriate action based on:
 * - OIDC parameters (prompt, login_hint, account_hint, max_age)
 * - Current session state (browser session and active account)
 *
 * @param request - The HTTP request
 * @param env - Environment bindings
 * @param browserSession - Current browser session (if any)
 * @param activeAccount - Active account session (if any)
 * @returns Response or null if OpenAuth should handle it
 */
export async function handleAuthorizeRequest(
	request: Request,
	env: Env,
	browserSession: BrowserSession | null,
	activeAccount: AccountSession | null
): Promise<Response | null> {
	const url = new URL(request.url);

	// Parse OIDC parameters from query string
	const params: OIDCAuthorizeParams = {
		client_id: url.searchParams.get('client_id') || '',
		redirect_uri: url.searchParams.get('redirect_uri') || '',
		response_type: url.searchParams.get('response_type') || 'code',
		scope: url.searchParams.get('scope') || undefined,
		state: url.searchParams.get('state') || undefined,
		code_challenge: url.searchParams.get('code_challenge') || undefined,
		code_challenge_method: (url.searchParams.get('code_challenge_method') as 'S256' | 'plain') || undefined,
		prompt: url.searchParams.get('prompt') as any,
		login_hint: url.searchParams.get('login_hint') || undefined,
		account_hint: url.searchParams.get('account_hint') || undefined,
		max_age: url.searchParams.get('max_age') ? parseInt(url.searchParams.get('max_age')!) : undefined,
		acr_values: url.searchParams.get('acr_values') || undefined,
		nonce: url.searchParams.get('nonce') || undefined,
		action: url.searchParams.get('action') as any,
	};

	// Validate client and redirect_uri FIRST (before any redirects)
	// This prevents open redirect vulnerabilities
	const clientValidation = await validateClient(
		env.AUTH_DB,
		params.client_id,
		params.redirect_uri
	);

	if (!clientValidation.valid) {
		// Don't redirect for invalid client - show error page
		return new Response(
			`
      <html>
        <head>
          <title>Authorization Error</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              background: #f5f5f5;
              margin: 0;
            }
            .error-container {
              background: white;
              padding: 40px;
              border-radius: 8px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
              max-width: 500px;
              text-align: center;
            }
            h1 {
              color: #d32f2f;
              margin-bottom: 16px;
            }
            p {
              color: #666;
              line-height: 1.5;
            }
          </style>
        </head>
        <body>
          <div class="error-container">
            <h1>Authorization Error</h1>
            <p>${clientValidation.error}</p>
          </div>
        </body>
      </html>
    `,
			{ status: 400, headers: { 'Content-Type': 'text/html' } }
		);
	}

	// Get all accounts in browser session
	let allAccounts: AccountSession[] = [];
	if (browserSession) {
		const browserSessionService = new BrowserSessionService(env.AUTH_DB);
		const sessionWithAccounts = await browserSessionService.getBrowserSessionWithAccounts(
			browserSession.id
		);
		allAccounts = sessionWithAccounts?.accounts || [];
	}

	// Process authorization request with OIDC service
	const oidcService = new OIDCAuthorizeService(env.AUTH_DB);
	const decision = await oidcService.processAuthorizeRequest(
		params,
		browserSession,
		activeAccount,
		allAccounts
	);

	// Handle error response (for prompt=none failures)
	if (decision.error) {
		const errorUrl = oidcService.buildErrorRedirect(
			params.redirect_uri,
			decision.error,
			params.state
		);
		return Response.redirect(errorUrl, 302);
	}

	// Silent auth success - generate code and redirect
	if (!decision.shouldShowUI && decision.selectedAccount) {
		// Switch active account if needed
		if (decision.selectedAccount.id !== activeAccount?.id) {
			const accountService = new AccountSessionService(env.AUTH_DB);
			await accountService.setActiveAccount(browserSession!.id, decision.selectedAccount.id);
		}

		// Generate authorization code
		const code = await generateAuthorizationCode(env.AUTH_DB, {
			clientId: params.client_id,
			userId: decision.selectedAccount.userId,
			redirectUri: params.redirect_uri,
			scope: params.scope,
			codeChallenge: params.code_challenge,
			codeChallengeMethod: params.code_challenge_method,
			nonce: params.nonce,
		});

		// Redirect to client with authorization code
		const redirectUrl = new URL(params.redirect_uri);
		redirectUrl.searchParams.set('code', code);
		if (params.state) {
			redirectUrl.searchParams.set('state', params.state);
		}

		return Response.redirect(redirectUrl.toString(), 302);
	}

	// Show UI based on decision
	if (decision.uiType === 'select_account') {
		// Redirect to account selector
		const selectorUrl = new URL('/select-account', url.origin);
		selectorUrl.searchParams.set('client_id', params.client_id);
		selectorUrl.searchParams.set('redirect_uri', params.redirect_uri);
		if (params.state) selectorUrl.searchParams.set('state', params.state);
		if (params.scope) selectorUrl.searchParams.set('scope', params.scope);
		if (params.code_challenge) {
			selectorUrl.searchParams.set('code_challenge', params.code_challenge);
			selectorUrl.searchParams.set(
				'code_challenge_method',
				params.code_challenge_method || 'S256'
			);
		}
		if (params.nonce) selectorUrl.searchParams.set('nonce', params.nonce);
		return Response.redirect(selectorUrl.toString(), 302);
	}

	if (decision.uiType === 'consent') {
		// Consent UI not implemented yet - fallback to login
		// TODO: Implement consent UI in future
		return new Response(
			`<html><body><h1>Consent Required</h1><p>Consent UI not yet implemented</p></body></html>`,
			{ status: 501, headers: { 'Content-Type': 'text/html' } }
		);
	}

	if (decision.uiType === 'mfa') {
		// MFA UI not implemented yet
		// TODO: Implement MFA UI in future
		return new Response(
			`<html><body><h1>MFA Required</h1><p>MFA UI not yet implemented</p></body></html>`,
			{ status: 501, headers: { 'Content-Type': 'text/html' } }
		);
	}

	// Show login UI - delegate to OpenAuth's email authorize flow
	// Return null to indicate that OpenAuth should handle the request
	// The calling code will pass this to OpenAuth's issuer
	return null;
}
