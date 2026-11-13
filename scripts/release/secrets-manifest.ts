/**
 * Secrets and client ids each deployed Worker needs, per env (AlUmmahNowAuth).
 * Read by check-secrets.ts and documented in README.md ("Secrets per app").
 * Names and purposes only: never put a value here.
 *
 * When code starts reading a new secret, add it here in the same PR.
 */
export type EnvName = 'production' | 'qa' | 'stage';

/** Auth D1 (oauth_clients) for each env. */
export const AUTH_DBS: Record<EnvName, string> = {
	production: 'af76f007-e21e-43aa-88de-ebfefe46fb56', // al-ummah-now-d1
	qa: '28590f3c-dd92-4c26-a803-d73a9bbe2b58', // al-ummah-now-d1-qa
	stage: 'c7886ef6-c70b-4b7f-a65b-3df9f9aba9e2', // al-ummah-now-d1-stage
};

export interface RequiredSecret {
	name: string;
	purpose: string;
}

export interface WorkerSecrets {
	app: string;
	env: EnvName;
	worker: string;
	required?: RequiredSecret[];
	/** Must NOT be bound in this env (test-only secrets in production). */
	forbidden?: string[];
	/** Plain vars holding an oauth_clients id; checked against AUTH_DBS[env]. */
	clientIdVars?: { name: string; required: boolean }[];
	/** Client ids hard-coded in the app; checked against AUTH_DBS[env]. */
	fixedClientIds?: string[];
}

const TEST_ONLY = ['E2E_CODE_SINK_SECRET', 'TEST_PROMOTE_SECRET', 'E2E_RUN_USERS'];

const AUTH_SECRETS: RequiredSecret[] = [
	{ name: 'CLIENT_SECRET_SALT', purpose: 'Secrets Store; legacy, required by deep health but read by no code (client secrets use per-secret PBKDF2 salts)' },
	{ name: 'KEY_ENCRYPTION_MASTER_KEY', purpose: 'Secrets Store; encrypts JWT signing keys at rest in D1' },
	{ name: 'RESEND_API_KEY', purpose: 'Secrets Store; sends sign-in / verification email' },
	{ name: 'INTERNAL_API_KEY', purpose: 'Secrets Store (internal-api-key[-stage|-qa], the same entries admin-api reads); reports unexpected errors to the videos admin Errors page (#341)' },
	{ name: 'SESSION_SECRET', purpose: 'worker secret, 64 hex chars; encrypts the __session SSO cookie' },
];

const AUTH_TEST_SECRETS: RequiredSecret[] = [
	{ name: 'E2E_CODE_SINK_SECRET', purpose: 'Secrets Store; gates /test/* routes and the E2E email-code sink' },
	{ name: 'TEST_PROMOTE_SECRET', purpose: 'worker secret; E2E role-promotion test route' },
];

const ADMIN_SECRET: RequiredSecret = {
	name: 'ADMIN_CLIENT_SECRET',
	purpose: 'worker secret; client_credentials secret of ADMIN_CLIENT_ID (M2M calls to auth /admin/*)',
};

const PROFILE_CLIENT = '109a1087-6626-40f7-8a7f-7f42f83f4f30';

function envs(envList: EnvName[], make: (env: EnvName, suffix: string) => WorkerSecrets): WorkerSecrets[] {
	return envList.map((env) => make(env, env === 'production' ? '' : `-${env}`));
}

export const SECRETS_MANIFEST: WorkerSecrets[] = [
	...envs(['production', 'qa', 'stage'], (env, s) => ({
		app: 'auth',
		env,
		worker: `al-ummah-now-auth${s}`,
		required: env === 'production' ? AUTH_SECRETS : [...AUTH_SECRETS, ...AUTH_TEST_SECRETS],
		forbidden: env === 'production' ? TEST_ONLY : [],
		clientIdVars: [{ name: 'PROFILE_CLIENT_ID', required: true }],
	})),
	...envs(['production', 'qa', 'stage'], (env, s) => ({
		app: 'admin',
		env,
		worker: `al-ummah-now-auth-admin${s}`,
		required: [ADMIN_SECRET],
		forbidden: env === 'production' ? TEST_ONLY : [],
		clientIdVars: [{ name: 'ADMIN_CLIENT_ID', required: true }],
	})),
	...envs(['production', 'qa', 'stage'], (env, s) => ({
		app: 'profile',
		env,
		worker: `al-ummah-now-profile${s}`,
		forbidden: env === 'production' ? TEST_ONLY : [],
		fixedClientIds: [PROFILE_CLIENT],
	})),
	...envs(['production', 'qa', 'stage'], (env, s) => ({
		app: 'audit-consumer',
		env,
		worker: `al-ummah-now-audit-consumer${s}`,
		forbidden: env === 'production' ? TEST_ONLY : [],
	})),
];
