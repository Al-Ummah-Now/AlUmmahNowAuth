/**
 * openapi.json and the Auth server's routes say the same thing (AUTH-R4).
 *
 * Read from the source, no server: Hono routes come from their registrations, and
 * the hand-written routers' paths from the string and regex literals they compare
 * a pathname with. Each of those literals is listed below with the operations it
 * serves, so a new one fails here until it is documented (or said not to be an
 * endpoint), and one that is gone fails until it is removed.
 */
import { globSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SRC = 'apps/auth/src';
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
/** The library's source, as installed for the Auth app (its routes are part of the server). */
const OPENAUTH = join(ROOT, 'apps/auth/node_modules/@al-ummah-now/openauth/src');

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'] as const;
interface Operation {
	operationId: string;
	summary?: string;
	'x-summary-ar'?: string;
	'x-audience'?: string;
	parameters?: { name: string; in: string; $ref?: string }[];
	responses?: Record<string, unknown>;
	security?: Record<string, unknown>[];
	tags?: string[];
}
const spec = JSON.parse(read('openapi.json')) as {
	openapi: string;
	paths: Record<string, Record<string, Operation>>;
	components: { securitySchemes: Record<string, unknown> };
	tags: { name: string }[];
};
const operations = Object.entries(spec.paths).flatMap(([path, item]) => Object.entries(item).map(([method, op]) => ({ path, method, op, key: `${method.toUpperCase()} ${path}` })));

/** Comments removed: an example in one is not a route. */
const code = (text: string) =>
	text
		// A path like /session/* in a comment or a string opens no comment
		.replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1')
		.split('\n')
		.map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
		.join('\n');

/** Parameter names don't matter for "the same route". */
const shape = (key: string) => key.replace(/\{[^}]+\}/g, '{}');

// ---------------- Hono routes

interface Mount {
	file: string;
	prefix: string;
	/** Registrations that never serve a request here, and why. */
	unreachable?: Record<string, string>;
}
const openauth = (file: string) => join(OPENAUTH, file);
const HONO: Mount[] = [
	{ file: `${SRC}/custom/user-list-routes.ts`, prefix: '/admin/users' },
	{ file: `${SRC}/custom/user-role-routes.ts`, prefix: '/admin/users' },
	{ file: `${SRC}/custom/role-admin-routes.ts`, prefix: '/admin' },
	{ file: `${SRC}/deletions/routes.ts`, prefix: '/admin/deletions' },
	{ file: `${SRC}/moderation/admin-routes.ts`, prefix: '/admin/moderation-requests' },
	{ file: `${SRC}/themes/routes.ts`, prefix: '/admin/themes' },
	{ file: `${SRC}/routes/admin-stats-routes.ts`, prefix: '/admin' },
	{
		file: `${SRC}/routes/admin-session-routes.ts`,
		prefix: '/admin',
		unreachable: { 'POST /admin/users/{}/force-logout': 'the router sends /admin/users/* without /sessions to the user routes' },
	},
	{
		file: openauth('user/api.ts'),
		prefix: '/admin/users',
		unreachable: { 'DELETE /admin/users/{}/sessions': 'served by routes/admin-session-routes.ts, which the router picks first' },
	},
	{ file: openauth('client/api.ts'), prefix: '/admin' },
	{
		file: openauth('rbac/admin-endpoints.ts'),
		prefix: '/admin',
		unreachable: Object.fromEntries(
			['POST /admin/clients/{}/permissions', 'GET /admin/clients/{}/permissions', 'DELETE /admin/clients/{}/permissions/{}'].map((k) => [k, 'the router sends /admin/clients/* to the client routes']),
		),
	},
	{ file: openauth('session/routes.ts'), prefix: '' },
	{ file: openauth('device.ts'), prefix: '' },
	{ file: openauth('native-passkey.ts'), prefix: '' },
	{ file: openauth('enterprise/issuer.ts'), prefix: '' },
	{ file: openauth('issuer.ts'), prefix: '' },
	{ file: openauth('tenant/api.ts'), prefix: '/tenants' },
	{ file: openauth('provider/password.ts'), prefix: '/password' },
	{ file: openauth('provider/passkey.ts'), prefix: '/passkey' },
];
/** Two routers in one file: /session/* and /admin/sessions/*. */
const ADMIN_SESSION_PATHS = ['/revoke-user', '/revoke'];

/**
 * rbacEndpoints: mounted at /api/permissions (router.ts) and /rbac (the issuer), and
 * rbacAdminEndpoints at /rbac/admin. They answer 401 to everyone unless the host
 * sets a user or an admin on the request, and Auth never does: not an API.
 * apps/auth/src/__tests__/rbac-mounts.test.ts holds that.
 */
const CLOSED = ['/api/permissions', '/rbac'];

function honoRoutes({ file, prefix, unreachable = {} }: Mount): string[] {
	const text = code(readFileSync(resolve(ROOT, file), 'utf8'));
	const found: string[] = [];
	for (const [, method, quoted] of text.matchAll(/\b(?:app|router|route|routes|\w+Routes)\.(get|post|put|patch|delete)\(\s*(['"`][^'"`]*['"`])/g)) {
		const path = quoted!.slice(1, -1);
		if (!path.startsWith('/') || path.includes('${')) continue;
		const base = file.endsWith('session/routes.ts') ? (ADMIN_SESSION_PATHS.includes(path) ? '/admin/sessions' : '/session') : prefix;
		const full = `${base}${path === '/' && base ? '' : path}`.replace(/:(\w+)/g, '{$1}');
		found.push(`${method!.toUpperCase()} ${full}`);
	}
	// moderation/admin-routes.ts registers the decisions through one helper
	for (const [, path] of text.matchAll(/\bdecisionRoute\('([a-z-]+)'/g)) found.push(`POST ${prefix}/{id}/${path}`);
	expect(found.length, `no routes found in ${file}`).toBeGreaterThan(0);
	for (const key of Object.keys(unreachable)) expect(found.map(shape), `${file}: ${key} is gone`).toContain(key);
	return found.filter((key) => !(shape(key) in unreachable));
}

// ---------------- Hand-written routers

/** Only chooses a handler, or only reads the path: the endpoint is elsewhere. */
const DISPATCH: string[] = [];
const ops = (...keys: string[]) => keys;
const LITERALS: Record<string, Record<string, string[]>> = {
	'admin-dlq-routes.ts': {
		'/admin/dlq/cleanup': ops('POST /admin/dlq/cleanup'),
		'/admin/dlq/list': ops('GET /admin/dlq/list'),
		'/admin/dlq/replay': ops('POST /admin/dlq/replay'),
		'/admin/dlq/reset-stale': ops('POST /admin/dlq/reset-stale'),
		'/admin/dlq/stats': ops('GET /admin/dlq/stats'),
	},
	'admin-enterprise-routes.ts': {
		'/^\\/admin\\/audit-logs\\/user\\/[^/]+$/': ops('GET /admin/audit-logs/user/{}'),
		'/^\\/admin\\/users\\/[^/]+\\/tokens$/': ops('GET /admin/users/{}/tokens', 'DELETE /admin/users/{}/tokens'),
		'/admin/audit': ops('GET /admin/audit'),
		'/admin/audit-logs': ops('GET /admin/audit-logs'),
		'/admin/audit-logs/stats': ops('GET /admin/audit-logs/stats'),
		'/admin/health': ops('GET /admin/health'),
		'/admin/metrics': ops('GET /admin/metrics'),
		'/admin/users/tokens/revoke': ops('POST /admin/users/tokens/revoke'),
	},
	'admin-tenant-routes.ts': {
		'/admin/tenants': ops('GET /admin/tenants', 'POST /admin/tenants'),
		'/^\\/admin\\/tenants\\/[^/]+$/': ops('GET /admin/tenants/{}', 'PUT /admin/tenants/{}', 'DELETE /admin/tenants/{}'),
		'/^\\/admin\\/tenants\\/[^/]+\\/admins$/': ops('GET /admin/tenants/{}/admins', 'POST /admin/tenants/{}/admins'),
		'/^\\/admin\\/tenants\\/[^/]+\\/admins\\/[^/]+$/': ops('DELETE /admin/tenants/{}/admins/{}'),
	},
	'deletions/routes.ts': { '/${opts.prefix}': DISPATCH },
	'handlers/account-picker-signout.ts': { '/account-picker/remove': DISPATCH },
	'index.ts': { '/authorize': DISPATCH, '/health': ops('GET /health', 'HEAD /health'), '/session/': DISPATCH, '/session/accounts': DISPATCH, '/token/revoke': DISPATCH },
	'invites/routes.ts': {
		'/^\\/invite\\/([^/]+)(?:\\/(send|request))?\\/?$/': ops('GET /invite/{}', 'POST /invite/{}', 'POST /invite/{}/send', 'POST /invite/{}/request'),
		'/^\\/provisioning\\/invites(?:\\/([^/]+)(?:\\/(resend|link|revoke|restore|purge))?)?\\/?$/': ops(
			'POST /provisioning/invites',
			'GET /provisioning/invites',
			...['resend', 'link', 'revoke', 'restore', 'purge'].map((a) => `POST /provisioning/invites/{}/${a}`),
		),
	},
	'moderation/client-routes.ts': {
		'/^\\/moderation\\/requests(?:\\/([^/]+))?(\\/info)?\\/?$/': ops('POST /moderation/requests', 'GET /moderation/requests', 'GET /moderation/requests/{}', 'POST /moderation/requests/{}/info'),
	},
	'passkeys/native.ts': {
		'/native/passkey/register/options': ops('POST /native/passkey/register/options'),
		'/native/passkey/register/verify': ops('POST /native/passkey/register/verify'),
	},
	'passkeys/pages.ts': { '/passkeys/card/language': ops('GET /passkeys/card/language', 'POST /passkeys/card/language') },
	'passkeys/routes.ts': {
		'/^\\/account\\/passkeys\\/([A-Za-z0-9_-]{1,512})(\\/restore)?$/': ops('PATCH /account/passkeys/{}', 'DELETE /account/passkeys/{}', 'POST /account/passkeys/{}/restore'),
		'/^\\/admin\\/users\\/([^/]+)\\/passkeys(?:\\/(setup-link|[A-Za-z0-9_-]{1,512}))?$/': ops('GET /admin/users/{}/passkeys', 'POST /admin/users/{}/passkeys/setup-link', 'DELETE /admin/users/{}/passkeys/{}'),
		'/^\\/admin\\/users\\/[^/]+\\/passkeys/': DISPATCH,
		'/account/passkeys': ops('GET /account/passkeys'),
		'/account/passkeys/': DISPATCH,
		'/admin/settings/staff-passkeys': ops('GET /admin/settings/staff-passkeys', 'PUT /admin/settings/staff-passkeys'),
		'/passkeys/': DISPATCH,
		'/passkeys/email-code': ops('POST /passkeys/email-code'),
		'/passkeys/prompt/dismiss': ops('POST /passkeys/prompt/dismiss'),
		'/passkeys/prompt/failed': ops('POST /passkeys/prompt/failed'),
		'/passkeys/register/options': ops('POST /passkeys/register/options'),
		'/passkeys/register/verify': ops('POST /passkeys/register/verify'),
		'/passkeys/setup': ops('GET /passkeys/setup'),
	},
	'revocation/install-routes.ts': { '/internal/token-revocations': ops('POST /internal/token-revocations') },
	'router.ts': {
		'/': ops('GET /'),
		'/docs': ops('GET /docs'),
		'/callback': ops('GET /callback'),
		'/logout': ops('GET /logout', 'POST /logout'),
		'/select-account': ops('GET /select-account', 'POST /select-account'),
		'/settings/sessions': ops('GET /settings/sessions'),
		'/ui/account-switcher': ops('GET /ui/account-switcher'),
		'/admin/sessions/dashboard': ops('GET /admin/sessions/dashboard'),
		'/account': ops('DELETE /account'),
		'/account/export': ops('GET /account/export'),
		'/account/name': ops('PUT /account/name'),
		'/account/sign-out-all': ops('POST /account/sign-out-all'),
		'/themes': ops('GET /themes'),
		'/themes/resolve': ops('GET /themes/resolve'),
		'/themes/assets/': ops('GET /themes/assets/{}'),
		...Object.fromEntries(
			[
				'/^\\/admin/', '/^\\/admin\\/clients/', '/^\\/admin\\/users/', '/^\\/admin\\/users\\/[^/]+\\/tokens$/', '/^\\/admin\\/users\\/[^/]+\\/sessions/', '/^\\/admin\\/users\\/[^/]+\\/passkeys/', '/^\\/api\\/permissions/',
				'/account/passkeys', '/account/passkeys/', '/admin', '/admin/', '/admin/audit', '/admin/audit-logs', '/admin/clients', '/admin/deletions', '/admin/deletions/', '/admin/dlq', '/admin/health', '/admin/metrics',
				'/admin/moderation-requests', '/admin/moderation-requests/', '/admin/permissions', '/admin/roles', '/admin/sessions', '/admin/sessions/revoke', '/admin/sessions/revoke-user', '/admin/settings/staff-passkeys',
				'/admin/stats', '/admin/tenants', '/admin/themes', '/admin/themes/', '/admin/users', '/admin/users/tokens/revoke', '/api/permissions', '/authorize', '/invite/', '/moderation/requests', '/moderation/requests/',
				'/passkeys/', '/provisioning/invites', '/provisioning/invites/', '/session/', '/tenants', '/tenants/', '/test/', '/token', '/token/introspect', '/token/revoke',
			].map((literal) => [literal, DISPATCH]),
		),
	},
	'security/password-change-redirect.ts': { '/password/change': DISPATCH },
	'security/password-guard.ts': { '/^\\/password\\/(authorize|register|change)$/': DISPATCH },
	// A script for tests; production answers 404
	'security/turnstile.ts': { '/turnstile/stub.js': DISPATCH },
	'sign-in-link/routes.ts': {
		'/^\\/(password\\/authorize|authorize)(\\?|$)/': DISPATCH,
		'/sign-in/link': ops('GET /sign-in/link', 'POST /sign-in/link'),
		'/sign-in/method': ops('POST /sign-in/method'),
	},
	'signing-keys/routes.ts': { '/admin/settings/signing-keys': ops('GET /admin/settings/signing-keys', 'POST /admin/settings/signing-keys') },
	'utils/email-availability.ts': { '/^\\/password\\/(register|change)(\\/|$)/': DISPATCH },
	'utils/preview-redirects.ts': { '/authorize': DISPATCH },
	'utils/request-timing.ts': { '/^\\/(authorize|token|password\\/|code\\/|session\\/|select-account|activate|device)/': DISPATCH },
	'utils/site-redirects.ts': { '/authorize': DISPATCH },
};

/** The pathname literals of one file. */
export function literalsOf(text: string): string[] {
	const source = code(text);
	const found = new Set<string>();
	for (const [, literal] of source.matchAll(/(?:(?:pathname|\bpath)\s*[!=]==\s*|\bcase\s+|(?:pathname|\bpath)\.startsWith\(\s*|_PATH\s*=\s*)['"`](\/[^'"`]*)['"`]/g)) found.add(literal!);
	for (const [literal] of source.matchAll(/\/\^\\\/(?:\[(?:[^\]\\\n]|\\.)*\]|\\.|[^/\\\n[])*\//g)) found.add(literal);
	return [...found].sort();
}

const files = globSync('**/*.ts', { cwd: join(ROOT, SRC) })
	.filter((f) => !/test/.test(f))
	.sort();

const served = new Set([...HONO.flatMap(honoRoutes), ...Object.values(LITERALS).flatMap((l) => Object.values(l).flat())].map(shape));
const documented = new Set(operations.map(({ key }) => shape(key)));

describe('openapi.json covers the server', () => {
	it('every route is documented', () => {
		const missing = [...served].filter((key) => !documented.has(key)).sort();
		expect(missing).toEqual([]);
	});

	it('every documented operation is a route', () => {
		const gone = [...documented].filter((key) => !served.has(key)).sort();
		expect(gone).toEqual([]);
	});

	it('every pathname the source compares with is accounted for', () => {
		const actual = Object.fromEntries(files.map((f) => [f, literalsOf(read(`${SRC}/${f}`))]).filter(([, l]) => l!.length));
		const listed = Object.fromEntries(Object.entries(LITERALS).map(([f, l]) => [f, Object.keys(l).sort()]));
		expect(actual).toEqual(listed);
	});

	it('every file that registers Hono routes is listed', () => {
		const registers = files.filter((f) => /\b(?:app|router|route|routes|\w+Routes)\.(get|post|put|patch|delete)\(\s*['"`]\//.test(code(read(`${SRC}/${f}`))));
		const listed = HONO.filter((m) => m.file.startsWith(SRC)).map((m) => m.file.slice(SRC.length + 1));
		expect(registers.sort()).toEqual(listed.sort());
	});

	it('what answers 401 to everyone is not documented as an API', () => {
		expect(operations.filter(({ path }) => CLOSED.some((p) => path === p || path.startsWith(`${p}/`)))).toEqual([]);
	});

	it('reads the literals it claims to', () => {
		expect(literalsOf("if (pathname === '/a') x; switch (p) { case '/b': } path.startsWith('/c/'); export const D_PATH = '/d'; /^\\/e\\/[^/]+$/.test(p) // pathname === '/no'\n/* case '/no' */")).toEqual(['/^\\/e\\/[^/]+$/', '/a', '/b', '/c/', '/d']);
	});
});

describe('openapi.json is sound', () => {
	it('is OpenAPI 3.1 with unique operation ids', () => {
		expect(spec.openapi).toBe('3.1.0');
		const ids = operations.map(({ op }) => op.operationId);
		expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
	});

	it('every $ref resolves', () => {
		const broken: string[] = [];
		const walk = (node: unknown): void => {
			if (!node || typeof node !== 'object') return;
			const ref = (node as { $ref?: unknown }).$ref;
			if (typeof ref === 'string') {
				const target = ref.slice(2).split('/').reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], spec);
				if (!ref.startsWith('#/') || target === undefined) broken.push(ref);
			}
			Object.values(node).forEach(walk);
		};
		walk(spec);
		expect(broken).toEqual([]);
	});

	it('every operation has an audience, a summary, responses and a known security scheme', () => {
		const tags = spec.tags.map((t) => t.name);
		for (const { key, op, method } of operations) {
			expect(METHODS, key).toContain(method);
			expect(['public', 'app', 'page', 'admin'], key).toContain(op['x-audience']);
			expect(op.summary?.trim(), key).toBeTruthy();
			expect(Object.keys(op.responses ?? {}).length, key).toBeGreaterThan(0);
			expect(op.security, key).toBeDefined();
			for (const scheme of op.security!.flatMap((s) => Object.keys(s))) expect(Object.keys(spec.components.securitySchemes), key).toContain(scheme);
			for (const tag of op.tags ?? []) expect(tags, key).toContain(tag);
		}
	});

	it('every staff route requires a staff token, and only staff routes do', () => {
		for (const { key, op, path } of operations) {
			const staff = op.security!.some((s) => 'adminToken' in s);
			expect({ key, staff }).toEqual({ key, staff: op['x-audience'] === 'admin' });
			if ((path.startsWith('/admin/') || path === '/tenants' || path.startsWith('/tenants/')) && op['x-audience'] !== 'page') expect(op['x-audience'], key).toBe('admin');
		}
	});

	it('what developers read is in English and Arabic', () => {
		for (const { key, op } of operations.filter(({ op }) => op['x-audience'] === 'public' || op['x-audience'] === 'app')) {
			expect(op['x-summary-ar'], key).toMatch(/[؀-ۿ]/);
		}
	});

	it('openapi.ar.json has the Arabic of every other string the reference shows, and nothing more', () => {
		const ar = JSON.parse(read('openapi.ar.json')) as Record<string, string>;
		const doc = spec as unknown as { components: Record<'schemas' | 'responses', Record<string, unknown>> };
		const shown = new Set<string>();
		const add = (text: unknown) => typeof text === 'string' && shown.add(text);
		type Node = { $ref?: string; description?: string; properties?: Record<string, Node>; oneOf?: Node[]; content?: Record<string, { schema?: Node }> };
		const follow = (node: Node | undefined): Node | undefined => (node?.$ref ? (node.$ref.slice(2).split('/').reduce<unknown>((at, k) => (at as Record<string, unknown>)[k], doc) as Node) : node);
		const schema = (raw: Node | undefined): void => {
			const node = follow(raw);
			add(node?.description);
			for (const field of Object.values(node?.properties ?? {})) add(field.description);
			node?.oneOf?.forEach(schema);
		};
		const content = (node: Node | undefined) => Object.values(node?.content ?? {}).forEach((c) => schema(c.schema));
		for (const { op } of operations.filter(({ op }) => op['x-audience'] === 'public' || op['x-audience'] === 'app')) {
			const o = op as unknown as Node & { tags: string[]; parameters?: Node[]; requestBody?: Node; responses: Record<string, Node> };
			add(o.description);
			o.tags.forEach(add);
			o.parameters?.forEach((p) => add(p.description));
			content(o.requestBody);
			for (const raw of Object.values(o.responses)) {
				const response = follow(raw)!;
				add(response.description);
				content(response);
			}
		}
		expect(Object.keys(ar).sort()).toEqual([...shown].sort());
		for (const [en, text] of Object.entries(ar)) {
			// Numbers are {N…} or {N=…}, formatted in the reader's numerals; a status or a name stays as it is
			const plain = text.replace(/\{N=?\d+\}/g, '').replace(/[A-Za-z][\w./:()-]*/g, '').replace(/\b[245]\d\d\b/g, '');
			expect(plain, en).not.toMatch(/[0-9]/);
			expect(text, en).not.toMatch(/,(?=\s)|;(?=\s)/);
		}
	});

	it('path parameters match the path', () => {
		for (const { key, path, op } of operations) {
			const named = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
			const declared = (op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name).sort();
			expect(declared, key).toEqual(named);
		}
	});

	it('names no real client id or secret', () => {
		expect(read('openapi.json')).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
	});
});
