/**
 * openapi.json lists every status the handlers answer (AUTH-R4).
 *
 * Read from the source with the TypeScript parser: from each route's handler, follow
 * the functions it calls (in its own file and the companion files named below) and
 * collect the statuses they answer or throw. Every 4xx, 201, 202, 204 and 503 found
 * must be in the spec. It can't see a status computed at run time, and it may find one
 * an operation can't reach; those few are listed in UNREACHED with the reason.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SRC = 'apps/auth/src';
const OPENAUTH = 'apps/auth/node_modules/@al-ummah-now/openauth/src';
const spec = JSON.parse(readFileSync(join(ROOT, 'openapi.json'), 'utf8')) as { paths: Record<string, Record<string, { 'x-audience'?: string; responses: Record<string, unknown> }>> };

const parsed = new Map<string, ts.SourceFile>();
function source(file: string): ts.SourceFile {
	let found = parsed.get(file);
	if (!found) {
		found = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
		parsed.set(file, found);
	}
	return found;
}

/** Functions, methods and const arrows of a file, by name: every one, when objects share a method name. */
function functionsOf(file: string): Map<string, ts.Node[]> {
	const out = new Map<string, ts.Node[]>();
	const add = (name: string, node: ts.Node) => out.set(name, [...(out.get(name) ?? []), node]);
	const visit = (node: ts.Node): void => {
		if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && node.body) add(node.name.getText(), node);
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer) || ts.isCallExpression(node.initializer) || ts.isObjectLiteralExpression(node.initializer)))
			add(node.name.text, node.initializer);
		if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && (ts.isCallExpression(node.initializer) || ts.isArrowFunction(node.initializer))) add(node.name.text, node.initializer);
		ts.forEachChild(node, visit);
	};
	visit(source(file));
	return out;
}

const COUNTS = (n: number) => [201, 202, 204, 503].includes(n) || (n >= 400 && n < 500);
/** A numeric argument of these is a length or a time, not a status. */
const NOT_STATUS = new Set(['slice', 'substring', 'padStart', 'setTimeout', 'min', 'max', 'parseInt', 'maxLength', 'minLength', 'repeat', 'bind']);

/** The statuses a node answers, and the names it calls. */
function read(node: ts.Node): { statuses: Set<number>; calls: Set<string> } {
	const statuses = new Set<number>();
	const calls = new Set<string>();
	const numbers = (expr: ts.Node): void => {
		if (ts.isNumericLiteral(expr)) {
			const n = Number(expr.text);
			if (COUNTS(n)) statuses.add(n);
		} else if (ts.isConditionalExpression(expr)) {
			numbers(expr.whenTrue);
			numbers(expr.whenFalse);
		}
	};
	const visit = (n: ts.Node): void => {
		if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
			const callee = n.expression;
			const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
			if (name) calls.add(name);
			if (!NOT_STATUS.has(name)) n.arguments?.forEach(numbers);
			// A handler or a limiter passed by name
			n.arguments?.forEach((a) => {
				if (ts.isIdentifier(a)) calls.add(a.text);
				if (ts.isPropertyAccessExpression(a)) calls.add(a.name.text);
			});
		}
		if (ts.isPropertyAssignment(n) && n.name.getText() === 'status') numbers(n.initializer);
		if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && n.left.getText() === 'status') numbers(n.right);
		ts.forEachChild(n, visit);
	};
	visit(node);
	return { statuses, calls };
}

function statusesFrom(root: ts.Node, files: string[]): Set<number> {
	// A name a file and its companion both use could be either: both are read
	const known = new Map<string, ts.Node[]>();
	for (const file of files) for (const [name, nodes] of functionsOf(file)) known.set(name, [...(known.get(name) ?? []), ...nodes]);
	const all = new Set<number>();
	const seen = new Set<ts.Node>();
	const queue = [root];
	for (let node = queue.pop(); node; node = queue.pop()) {
		if (seen.has(node)) continue;
		seen.add(node);
		const { statuses, calls } = read(node);
		statuses.forEach((s) => all.add(s));
		for (const call of calls) {
			queue.push(...(known.get(call) ?? []));
		}
	}
	return all;
}

// ---------------- Hono routes: the registration is the root

interface Mount {
	file: string;
	prefix: string;
	/** Files whose functions the handlers call. */
	with?: string[];
	/** Registered, but another handler answers first in Auth (index.ts, router.ts). */
	shadowed?: string[];
}
const LIMIT = `${SRC}/middleware/rate-limit.ts`;
const DELETE = [`${SRC}/deletions/routes.ts`, `${SRC}/deletions/service.ts`];
const KINDS = `${SRC}/deletions/kinds.ts`;
const HONO: Mount[] = [
	{ file: `${SRC}/custom/user-list-routes.ts`, prefix: '/admin/users' },
	{ file: `${SRC}/custom/user-role-routes.ts`, prefix: '/admin/users' },
	{ file: `${SRC}/deletions/routes.ts`, prefix: '/admin/deletions', with: [`${SRC}/deletions/service.ts`, KINDS] },
	{ file: `${SRC}/invites/admin-routes.ts`, prefix: '/admin/invites', with: [LIMIT] },
	{ file: `${SRC}/moderation/admin-routes.ts`, prefix: '/admin/moderation-requests', with: [LIMIT] },
	{ file: `${SRC}/routes/admin-stats-routes.ts`, prefix: '/admin', with: [LIMIT] },
	{ file: `${SRC}/custom/role-admin-routes.ts`, prefix: '/admin' },
	{ file: `${OPENAUTH}/session/routes.ts`, prefix: '/session', shadowed: ['GET /session/accounts'] },
	// The same file's second router
	{ file: `${OPENAUTH}/session/routes.ts`, prefix: '/admin/sessions' },
	{ file: `${SRC}/themes/routes.ts`, prefix: '/admin/themes', with: [`${SRC}/themes/service.ts`, ...DELETE] },
	{ file: `${SRC}/routes/admin-session-routes.ts`, prefix: '/admin', with: [LIMIT] },
	// Deletes are Auth's soft deletes (deletions/), registered ahead of these
	{ file: `${OPENAUTH}/client/api.ts`, prefix: '/admin', shadowed: ['DELETE /admin/clients/{clientId}'] },
	// A user's roles are custom/user-role-routes.ts
	{
		file: `${OPENAUTH}/rbac/admin-endpoints.ts`,
		prefix: '/admin',
		shadowed: ['DELETE /admin/roles/{roleId}', 'GET /admin/users/{userId}/roles', 'POST /admin/users/{userId}/roles', 'DELETE /admin/users/{userId}/roles/{roleId}'],
	},
	{ file: `${OPENAUTH}/user/api.ts`, prefix: '/admin/users', shadowed: ['DELETE /admin/users/{id}', 'DELETE /admin/users/{id}/sessions', 'GET /admin/users'] },
	{ file: `${OPENAUTH}/tenant/api.ts`, prefix: '/tenants' },
	{ file: `${OPENAUTH}/device.ts`, prefix: '' },
	{ file: `${OPENAUTH}/native-passkey.ts`, prefix: '' },
];

// ---------------- Hand-written routers: the function each operation runs

const A = `${SRC}/admin-enterprise-routes.ts`;
const T = `${SRC}/admin-tenant-routes.ts`;
const Q = `${SRC}/admin-dlq-routes.ts`;
const K = `${SRC}/passkeys/routes.ts`;
const ACC = `${SRC}/routes/account-routes.ts`;
const RECEIPT = `${SRC}/routes/deletion-receipt.ts`;
const INV = `${SRC}/invites/routes.ts`;
const HAND: Record<string, { file: string; fn: string; with?: string[] }> = {
	'GET /admin/audit': { file: A, fn: 'getTokenAudit' },
	'GET /admin/audit-logs': { file: A, fn: 'getAuditLogs' },
	'GET /admin/audit-logs/stats': { file: A, fn: 'getAuditStats' },
	'GET /admin/audit-logs/user/{userId}': { file: A, fn: 'getUserAuditTrail' },
	'GET /admin/users/{id}/tokens': { file: A, fn: 'getUserTokens' },
	'DELETE /admin/users/{id}/tokens': { file: A, fn: 'revokeAllUserTokens' },
	'POST /admin/users/tokens/revoke': { file: A, fn: 'revokeUserTokens' },
	'GET /admin/health': { file: A, fn: 'getHealth' },
	'GET /admin/metrics': { file: A, fn: 'getMetrics' },
	'GET /admin/tenants': { file: T, fn: 'listTenants' },
	'POST /admin/tenants': { file: T, fn: 'createTenant' },
	'GET /admin/tenants/{tenantId}': { file: T, fn: 'getTenant' },
	'PUT /admin/tenants/{tenantId}': { file: T, fn: 'updateTenant' },
	'DELETE /admin/tenants/{tenantId}': { file: T, fn: 'deleteTenant' },
	'GET /admin/tenants/{tenantId}/admins': { file: T, fn: 'listTenantAdmins' },
	'POST /admin/tenants/{tenantId}/admins': { file: T, fn: 'addTenantAdmin' },
	'DELETE /admin/tenants/{tenantId}/admins/{userId}': { file: T, fn: 'removeTenantAdmin' },
	'POST /admin/dlq/replay': { file: Q, fn: 'handleDLQReplay' },
	'GET /admin/dlq/list': { file: Q, fn: 'handleDLQList' },
	'GET /admin/dlq/stats': { file: Q, fn: 'handleDLQStats' },
	'POST /admin/dlq/cleanup': { file: Q, fn: 'handleDLQCleanup' },
	'POST /admin/dlq/reset-stale': { file: Q, fn: 'handleDLQResetStale' },
	'DELETE /account': { file: ACC, fn: 'handleDeleteAccount' },
	'POST /account/deletion-receipt': { file: RECEIPT, fn: 'handleDeletionReceipt', with: [ACC] },
	'GET /account/status': { file: RECEIPT, fn: 'handleAccountStatus' },
	'GET /account/export': { file: ACC, fn: 'handleAccountExport' },
	'PUT /account/name': { file: ACC, fn: 'handleSetAccountName' },
	'GET /account/birth-date': { file: `${SRC}/birth-date/routes.ts`, fn: 'handleGetBirthDate', with: [ACC] },
	'PUT /account/birth-date': { file: `${SRC}/birth-date/routes.ts`, fn: 'handlePutBirthDate', with: [ACC] },
	'POST /account/sign-out-all': { file: ACC, fn: 'handleSignOutAll' },
	'POST /native/passkey/register/options': { file: `${SRC}/passkeys/native.ts`, fn: 'handleNativeRegisterOptions' },
	'POST /native/passkey/register/verify': { file: `${SRC}/passkeys/native.ts`, fn: 'handleNativeRegisterVerify' },
	'POST /internal/token-revocations': { file: `${SRC}/revocation/install-routes.ts`, fn: 'routeTokenRevocations', with: [`${SRC}/moderation/client-routes.ts`] },
};
/**
 * One function serves them all: together they must list everything it answers. Which of
 * them answers which is not checked; split a function to have its operations checked apart.
 */
const SHARED: { file: string; fn: string; with?: string[]; keys: string[] }[] = [
	{ file: K, fn: 'handleAccountPasskeys', with: [ACC], keys: ['GET /account/passkeys', 'PATCH /account/passkeys/{id}', 'DELETE /account/passkeys/{id}', 'POST /account/passkeys/{id}/restore'] },
	{
		file: K,
		fn: 'handleAdmin',
		keys: ['GET /admin/settings/staff-passkeys', 'PUT /admin/settings/staff-passkeys', 'GET /admin/users/{id}/passkeys', 'POST /admin/users/{id}/passkeys/setup-link', 'DELETE /admin/users/{id}/passkeys/{passkeyId}'],
	},
	{
		file: INV,
		fn: 'routeInviteProvisioning',
		with: [`${SRC}/invites/service.ts`, `${SRC}/moderation/client-routes.ts`],
		keys: ['POST /provisioning/invites', 'GET /provisioning/invites', ...['resend', 'link', 'revoke', 'restore', 'purge'].map((a) => `POST /provisioning/invites/{id}/${a}`)],
	},
	{ file: `${SRC}/account-events/admin.ts`, fn: 'handleAccountEvents', keys: ['GET /admin/settings/account-events', 'POST /admin/settings/account-events'] },
	{ file: `${SRC}/signing-keys/routes.ts`, fn: 'handleSigningKeys', keys: ['GET /admin/settings/signing-keys', 'POST /admin/settings/signing-keys'] },
	{
		file: `${SRC}/moderation/client-routes.ts`,
		fn: 'routeModerationClient',
		keys: ['POST /moderation/requests', 'GET /moderation/requests', 'GET /moderation/requests/{id}', 'POST /moderation/requests/{id}/info'],
	},
];

/** Found by name but not reachable for that operation, and why. */
const UNREACHED: Record<string, number[]> = {
	// D1's db.prepare() reads as the kinds' own prepare()
	'GET /admin/deletions': [404, 409],
	// For a path with no id, which is another path
	'DELETE /session/accounts/{userId}': [400],
	// One helper registers the decisions; only these two queue an action
	...Object.fromEntries(['reject', 'request-info', 'mark-actioned'].map((d) => [`POST /admin/moderation-requests/{id}/${d}`, [202]])),
	// One error helper serves every client route: these can't happen to a create or a rotate
	'POST /admin/clients': [404],
	'POST /admin/clients/{clientId}/rotate': [400, 409],
	// And one every tenant route
	'POST /tenants': [404],
	'GET /tenants': [404, 409],
	'GET /tenants/{id}': [409],
	'DELETE /tenants/{id}': [409],
	'PUT /tenants/{id}/branding': [409],
	'PUT /tenants/{id}/settings': [409],
};

const responsesOf = (key: string): number[] | undefined => {
	const [method, path] = key.split(' ') as [string, string];
	const shape = (p: string) => p.replace(/\{[^}]+\}/g, '{}');
	const found = Object.entries(spec.paths).find(([p, item]) => shape(p) === shape(path) && method.toLowerCase() in item);
	return found && Object.keys(found[1][method.toLowerCase()]!.responses).map(Number);
};
/** 405 is for a method the spec doesn't list at all. */
const missing = (found: Set<number>, listed: number[], key: string) => [...found].filter((s) => s !== 405 && !listed.includes(s) && !(UNREACHED[key] ?? []).includes(s)).sort();

/** Answered from several places, or by a handler with no statuses of its own to follow; read by hand. */
const BY_HAND: Record<string, string> = {
	'GET /session/accounts': 'the issuer answers, index.ts turns its 401 into an empty list',
	'GET /themes': 'always 200',
	'GET /themes/resolve': 'always 200',
	'GET /themes/assets/{}': 'themes/routes.ts handleThemeAsset: 200 or 404',
	'DELETE /admin/users/{}': 'soft delete, registered in index.ts',
	'DELETE /admin/roles/{}': 'soft delete, registered in index.ts',
	'DELETE /admin/clients/{}': 'soft delete, registered in index.ts',
};
const checked = new Set<string>();

describe('openapi.json lists every status the handlers answer', () => {
	it('Hono routes', () => {
		const gaps: Record<string, number[]> = {};
		for (const { file, prefix, with: companions = [], shadowed = [] } of HONO) {
			expect(existsSync(join(ROOT, file)), file).toBe(true);
			const visit = (node: ts.Node): void => {
				if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['get', 'post', 'put', 'patch', 'delete'].includes(node.expression.name.text)) {
					const path = node.arguments[0];
					// A template here is moderation's decisionRoute, read below
					if (path && ts.isTemplateExpression(path) && path.head.text.startsWith('/') && node.arguments.length > 1) expect(`${file}: ${path.getText()}`).toBe(`${SRC}/moderation/admin-routes.ts: \`/:id/\${path}\``);
					if (path && ts.isStringLiteralLike(path) && path.text.startsWith('/') && node.arguments.length > 1) {
						const full = `${prefix}${path.text === '/' && prefix ? '' : path.text}`.replace(/:(\w+)/g, '{$1}');
						const key = `${node.expression.name.text.toUpperCase()} ${full}`;
						const listed = responsesOf(key);
						if (listed && !shadowed.includes(key)) {
							checked.add(key);
							const gap = missing(statusesFrom(node, [file, ...companions]), listed, key);
							if (gap.length) gaps[key] = gap;
						}
					}
				}
				// moderation/admin-routes.ts registers the decisions through one helper
				if (ts.isCallExpression(node) && node.expression.getText() === 'decisionRoute') {
					const key = `POST ${prefix}/{id}/${(node.arguments[0] as ts.StringLiteral).text}`;
					checked.add(key);
					const gap = missing(statusesFrom(functionsOf(file).get('decisionRoute')![0]!, [file, ...companions]), responsesOf(key) ?? [], key);
					if (gap.length) gaps[key] = gap;
				}
				ts.forEachChild(node, visit);
			};
			visit(source(file));
		}
		expect(gaps).toEqual({});
	});

	it('hand-written handlers', () => {
		const gaps: Record<string, number[]> = {};
		for (const [key, { file, fn, with: companions = [] }] of Object.entries(HAND)) {
			checked.add(key);
			const root = functionsOf(file).get(fn)?.[0];
			expect(root, `${fn} in ${file}`).toBeDefined();
			const listed = responsesOf(key);
			expect(listed, key).toBeDefined();
			const gap = missing(statusesFrom(root!, [file, ...companions]), listed!, key);
			if (gap.length) gaps[key] = gap;
		}
		expect(gaps).toEqual({});
	});

	it('handlers several operations share', () => {
		const gaps: Record<string, number[]> = {};
		for (const { file, fn, with: companions = [], keys } of SHARED) {
			const root = functionsOf(file).get(fn)?.[0];
			expect(root, `${fn} in ${file}`).toBeDefined();
			const listed = keys.flatMap((key) => {
				checked.add(key);
				const of = responsesOf(key);
				expect(of, key).toBeDefined();
				return of!;
			});
			const gap = missing(statusesFrom(root!, [file, ...companions]), listed, fn);
			if (gap.length) gaps[fn] = gap;
		}
		expect(gaps).toEqual({});
	});

	// Last: it reads what the checks above covered
	it('no app or staff operation is skipped', () => {
		const shape = (key: string) => key.replace(/\{[^}]+\}/g, '{}');
		const covered = new Set([...checked].map(shape));
		const skipped = Object.entries(spec.paths)
			.flatMap(([path, item]) => Object.entries(item).map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, audience: op['x-audience'] })))
			.filter(({ audience }) => audience === 'app' || audience === 'admin')
			.map(({ key }) => shape(key))
			.filter((key) => !covered.has(key));
		expect(skipped.sort()).toEqual(Object.keys(BY_HAND).sort());
	});
});
