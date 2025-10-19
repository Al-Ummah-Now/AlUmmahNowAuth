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
 * - Public clients (client_type='public') can authenticate with client_id only
 * - Confidential clients (client_type='confidential') MUST provide client_secret
 * - Client secrets are verified using constant-time comparison
 * - Returns proper OAuth 2.0 error responses (invalid_client)
 */

/// <reference types="@cloudflare/workers-types" />

import { getOAuthClient, verifyClientSecret, type OAuthClient } from '../services/client-auth-service';

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
		console.error('Error parsing Basic Auth header:', error);
		return null;
	}
}

/**
 * Creates OAuth 2.0 client authentication middleware
 *
 * This middleware:
 * 1. Extracts client credentials from HTTP Basic Auth or request body
 * 2. Validates the client exists in the database
 * 3. For confidential clients, verifies the client_secret
 * 4. For public clients, allows authentication with client_id only
 * 5. Attaches the authenticated client to the request context
 *
 * @returns Middleware function that authenticates OAuth 2.0 clients
 */
export function createClientAuthMiddleware() {
	return async (
		request: Request,
		env: Env,
		ctx: ExecutionContext
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
				console.error('Error parsing request body for client credentials:', error);
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

		// Retrieve client from database
		const client = await getOAuthClient(clientId, env.AUTH_DB);

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

		// Validate client type and authentication
		if (client.client_type === 'confidential') {
			// Confidential clients MUST provide client_secret
			if (!clientSecret) {
				const errorResponse: OAuth2ErrorResponse = {
					error: 'invalid_client',
					error_description: 'Client authentication failed: confidential clients must provide client_secret',
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

			// Verify client_secret
			if (!client.client_secret_hash) {
				console.error('Confidential client has no secret hash stored', { client_id: clientId });
				const errorResponse: OAuth2ErrorResponse = {
					error: 'invalid_client',
					error_description: 'Client authentication failed: server misconfiguration',
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

			const secretValid = await verifyClientSecret(clientSecret, client.client_secret_hash, env);

			if (!secretValid) {
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
		}

		// For public clients, client_id is sufficient (no secret required)
		// Authentication successful - return the authenticated client
		return {
			authenticated: true,
			client,
		};
	};
}
