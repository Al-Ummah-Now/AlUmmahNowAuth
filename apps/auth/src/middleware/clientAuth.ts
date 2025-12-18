/**
 * @fileoverview OAuth 2.0 client authentication middleware
 *
 * Implements RFC 6749 Section 2.3 (Client Authentication) for confidential clients.
 *
 * Supports two authentication methods:
 * 1. HTTP Basic Authentication (RFC 2617) - RECOMMENDED
 *    Authorization: Basic base64(client_id:client_secret)
 *
 * 2. Request body parameters (client_id and client_secret)
 *
 * Security considerations:
 * - All clients with a secret hash are treated as confidential
 * - Client secrets are verified using constant-time comparison
 * - Returns proper OAuth 2.0 error responses (invalid_client)
 */

/// <reference types="@cloudflare/workers-types" />

import { ClientD1Adapter, verifyClientSecret } from '@al-ummah-now/openauth';
import { logger } from '../logger';

// OAuthClient type inferred from OpenAuth client adapter
export type OAuthClient = NonNullable<Awaited<ReturnType<ClientD1Adapter['getClientById']>>>;

/**
 * OAuth 2.0 error response for client authentication failures
 */
interface OAuth2ErrorResponse {
	error: string;
	error_description?: string;
}

/**
 * Extended context with authenticated client
 */
export interface ClientAuthContext {
	authenticatedClient: OAuthClient;
}

/**
 * Parses HTTP Basic Authentication header
 *
 * @param authHeader - The Authorization header value
 * @returns Object with client_id and client_secret, or null if invalid
 */
function parseBasicAuth(authHeader: string): { client_id: string; client_secret: string } | null {
	try {
		// Remove "Basic " prefix
		const base64Credentials = authHeader.replace(/^Basic\s+/i, '');

		// Decode base64
		const credentials = atob(base64Credentials);

		// Split on first colon only (in case password contains colons)
		const colonIndex = credentials.indexOf(':');
		if (colonIndex === -1) {
			return null;
		}

		const client_id = credentials.substring(0, colonIndex);
		const client_secret = credentials.substring(colonIndex + 1);

		return { client_id, client_secret };
	} catch (error) {
		logger.error('Error parsing Basic Auth header', { error });
		return null;
	}
}

/**
 * Creates OAuth 2.0 client authentication middleware
 *
 * This middleware:
 * 1. Extracts client credentials from HTTP Basic Auth or request body
 * 2. Validates the client exists in the database using OpenAuth ClientD1Adapter
 * 3. Verifies the client_secret (all OpenAuth clients have secrets)
 * 4. Attaches the authenticated client to the request context
 *
 * @returns Middleware function that authenticates OAuth 2.0 clients
 */
export function createClientAuthMiddleware() {
	return async (
		request: Request,
		env: Env,
		_ctx: ExecutionContext
	): Promise<{ authenticated: false; response: Response } | { authenticated: true; client: OAuthClient }> => {
		let clientId: string | null = null;
		let clientSecret: string | null = null;

		// Try to extract credentials from HTTP Basic Auth header first (RECOMMENDED method)
		const authHeader = request.headers.get('Authorization');
		if (authHeader && authHeader.toLowerCase().startsWith('basic ')) {
			const credentials = parseBasicAuth(authHeader);
			if (credentials) {
				clientId = credentials.client_id;
				clientSecret = credentials.client_secret;
			}
		}

		// If not in header, try to extract from request body
		if (!clientId) {
			try {
				const contentType = request.headers.get('Content-Type') || '';
				if (contentType.includes('application/x-www-form-urlencoded')) {
					// Clone the request to avoid consuming the body
					const clonedRequest = request.clone();
					const formData = await clonedRequest.formData();
					clientId = formData.get('client_id') as string | null;
					clientSecret = formData.get('client_secret') as string | null;
				}
			} catch (error) {
				logger.error('Error parsing request body for client credentials', { error });
			}
		}

		// Validate that client_id is present
		if (!clientId) {
			const errorResponse: OAuth2ErrorResponse = {
				error: 'invalid_client',
				error_description: 'Client authentication failed: missing client_id',
			};
			return {
				authenticated: false,
				response: new Response(JSON.stringify(errorResponse), {
					status: 401,
					headers: {
						'Content-Type': 'application/json',
						'WWW-Authenticate': 'Basic realm="OAuth 2.0 Client Authentication"',
						'Cache-Control': 'no-store',
						Pragma: 'no-cache',
					},
				}),
			};
		}

		// Retrieve client from database using OpenAuth adapter
		const clientAdapter = new ClientD1Adapter(env.AUTH_DB);
		const client = await clientAdapter.getClientById(clientId);

		if (!client) {
			const errorResponse: OAuth2ErrorResponse = {
				error: 'invalid_client',
				error_description: 'Client authentication failed: unknown client',
			};
			return {
				authenticated: false,
				response: new Response(JSON.stringify(errorResponse), {
					status: 401,
					headers: {
						'Content-Type': 'application/json',
						'WWW-Authenticate': 'Basic realm="OAuth 2.0 Client Authentication"',
						'Cache-Control': 'no-store',
						Pragma: 'no-cache',
					},
				}),
			};
		}

		// Check if client is enabled
		if (!client.enabled) {
			const errorResponse: OAuth2ErrorResponse = {
				error: 'invalid_client',
				error_description: 'Client authentication failed: client is disabled',
			};
			return {
				authenticated: false,
				response: new Response(JSON.stringify(errorResponse), {
					status: 401,
					headers: {
						'Content-Type': 'application/json',
						'WWW-Authenticate': 'Basic realm="OAuth 2.0 Client Authentication"',
						'Cache-Control': 'no-store',
						Pragma: 'no-cache',
					},
				}),
			};
		}

		// All OpenAuth clients have secrets - verify the client_secret
		if (!clientSecret) {
			const errorResponse: OAuth2ErrorResponse = {
				error: 'invalid_client',
				error_description: 'Client authentication failed: client_secret is required',
			};
			return {
				authenticated: false,
				response: new Response(JSON.stringify(errorResponse), {
					status: 401,
					headers: {
						'Content-Type': 'application/json',
						'WWW-Authenticate': 'Basic realm="OAuth 2.0 Client Authentication"',
						'Cache-Control': 'no-store',
						Pragma: 'no-cache',
					},
				}),
			};
		}

		// Verify client_secret (supports secret rotation with previous_secret_hash)
		const secretValid = await verifyClientSecret(clientSecret, client.client_secret_hash);
		const previousSecretValid =
			client.previous_secret_hash &&
			client.previous_secret_expires_at &&
			client.previous_secret_expires_at > Date.now()
				? await verifyClientSecret(clientSecret, client.previous_secret_hash)
				: false;

		if (!secretValid && !previousSecretValid) {
			const errorResponse: OAuth2ErrorResponse = {
				error: 'invalid_client',
				error_description: 'Client authentication failed: invalid client_secret',
			};
			return {
				authenticated: false,
				response: new Response(JSON.stringify(errorResponse), {
					status: 401,
					headers: {
						'Content-Type': 'application/json',
						'WWW-Authenticate': 'Basic realm="OAuth 2.0 Client Authentication"',
						'Cache-Control': 'no-store',
						Pragma: 'no-cache',
					},
				}),
			};
		}

		// Authentication successful - return the authenticated client
		return {
			authenticated: true,
			client,
		};
	};
}
