/**
 * @fileoverview Rate limit configuration service
 *
 * Reads rate limit settings from KV storage, allowing runtime configuration
 * without redeployment. Falls back to defaults if not configured.
 */

import { logger } from '../logger';

/**
 * Rate limit configuration for a specific endpoint
 */
export interface RateLimitEndpointConfig {
	/** Maximum requests allowed in window */
	limit: number;
	/** Time window in seconds */
	windowSeconds: number;
	/** Whether this limit is enabled */
	enabled: boolean;
}

/**
 * Complete rate limit configuration
 */
export interface RateLimitConfiguration {
	/** Login/registration rate limits */
	login: RateLimitEndpointConfig;
	/** Token introspection rate limits */
	tokenIntrospection: RateLimitEndpointConfig;
	/** Admin API rate limits */
	adminApi: RateLimitEndpointConfig;
	/** Role assignment rate limits */
	roleAssignment: RateLimitEndpointConfig;
	/** Default rate limit for unconfigured endpoints */
	default: RateLimitEndpointConfig;
}

/**
 * Default rate limit configuration
 */
const DEFAULT_CONFIG: RateLimitConfiguration = {
	login: {
		limit: 5,
		windowSeconds: 300,
		enabled: true,
	},
	tokenIntrospection: {
		limit: 10,
		windowSeconds: 60,
		enabled: true,
	},
	adminApi: {
		limit: 10,
		windowSeconds: 3600,
		enabled: true,
	},
	roleAssignment: {
		limit: 20,
		windowSeconds: 3600,
		enabled: true,
	},
	default: {
		limit: 100,
		windowSeconds: 60,
		enabled: true,
	},
};

/**
 * QA environment rate limit configuration (higher limits for testing)
 */
const QA_CONFIG: RateLimitConfiguration = {
	login: {
		limit: 100,
		windowSeconds: 300,
		enabled: true,
	},
	tokenIntrospection: {
		limit: 100,
		windowSeconds: 60,
		enabled: true,
	},
	adminApi: {
		limit: 100,
		windowSeconds: 3600,
		enabled: true,
	},
	roleAssignment: {
		limit: 100,
		windowSeconds: 3600,
		enabled: true,
	},
	default: {
		limit: 1000,
		windowSeconds: 60,
		enabled: true,
	},
};

const CONFIG_KEY = 'config:rate-limits';

/**
 * Get rate limit configuration from KV or return defaults
 */
export async function getRateLimitConfig(
	storage: KVNamespace,
	environment?: string
): Promise<RateLimitConfiguration> {
	try {
		// Try to read from KV first
		const stored = await storage.get(CONFIG_KEY);
		if (stored) {
			const config = JSON.parse(stored) as RateLimitConfiguration;
			logger.debug('Loaded rate limit config from KV');
			return config;
		}
	} catch (error) {
		logger.warn('Failed to read rate limit config from KV', {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	// Return environment-specific defaults
	if (environment === 'qa') {
		logger.debug('Using QA rate limit config');
		return QA_CONFIG;
	}

	logger.debug('Using default rate limit config');
	return DEFAULT_CONFIG;
}

/**
 * Get rate limit for a specific endpoint type
 */
export async function getEndpointRateLimit(
	storage: KVNamespace,
	endpoint: keyof RateLimitConfiguration,
	environment?: string
): Promise<RateLimitEndpointConfig> {
	const config = await getRateLimitConfig(storage, environment);
	return config[endpoint] || config.default;
}

/**
 * Update rate limit configuration in KV
 */
export async function setRateLimitConfig(
	storage: KVNamespace,
	config: Partial<RateLimitConfiguration>
): Promise<void> {
	const currentConfig = await getRateLimitConfig(storage);
	const newConfig = { ...currentConfig, ...config };

	await storage.put(CONFIG_KEY, JSON.stringify(newConfig));
	logger.info('Updated rate limit config in KV', { config: newConfig });
}

/**
 * Reset rate limit configuration to defaults
 */
export async function resetRateLimitConfig(storage: KVNamespace): Promise<void> {
	await storage.delete(CONFIG_KEY);
	logger.info('Reset rate limit config to defaults');
}
