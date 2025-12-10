/**
 * Environment Variable and Secrets Helper
 *
 * Handles extracting values from environment bindings that can be either:
 * - Plain strings (local development via .dev.vars)
 * - Secrets Store bindings (production via Cloudflare Secrets Store)
 *
 * Includes in-memory caching to avoid repeated Secrets Store lookups.
 */

// In-memory cache for secrets (persists for worker lifetime)
const secretsCache = new Map<string, string>();

/**
 * Extract a secret value from environment binding
 *
 * @param binding - The environment binding (can be string or Secrets Store binding)
 * @param secretName - Name of the secret (for logging and caching)
 * @returns The secret value as a string, or empty string if not found
 *
 * @example
 * // In local dev (.dev.vars): c.env.image_storage_key = "abc123"
 * const key = await getSecret(c.env.image_storage_key, 'image_storage_key');
 *
 * @example
 * // In production (Secrets Store): c.env.image_storage_key = { get: () => Promise<string> }
 * const key = await getSecret(c.env.image_storage_key, 'image_storage_key');
 */
export async function getSecret(
	binding: unknown,
	secretName: string,
	fallbackEnv?: Record<string, unknown>
): Promise<string> {
	if (!binding) {
		// Check fallback env if binding is undefined
		if (fallbackEnv && typeof fallbackEnv[secretName] === 'string') {
			return fallbackEnv[secretName] as string;
		}
		return '';
	}

	// Case 1: Plain string (local development from .dev.vars)
	if (typeof binding === 'string') {
		return binding;
	}

	// Case 2: Secrets Store binding (production) - check cache first
	if (typeof (binding as { get?: () => Promise<string> }).get === 'function') {
		// Return cached value if available
		const cached = secretsCache.get(secretName);
		if (cached !== undefined) {
			return cached;
		}

		try {
			const value = await (binding as { get: () => Promise<string> }).get();
			const result = value || '';
			// Cache the value for subsequent requests
			if (result) {
				secretsCache.set(secretName, result);
				return result;
			}
			// If secrets store returned empty, check fallback env
			if (fallbackEnv && typeof fallbackEnv[secretName] === 'string') {
				return fallbackEnv[secretName] as string;
			}
			return result;
		} catch (_error) {
			// Secrets store failed, try fallback env (for local dev)
			if (fallbackEnv && typeof fallbackEnv[secretName] === 'string') {
				return fallbackEnv[secretName] as string;
			}
			return '';
		}
	}

	// Case 3: Unknown binding type - try fallback
	if (fallbackEnv && typeof fallbackEnv[secretName] === 'string') {
		return fallbackEnv[secretName] as string;
	}
	return '';
}

/**
 * Extract a secret and throw an error if missing
 *
 * @param binding - The environment binding
 * @param secretName - Name of the secret (for error messages)
 * @returns The secret value as a string
 * @throws Error if the secret is missing or empty
 *
 * @example
 * const key = await requireSecret(c.env.image_storage_key, 'image_storage_key');
 */
export async function requireSecret(
	binding: unknown,
	secretName: string,
	fallbackEnv?: Record<string, unknown>
): Promise<string> {
	const value = await getSecret(binding, secretName, fallbackEnv);

	if (!value) {
		throw new Error(`Missing required secret: ${secretName}`);
	}

	return value;
}

/**
 * Get an environment variable (plain string only)
 *
 * @param env - The environment object
 * @param varName - Name of the environment variable
 * @param defaultValue - Default value if not found
 * @returns The environment variable value or default
 *
 * @example
 * const zone = getEnvVar(c.env, 'ZONE', 'default-zone');
 */
export function getEnvVar(
	env: Record<string, unknown>,
	varName: string,
	defaultValue: string = ''
): string {
	return (env[varName] as string) || defaultValue;
}

/**
 * Get an environment variable and throw if missing
 *
 * @param env - The environment object
 * @param varName - Name of the environment variable
 * @returns The environment variable value
 * @throws Error if the variable is missing
 *
 * @example
 * const zone = requireEnvVar(c.env, 'ZONE');
 */
export function requireEnvVar(
	env: Record<string, unknown>,
	varName: string
): string {
	const value = getEnvVar(env, varName);

	if (!value) {
		throw new Error(`Missing required environment variable: ${varName}`);
	}

	return value;
}
