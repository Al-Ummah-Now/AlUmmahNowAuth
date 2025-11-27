/**
 * @fileoverview OAuth 2.0 token endpoint routes
 *
 * Implements the following OAuth 2.0 endpoints:
 * - POST /token - Token endpoint for authorization_code and refresh_token grants
 * - POST /token/introspect - Token introspection (RFC 7662)
 * - POST /token/revoke - Token revocation (RFC 7009)
 *
 * Complies with:
 * - OAuth 2.0 (RFC 6749)
 * - Token Introspection (RFC 7662)
 * - Token Revocation (RFC 7009)
 * - JWT Best Practices (RFC 8725)
 */

import { TokenService } from '../services/token-service';
import { TokenError } from '../types/errors';
import { createClientAuthMiddleware } from '../middleware/clientAuth';

/**
 * OAuth 2.0 error response format
 */
interface OAuth2ErrorResponse {
	error: string;
	error_description?: string;
	error_uri?: string;
}

/**
 * Token introspection request
 */
interface IntrospectionRequest {
	token: string;
	token_type_hint?: 'access_token' | 'refresh_token';
}

/**
 * Token introspection response (RFC 7662)
 */
interface IntrospectionResponse {
	active: boolean;
	scope?: string;
	client_id?: string;
	username?: string;
	token_type?: string;
	exp?: number;
	iat?: number;
	nbf?: number;
	sub?: string;
	aud?: string | string[];
	iss?: string;
	jti?: string;
}

/**
 * Token revocation request
 */
interface RevocationRequest {
	token: string;
	token_type_hint?: 'access_token' | 'refresh_token';
}

/**
 * Handles OAuth 2.0 token endpoint routes
 */
export class TokenRoutes {
	/**
	 * Main router for token endpoints
	 *
	 * @param request - HTTP request
	 * @param env - Cloudflare Workers environment
	 * @param ctx - Execution context
	 * @returns HTTP response
	 */
	static async handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return this.corsPreflightResponse(request, env);
		}

		// Route to appropriate handler
		if (url.pathname === '/token' && request.method === 'POST') {
			return this.addCorsHeaders(await this.handleTokenEndpoint(request, env, ctx), request, env);
		}

		if (url.pathname === '/token/introspect' && request.method === 'POST') {
			return this.addCorsHeaders(await this.handleIntrospection(request, env, ctx), request, env);
		}

		if (url.pathname === '/token/revoke' && request.method === 'POST') {
			return this.addCorsHeaders(await this.handleRevocation(request, env, ctx), request, env);
		}

		// 404 for unknown routes
		return new Response(JSON.stringify({ error: 'not_found' }), {
			status: 404,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	/**
	 * Adds CORS headers to response
	 *
	 * @param response - Original response
	 * @param request - HTTP request (for origin checking)
	 * @param env - Cloudflare Workers environment (for allowed origins)
	 * @returns Response with CORS headers
	 */
	private static addCorsHeaders(response: Response, request: Request, env: Env): Response {
		const headers = new Headers(response.headers);

		// Get allowed origins from environment
		const allowedOrigins = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()) : [];
		const origin = request.headers.get('Origin');

		// Only allow whitelisted origins
		if (origin && allowedOrigins.includes(origin)) {
			headers.set('Access-Control-Allow-Origin', origin);
			headers.set('Vary', 'Origin'); // Important for proper caching
		}

		headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
		headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
		headers.set('Access-Control-Max-Age', '86400'); // 24 hours

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	/**
	 * Returns CORS preflight response
	 *
	 * @param request - HTTP request (for origin checking)
	 * @param env - Cloudflare Workers environment (for allowed origins)
	 * @returns 204 No Content with CORS headers
	 */
	private static corsPreflightResponse(request: Request, env: Env): Response {
		const allowedOrigins = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()) : [];
		const origin = request.headers.get('Origin');
		const headers: Record<string, string> = {
			'Access-Control-Allow-Methods': 'POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Authorization',
			'Access-Control-Max-Age': '86400',
		};

		// Only allow whitelisted origins
		if (origin && allowedOrigins.includes(origin)) {
			headers['Access-Control-Allow-Origin'] = origin;
			headers['Vary'] = 'Origin'; // Important for proper caching
		}

		return new Response(null, { status: 204, headers });
	}

	/**
	 * POST /token - OAuth 2.0 token endpoint
	 *
	 * Supports:
	 * - grant_type=authorization_code (not yet implemented - requires authorization server)
	 * - grant_type=refresh_token (token rotation)
	 *
	 * Now includes OAuth 2.0 client authentication (RFC 6749 Section 2.3):
	 * - Public clients: Authenticate with client_id only
	 * - Confidential clients: Require client_id and client_secret
	 *
	 * @param request - HTTP request
	 * @param env - Cloudflare Workers environment
	 * @param ctx - Execution context
	 * @returns Token response or error
	 */
	private static async handleTokenEndpoint(
		request: Request,
		env: Env,
		ctx: ExecutionContext
	): Promise<Response> {
		try {
			// Parse form data (OAuth 2.0 uses application/x-www-form-urlencoded)
			const contentType = request.headers.get('Content-Type') || '';
			if (!contentType.includes('application/x-www-form-urlencoded')) {
				return this.errorResponse(
					'invalid_request',
					'Content-Type must be application/x-www-form-urlencoded',
					400
				);
			}

			// Authenticate OAuth 2.0 client (RFC 6749 Section 2.3)
			const clientAuthMiddleware = createClientAuthMiddleware();
			const authResult = await clientAuthMiddleware(request, env, ctx);

			if (!authResult.authenticated) {
				// Return authentication error response
				return (authResult as { authenticated: false; response: Response }).response;
			}

			// Client is authenticated - use authenticated client_id
			const authenticatedClient = authResult.client;

			const formData = await request.formData();
			const grantType = formData.get('grant_type') as string;
			const clientIdFromForm = formData.get('client_id') as string;

			// Validate required parameters
			if (!grantType) {
				return this.errorResponse('invalid_request', 'Missing grant_type parameter', 400);
			}

			// Ensure client_id from form matches authenticated client
			// This is important when credentials are provided via HTTP Basic Auth
			if (clientIdFromForm && clientIdFromForm !== authenticatedClient.client_id) {
				return this.errorResponse(
					'invalid_client',
					'client_id in request body does not match authenticated client',
					401
				);
			}

			// Use the authenticated client_id for all operations
			const clientId = authenticatedClient.client_id;

			// Get client IP and user agent for audit logging
			const ipAddress = request.headers.get('CF-Connecting-IP') || undefined;
			const userAgent = request.headers.get('User-Agent') || undefined;

			// Handle refresh_token grant
			if (grantType === 'refresh_token') {
				const refreshToken = formData.get('refresh_token') as string;

				if (!refreshToken) {
					return this.errorResponse('invalid_request', 'Missing refresh_token parameter', 400);
				}

				// Perform token rotation
				const tokenPair = await TokenService.refreshTokenPair(
					ctx,
					env,
					refreshToken,
					clientId,
					ipAddress,
					userAgent
				);

				return new Response(JSON.stringify(tokenPair), {
					status: 200,
					headers: {
						'Content-Type': 'application/json',
						'Cache-Control': 'no-store',
						Pragma: 'no-cache',
					},
				});
			}

			// Handle authorization_code grant (not yet implemented)
			if (grantType === 'authorization_code') {
				return this.errorResponse(
					'unsupported_grant_type',
					'Authorization code grant not yet implemented',
					400
				);
			}

			// Unsupported grant type
			return this.errorResponse('unsupported_grant_type', `Grant type ${grantType} not supported`, 400);
		} catch (error) {
			return this.handleError(error);
		}
	}

	/**
	 * POST /token/introspect - Token introspection endpoint (RFC 7662)
	 *
	 * Validates and returns metadata about a token
	 *
	 * @param request - HTTP request
	 * @param env - Cloudflare Workers environment
	 * @param ctx - Execution context
	 * @returns Introspection response
	 */
	private static async handleIntrospection(
		request: Request,
		env: Env,
		ctx: ExecutionContext
	): Promise<Response> {
		try {
			// Parse form data
			const contentType = request.headers.get('Content-Type') || '';
			if (!contentType.includes('application/x-www-form-urlencoded')) {
				return this.errorResponse(
					'invalid_request',
					'Content-Type must be application/x-www-form-urlencoded',
					400
				);
			}

			const formData = await request.formData();
			const token = formData.get('token') as string;
			const tokenTypeHint = formData.get('token_type_hint') as 'access_token' | 'refresh_token' | null;

			if (!token) {
				return this.errorResponse('invalid_request', 'Missing token parameter', 400);
			}

			// Try to introspect as access token first (or if hinted)
			if (!tokenTypeHint || tokenTypeHint === 'access_token') {
				try {
					const payload = await TokenService.verifyAccessToken(token, env);

					const response: IntrospectionResponse = {
						active: true,
						scope: payload.scope,
						client_id: payload.client_id,
						username: payload.email,
						token_type: 'Bearer',
						exp: payload.exp,
						iat: payload.iat,
						nbf: payload.nbf,
						sub: payload.sub,
						aud: payload.aud,
						iss: payload.iss,
						jti: payload.jti,
					};

					return new Response(JSON.stringify(response), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				} catch (error) {
					// If hint was access_token and it failed, return inactive
					if (tokenTypeHint === 'access_token') {
						return new Response(JSON.stringify({ active: false }), {
							status: 200,
							headers: { 'Content-Type': 'application/json' },
						});
					}
					// Otherwise, try as refresh token
				}
			}

			// Try as refresh token
			if (!tokenTypeHint || tokenTypeHint === 'refresh_token') {
				try {
					const record = await TokenService.validateRefreshToken(token, env);

					const response: IntrospectionResponse = {
						active: true,
						scope: record.scope || 'openid email profile',
						token_type: 'refresh_token',
						exp: record.expires_at,
						iat: record.issued_at,
					};

					return new Response(JSON.stringify(response), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				} catch (error) {
					// Token is not valid
				}
			}

			// Token is inactive/invalid
			return new Response(JSON.stringify({ active: false }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error) {
			return this.handleError(error);
		}
	}

	/**
	 * POST /token/revoke - Token revocation endpoint (RFC 7009)
	 *
	 * Revokes an access token or refresh token
	 *
	 * @param request - HTTP request
	 * @param env - Cloudflare Workers environment
	 * @param ctx - Execution context
	 * @returns Success response (always 200, per RFC 7009)
	 */
	private static async handleRevocation(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			// Parse form data
			const contentType = request.headers.get('Content-Type') || '';
			if (!contentType.includes('application/x-www-form-urlencoded')) {
				return this.errorResponse(
					'invalid_request',
					'Content-Type must be application/x-www-form-urlencoded',
					400
				);
			}

			const formData = await request.formData();
			const token = formData.get('token') as string;
			const tokenTypeHint = formData.get('token_type_hint') as 'access_token' | 'refresh_token' | null;

			if (!token) {
				return this.errorResponse('invalid_request', 'Missing token parameter', 400);
			}

			// Get client IP and user agent for audit logging
			const ipAddress = request.headers.get('CF-Connecting-IP') || undefined;
			const userAgent = request.headers.get('User-Agent') || undefined;

			// For refresh tokens, we can revoke them
			// For access tokens, they're stateless JWTs - we can't revoke them directly
			// but we could maintain a revocation list (not implemented yet)

			if (tokenTypeHint === 'refresh_token' || !tokenTypeHint) {
				try {
					await TokenService.revokeRefreshToken(env, token, 'user_requested', ipAddress, userAgent);
				} catch (error) {
					// Per RFC 7009, we always return 200 even if token doesn't exist
					// This prevents token scanning attacks
				}
			}

			// RFC 7009: Always return 200 OK
			return new Response(null, { status: 200 });
		} catch (error) {
			// Even on error, per RFC 7009, return 200 to prevent information leakage
			return new Response(null, { status: 200 });
		}
	}

	/**
	 * Creates an OAuth 2.0 error response
	 *
	 * @param error - Error code
	 * @param description - Human-readable error description
	 * @param status - HTTP status code
	 * @returns Error response
	 */
	private static errorResponse(error: string, description?: string, status: number = 400): Response {
		const body: OAuth2ErrorResponse = {
			error,
			...(description && { error_description: description }),
		};

		return new Response(JSON.stringify(body), {
			status,
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': 'no-store',
				Pragma: 'no-cache',
			},
		});
	}

	/**
	 * Handles errors and converts them to appropriate HTTP responses
	 *
	 * @param error - The error to handle
	 * @returns HTTP error response
	 */
	private static handleError(error: unknown): Response {
		// Handle TokenError with proper OAuth 2.0 error codes
		if (error instanceof TokenError) {
			const oauthError = this.mapTokenErrorToOAuth(error);
			return this.errorResponse(oauthError.error, error.message, error.statusCode);
		}

		// Handle generic errors
		if (error instanceof Error) {
			return this.errorResponse('server_error', error.message, 500);
		}

		// Unknown error
		return this.errorResponse('server_error', 'An unexpected error occurred', 500);
	}

	/**
	 * Maps TokenError codes to OAuth 2.0 error codes
	 *
	 * @param error - TokenError instance
	 * @returns OAuth 2.0 error code
	 */
	private static mapTokenErrorToOAuth(error: TokenError): { error: string } {
		switch (error.code) {
			case 'INVALID_TOKEN':
			case 'TOKEN_NOT_FOUND':
			case 'SIGNATURE_INVALID':
			case 'CLAIMS_INVALID':
				return { error: 'invalid_grant' };

			case 'TOKEN_EXPIRED':
				return { error: 'invalid_grant' };

			case 'TOKEN_REVOKED':
				return { error: 'invalid_grant' };

			case 'TOKEN_REUSE_DETECTED':
				return { error: 'invalid_grant' };

			case 'CLIENT_ID_MISMATCH':
				return { error: 'invalid_client' };

			case 'MAX_ROTATION_EXCEEDED':
				return { error: 'invalid_grant' };

			case 'CONCURRENT_REFRESH':
				return { error: 'temporarily_unavailable' };

			default:
				return { error: 'server_error' };
		}
	}
}
