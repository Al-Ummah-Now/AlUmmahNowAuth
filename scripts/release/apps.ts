/**
 * Deployable apps in this repo and what their deployed configs must look like.
 * Edit this file when an app gains an env (e.g. env.stage) or a required binding.
 */
import type { AppRule, Binding } from './wrangler-config.ts';

const TEST_ONLY = ['E2E_CODE_SINK_SECRET', 'TEST_PROMOTE_SECRET'];

const AUTH_BINDINGS: Binding[] = [
	{ kind: 'd1_databases', name: 'AUTH_DB' },
	{ kind: 'kv_namespaces', name: 'AUTH_STORAGE' },
	{ kind: 'queue_producer', name: 'AUDIT_QUEUE' },
	{ kind: 'secrets_store_secrets', name: 'CLIENT_SECRET_SALT' },
	{ kind: 'secrets_store_secrets', name: 'KEY_ENCRYPTION_MASTER_KEY' },
	{ kind: 'secrets_store_secrets', name: 'RESEND_API_KEY' },
];

export const APPS: AppRule[] = [
	{
		app: 'auth',
		configPath: 'apps/auth/wrangler.json',
		dir: 'apps/auth',
		production: {
			env: 'production',
			vars: { ENVIRONMENT: 'production', OPENAUTH_ISSUER: 'https://auth.alummahnow.net' },
			requiredBindings: AUTH_BINDINGS,
			allowedHosts: ['auth.alummahnow.net'],
			forbiddenNames: TEST_ONLY,
		},
		stage: {
			env: 'stage',
			vars: { ENVIRONMENT: 'stage', OPENAUTH_ISSUER: 'https://auth.stage.alummahnow.net' },
			requiredBindings: AUTH_BINDINGS,
			allowedHosts: ['*.stage.alummahnow.net'],
		},
	},
	{
		app: 'profile',
		configPath: 'apps/profile/wrangler.json',
		dir: 'apps/profile',
		production: {
			env: null,
			vars: { AUTH_SERVER_URL: 'https://auth.alummahnow.net', APP_URL: 'https://profile.auth.alummahnow.net' },
			allowedHosts: ['profile.auth.alummahnow.net'],
			forbiddenNames: TEST_ONLY,
		},
	},
	{
		app: 'admin',
		configPath: 'apps/admin/wrangler.json',
		dir: 'apps/admin',
		production: {
			env: null,
			vars: { AUTH_SERVER_URL: 'https://auth.alummahnow.net', APP_URL: 'https://admin.auth.alummahnow.net' },
			allowedHosts: ['admin.auth.alummahnow.net'],
			forbiddenNames: TEST_ONLY,
		},
	},
];
