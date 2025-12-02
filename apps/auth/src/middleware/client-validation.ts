/**
 * @fileoverview Client validation middleware
 *
 * Validates OAuth client credentials and redirect URIs to prevent
 * open redirect vulnerabilities and unauthorized client access.
 */

import type { D1Database } from '@cloudflare/workers-types';

/**
 * Client validation result
 */
export interface ClientValidationResult {
	valid: boolean;
	error?: string;
	client?: {
		id: string;
		name: string;
		redirectUris: string[];
	};
}

/**
 * Validate OAuth client and redirect URI
 *
 * Security checks:
 * - Client ID must exist in database
 * - Redirect URI must be registered for the client
 * - Redirect URI must match exactly (no wildcards)
 *
 * This function MUST be called before any redirects to prevent
 * open redirect attacks where an attacker could use the authorize
 * endpoint to redirect users to malicious sites.
 *
 * @param db - D1 database instance
 * @param clientId - OAuth client ID from request
 * @param redirectUri - Redirect URI from request
 * @returns Validation result with client info if valid
 */
export async function validateClient(
	db: D1Database,
	clientId: string,
	redirectUri: string
): Promise<ClientValidationResult> {
	// Validate required parameters
	if (!clientId) {
		return {
			valid: false,
			error: 'Missing required parameter: client_id',
		};
	}

	if (!redirectUri) {
		return {
			valid: false,
			error: 'Missing required parameter: redirect_uri',
		};
	}

	// Fetch client from database
	const client = await db
		.prepare(
			`SELECT id, name, redirect_uris
      FROM oauth_clients
      WHERE id = ? AND enabled = 1`
		)
		.bind(clientId)
		.first();

	if (!client) {
		return {
			valid: false,
			error: `Invalid client_id: ${clientId}`,
		};
	}

	// Parse registered redirect URIs
	const redirectUris = JSON.parse(client.redirect_uris as string) as string[];

	// Validate redirect URI is registered
	if (!redirectUris.includes(redirectUri)) {
		return {
			valid: false,
			error: `Invalid redirect_uri. The redirect URI is not registered for this client.`,
		};
	}

	return {
		valid: true,
		client: {
			id: client.id as string,
			name: client.name as string,
			redirectUris,
		},
	};
}

/**
 * Get client by ID
 *
 * Retrieves client information without redirect URI validation.
 * Used when client has already been validated or for non-redirect operations.
 *
 * @param db - D1 database instance
 * @param clientId - OAuth client ID
 * @returns Client info or null if not found
 */
export async function getClient(
	db: D1Database,
	clientId: string
): Promise<{
	id: string;
	name: string;
	redirectUris: string[];
} | null> {
	const client = await db
		.prepare(
			`SELECT id, name, redirect_uris
      FROM oauth_clients
      WHERE id = ? AND enabled = 1`
		)
		.bind(clientId)
		.first();

	if (!client) {
		return null;
	}

	return {
		id: client.id as string,
		name: client.name as string,
		redirectUris: JSON.parse(client.redirect_uris as string) as string[],
	};
}
