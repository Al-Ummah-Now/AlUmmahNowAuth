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
			vars: {
				ENVIRONMENT: 'production',
				OPENAUTH_ISSUER: 'https://auth.alummahnow.net',
				SIGN_IN_FALLBACK_URL: 'https://videos.alummahnow.net/',
			},
			requiredBindings: AUTH_BINDINGS,
			allowedHosts: ['auth.alummahnow.net'],
			forbiddenNames: TEST_ONLY,
		},
		stage: {
			env: 'stage',
			vars: { ENVIRONMENT: 'stage', OPENAUTH_ISSUER: 'https://auth.stage.alummahnow.net' },
			requiredBindings: AUTH_BINDINGS,
			allowedHosts: ['*.stage.alummahnow.net'],
			testOnlyNames: TEST_ONLY,
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
		stage: {
			env: 'stage',
			vars: { AUTH_SERVER_URL: 'https://auth.stage.alummahnow.net', APP_URL: 'https://profile.auth.stage.alummahnow.net' },
			requiredBindings: [{ kind: 'kv_namespaces', name: 'AUTH_STORAGE' }],
			allowedHosts: ['*.stage.alummahnow.net'],
		},
	},
	{
		app: 'admin',
		configPath: 'apps/admin/wrangler.json',
		dir: 'apps/admin',
		production: {
			env: null,
			vars: {
				AUTH_SERVER_URL: 'https://auth.alummahnow.net',
				APP_URL: 'https://admin.auth.alummahnow.net',
				// Auth Admin client in prod D1: login client AND the M2M client whose
				// secret is the worker's ADMIN_CLIENT_SECRET.
				ADMIN_CLIENT_ID: '1448ed27-39a6-417d-b4c8-07f881e81269',
			},
			allowedHosts: ['admin.auth.alummahnow.net'],
			forbiddenNames: TEST_ONLY,
		},
		stage: {
			env: 'stage',
			vars: {
				AUTH_SERVER_URL: 'https://auth.stage.alummahnow.net',
				APP_URL: 'https://admin.auth.stage.alummahnow.net',
				// prod's "Auth Admin" client; prod itself still points at a missing client (#190)
				ADMIN_CLIENT_ID: '1448ed27-39a6-417d-b4c8-07f881e81269',
			},
			requiredBindings: [{ kind: 'kv_namespaces', name: 'AUTH_STORAGE' }],
			allowedHosts: ['*.stage.alummahnow.net'],
		},
	},
	{
		app: 'audit-consumer',
		configPath: 'apps/audit-consumer/wrangler.jsonc',
		dir: 'apps/audit-consumer',
		production: {
			env: null,
			requiredBindings: [
				{ kind: 'd1_databases', name: 'AUDIT_DB' },
				{ kind: 'queue_consumer', name: 'audit-events' },
			],
			allowedHosts: [],
			requireRoutes: false,
			forbiddenNames: TEST_ONLY,
		},
		stage: {
			env: 'stage',
			requiredBindings: [
				{ kind: 'd1_databases', name: 'AUDIT_DB' },
				{ kind: 'queue_consumer', name: 'audit-events-stage' },
			],
			allowedHosts: [],
			requireRoutes: false,
		},
	},
];
