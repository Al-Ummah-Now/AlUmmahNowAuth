import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { breakingChanges, exceptionErrors, shortNotice, type Exception } from '../api-compat.ts';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const NOW = Date.parse('2026-12-01T00:00:00Z');
const clone = (v: Any): Any => JSON.parse(JSON.stringify(v));

const spec = (): Any => ({
	openapi: '3.1.0',
	paths: {
		'/token': {
			post: {
				'x-audience': 'public',
				security: [],
				parameters: [{ name: 'lang', in: 'query', schema: { type: 'string', enum: ['en', 'ar'] } }],
				requestBody: {
					required: true,
					content: { 'application/x-www-form-urlencoded': { schema: { oneOf: [{ $ref: '#/components/schemas/Code' }, { $ref: '#/components/schemas/Refresh' }], discriminator: { propertyName: 'grant', mapping: { code: '#/components/schemas/Code', refresh: '#/components/schemas/Refresh' } } } } },
				},
				responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Tokens' } } } }, '429': { $ref: '#/components/responses/Slow' } },
			},
		},
		'/users/{id}': { get: { 'x-audience': 'admin', security: [{ admin: ['users:read'] }, { basic: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': {} } } },
		'/sign-in': { get: { 'x-audience': 'page', responses: { '200': {} } } },
	},
	components: {
		schemas: {
			Code: { type: 'object', required: ['code'], properties: { code: { type: 'string', maxLength: 100 }, note: { type: 'string' } } },
			Refresh: { type: 'object', properties: { refresh_token: { type: 'string' } } },
			Tokens: { type: 'object', required: ['access_token'], properties: { access_token: { type: 'string' }, kind: { type: 'string', enum: ['a', 'b'] }, next: { $ref: '#/components/schemas/Tokens' } } },
		},
		responses: { Slow: { headers: { 'Retry-After': { schema: { type: 'integer' } } } } },
		securitySchemes: { admin: { type: 'http', scheme: 'bearer', description: 'x' } },
	},
});
const after = (edit: (s: Any) => void): string[] => {
	const next = clone(spec());
	edit(next);
	return breakingChanges(spec(), next, NOW).map((c) => c.id);
};
const token = (s: Any) => s.paths['/token'].post;
const schemas = (s: Any) => s.components.schemas;

describe('what breaks a client', () => {
	const cases: [string, (s: Any) => void, string][] = [
		['a removed route', (s) => delete s.paths['/token'], 'POST /token: removed'],
		['a removed method', (s) => delete s.paths['/users/{id}'].get, 'GET /users/{id}: removed'],
		['a removed parameter', (s) => (token(s).parameters = []), 'POST /token: query lang parameter removed'],
		['a parameter that became required', (s) => (token(s).parameters[0].required = true), 'POST /token: query lang parameter is required now'],
		['a new required parameter', (s) => token(s).parameters.push({ name: 'x', in: 'header', required: true }), 'POST /token: new required header x parameter'],
		['a value no longer accepted', (s) => (token(s).parameters[0].schema.enum = ['en']), 'POST /token query lang: value "ar" no longer accepted'],
		['a free value limited to a list', (s) => (schemas(s).Code.properties.note.enum = ['x']), 'POST /token body oneOf Code note: only ["x"] accepted now'],
		['a field required now', (s) => (schemas(s).Code.required = ['code', 'note']), 'POST /token body oneOf Code: field "note" is required now'],
		['a field no longer taken', (s) => delete schemas(s).Code.properties.note, 'POST /token body oneOf Code: field "note" removed'],
		['another type', (s) => (schemas(s).Code.properties.note.type = 'integer'), 'POST /token body oneOf Code note: type string became integer'],
		['a shorter limit', (s) => (schemas(s).Code.properties.code.maxLength = 50), 'POST /token body oneOf Code code: maxLength 100 became 50'],
		['a new pattern', (s) => (schemas(s).Code.properties.note.pattern = '^a$'), 'POST /token body oneOf Code note: pattern "none" became "^a$"'],
		['a removed grant', (s) => (token(s).requestBody.content['application/x-www-form-urlencoded'].schema.oneOf.pop(), undefined), 'POST /token body: oneOf Refresh removed'],
		['another body format', (s) => (token(s).requestBody.content = { 'application/json': {} }), 'POST /token body: application/x-www-form-urlencoded removed'],
		['unknown fields refused', (s) => (schemas(s).Code.additionalProperties = false), 'POST /token body oneOf Code: unknown fields are refused now'],
		['an answer field removed', (s) => delete schemas(s).Tokens.properties.access_token, 'POST /token 200: field "access_token" removed'],
		['an answer field not always there', (s) => (schemas(s).Tokens.required = []), 'POST /token 200: field "access_token" is no longer always there'],
		['an answer field of another type', (s) => (schemas(s).Tokens.properties.access_token.type = ['string', 'null']), 'POST /token 200 access_token: type string became string|null'],
		['an answer removed', (s) => delete token(s).responses['429'], 'POST /token: answer 429 removed'],
		['a header removed', (s) => (s.components.responses.Slow.headers = {}), 'POST /token 429: header Retry-After removed'],
		['a new kind of answer', (s) => (schemas(s).Tokens.properties.kind = { oneOf: [{ type: 'string', title: 'A' }] }, undefined), 'POST /token 200 kind: type string became any'],
		['a header of another type', (s) => (s.components.responses.Slow.headers['Retry-After'] = { schema: { type: 'string' } }), 'POST /token 429 header Retry-After: type integer became string'],
		['a minimum number of fields', (s) => (schemas(s).Code.minProperties = 2), 'POST /token body oneOf Code: minProperties none became 2'],
		['an exclusive limit', (s) => (schemas(s).Code.properties.note.exclusiveMaximum = 5), 'POST /token body oneOf Code note: exclusiveMaximum none became 5'],
		['a step', (s) => (schemas(s).Code.properties.note.multipleOf = 2), 'POST /token body oneOf Code note: multipleOf none became 2'],
		['unique items', (s) => (schemas(s).Code.properties.note.uniqueItems = true), 'POST /token body oneOf Code note: items must be unique now'],
		['a discriminator value lost', (s) => delete token(s).requestBody.content['application/x-www-form-urlencoded'].schema.discriminator.mapping.code, 'POST /token body: discriminator value "code" changed'],
		['another discriminator', (s) => (token(s).requestBody.content['application/x-www-form-urlencoded'].schema.discriminator.propertyName = 'kind'), 'POST /token body: discriminator "grant" became "kind"'],
		['a word the check does not know', (s) => (schemas(s).Code.propertyNames = { pattern: '^a' }), 'POST /token body oneOf Code: propertyNames "none" became {"pattern":"^a"}'],
		['another kind of credential', (s) => (s.components.securitySchemes.admin.scheme = 'basic'), 'security scheme admin: [["scheme","bearer"],["type","http"]] became [["scheme","basic"],["type","http"]]'],
		['sign-in required', (s) => (token(s).security = [{ admin: [] }]), 'POST /token: access {} no longer enough (now [{"admin":[]}])'],
		['a wider right needed', (s) => (s.paths['/users/{id}'].get.security = [{ admin: ['users:write'] }, { basic: [] }]), 'GET /users/{id}: access {"admin":["users:read"]} no longer enough (now [{"admin":["users:write"]},{"basic":[]}])'],
		['one way in removed', (s) => (s.paths['/users/{id}'].get.security = [{ admin: ['users:read'] }]), 'GET /users/{id}: access {"basic":[]} no longer enough (now [{"admin":["users:read"]}])'],
	];
	it.each(cases)('%s', (_name, edit, id) => {
		expect(after(edit)).toEqual([id]);
	});

	it('an answer that may take a shape no client has seen, or any shape at all', () => {
		const union = (list: string[]) => {
			const s = spec();
			s.components.schemas.Tokens.properties.kind = list.length ? { oneOf: list.map((title) => ({ title, type: 'object' })) } : {};
			return s;
		};
		const ids = (a: string[], b: string[]) => breakingChanges(union(a), union(b), NOW).map((c) => c.id);
		expect(ids(['A', 'B'], ['A', 'B', 'C'])).toEqual(['POST /token 200 kind: oneOf C added']);
		expect(ids(['A', 'B'], [])).toEqual(['POST /token 200 kind: oneOf is gone: anything may be answered']);
		expect(ids(['A', 'B'], ['A'])).toEqual([]);
	});

	it('keeps the promised audience: calling a public route a page hides nothing', () => {
		const changes = after((s) => {
			token(s)['x-audience'] = 'page';
			token(s).parameters = [];
		});
		expect(changes).toEqual(['POST /token: query lang parameter removed']);
	});
});

describe('what does not', () => {
	it.each([
		['nothing', () => {}],
		['a new route, field, optional parameter, answer or value', (s: Any) => {
			s.paths['/new'] = { get: { 'x-audience': 'public', responses: {} } };
			schemas(s).Tokens.properties.more = { type: 'string' };
			schemas(s).Code.properties.more = { type: 'string' };
			schemas(s).Tokens.properties.kind.enum.push('c');
			token(s).parameters[0].schema.enum.push('fr');
			token(s).parameters.push({ name: 'x', in: 'query' });
			token(s).responses['503'] = {};
		}],
		['less strict input', (s: Any) => {
			schemas(s).Code.required = [];
			schemas(s).Code.properties.code.maxLength = 200;
			schemas(s).Refresh.properties.refresh_token.type = ['string', 'null'];
			delete token(s).parameters[0].schema.enum;
			s.paths['/users/{id}'].get.security.push({});
		}],
		['a renamed path parameter', (s: Any) => {
			s.paths['/users/{userId}'] = s.paths['/users/{id}'];
			delete s.paths['/users/{id}'];
			s.paths['/users/{userId}'].get.parameters[0].name = 'userId';
		}],
		['words and Arabic', (s: Any) => {
			token(s).description = 'x';
			schemas(s).Code.title = 'y';
			schemas(s).Code['x-summary-ar'] = 'ع';
			s.components.securitySchemes.admin.description = 'z';
		}],
		['a page', (s: Any) => delete s.paths['/sign-in']],
		['a discriminator value added', (s: Any) => (token(s).requestBody.content['application/x-www-form-urlencoded'].schema.discriminator.mapping.device = 'x')],
		['the same schema moved out of components', (s: Any) => (token(s).responses['200'].content['application/json'].schema = clone(schemas(s).Tokens))],
	])('%s', (_name, edit) => {
		expect(after(edit as (s: Any) => void)).toEqual([]);
	});
});

describe('deprecation', () => {
	const withSunset = (date: string | undefined, audience = 'public') => {
		const s = spec();
		Object.assign(s.paths['/token'].post, { 'x-audience': audience, deprecated: true, ...(date ? { 'x-sunset': date } : {}) });
		return s;
	};
	const without = () => {
		const s = spec();
		delete s.paths['/token'];
		return s;
	};

	it('a removal is allowed only when the last release had announced it and the date has passed', () => {
		expect(breakingChanges(withSunset('2026-11-30'), without(), NOW)).toEqual([]);
		expect(breakingChanges(withSunset('2026-12-02'), without(), NOW)).toHaveLength(1);
		expect(breakingChanges(withSunset(undefined), without(), NOW)).toHaveLength(1);
		// Marking and removing between two releases was never announced
		expect(breakingChanges(spec(), without(), NOW)).toHaveLength(1);
	});

	it('the same holds for one field', () => {
		const old = spec();
		Object.assign(old.components.schemas.Tokens.properties.kind, { deprecated: true, 'x-sunset': '2026-11-30' });
		const next = spec();
		delete next.components.schemas.Tokens.properties.kind;
		expect(breakingChanges(old, next, NOW)).toEqual([]);
	});

	it('a new deprecation gives the notice its audience is owed', () => {
		expect(shortNotice(spec(), withSunset('2027-06-02'), NOW)).toEqual([]);
		expect(shortNotice(spec(), withSunset('2027-03-01'), NOW)[0]).toContain('less than 182 days');
		expect(shortNotice(spec(), withSunset(undefined), NOW)).toEqual(['POST /token: deprecated without an x-sunset date']);
		// The audience of the last release counts: relabelling does not shorten the notice
		expect(shortNotice(spec(), withSunset('2026-12-02', 'admin'), NOW)[0]).toContain('(public)');
	});

	it.each([
		['a parameter', (s: Any) => token(s).parameters[0], 'POST /token query lang'],
		['a field that is sent', (s: Any) => schemas(s).Code.properties.note, 'POST /token body oneOf Code note'],
		['a field that is answered', (s: Any) => schemas(s).Tokens.properties.kind, 'POST /token 200 kind'],
		['a header', (s: Any) => s.components.responses.Slow.headers['Retry-After'], 'POST /token 429 header Retry-After'],
	])('%s is owed the same: a date, the notice, never earlier', (_name, pick, where) => {
		const marked = (date?: string) => {
			const s = spec();
			Object.assign(pick(s), { deprecated: true, ...(date ? { 'x-sunset': date } : {}) });
			return s;
		};
		expect(shortNotice(spec(), marked(), NOW)).toContain(`${where}: deprecated without an x-sunset date`);
		expect(shortNotice(spec(), marked('2026-11-01'), NOW)).toContain(`${where}: x-sunset 2026-11-01 is less than 182 days away (public)`);
		expect(shortNotice(spec(), marked('2027-06-02'), NOW)).toEqual([]);
		expect(shortNotice(marked('2027-06-02'), marked('2027-05-01'), NOW)).toContain(`${where}: x-sunset moved earlier (2027-06-02 to 2027-05-01)`);
		expect(shortNotice(marked('2027-06-02'), marked('2027-09-01'), NOW)).toEqual([]);
	});

	it('an announced date may move later, never earlier', () => {
		expect(shortNotice(withSunset('2027-06-02'), withSunset('2027-09-01'), NOW)).toEqual([]);
		expect(shortNotice(withSunset('2027-06-02'), withSunset('2027-05-01'), NOW)[0]).toContain('moved earlier');
	});
});

describe('exceptions', () => {
	const good: Exception = { change: 'POST /token: removed', kind: 'security', reason: 'It let anyone read tokens; closed at once.' };
	it('need the change, a kind and a reason', () => {
		expect(exceptionErrors([good])).toEqual([]);
		expect(exceptionErrors([{ ...good, reason: 'fix' }])).toHaveLength(1);
		expect(exceptionErrors([{ ...good, kind: 'whim' as never }])).toHaveLength(1);
		expect(exceptionErrors([{ ...good, change: '' }])).toHaveLength(1);
	});
	it('in this repository are well formed', () => {
		expect(exceptionErrors(JSON.parse(readFileSync(join(ROOT, 'docs/api-exceptions.json'), 'utf8')))).toEqual([]);
	});
});

describe('on the real openapi.json', () => {
	const real = () => JSON.parse(readFileSync(join(ROOT, 'openapi.json'), 'utf8'));

	it('is equal to itself', () => {
		expect(breakingChanges(real(), real(), NOW)).toEqual([]);
	});

	it('notices every operation that goes away, except pages', () => {
		const base = real();
		for (const [path, item] of Object.entries(base.paths as Record<string, Record<string, Any>>)) {
			for (const [method, op] of Object.entries(item)) {
				const next = clone(base);
				delete next.paths[path][method];
				const expected = op['x-audience'] === 'page' ? [] : [`${method.toUpperCase()} ${path}: removed`];
				expect(breakingChanges(base, next, NOW).map((c) => c.id)).toEqual(expected);
			}
		}
	});

	it('notices every answer that goes away', () => {
		const base = real();
		for (const [path, item] of Object.entries(base.paths as Record<string, Record<string, Any>>)) {
			for (const [method, op] of Object.entries(item)) {
				if (op['x-audience'] === 'page') continue;
				for (const status of Object.keys(op.responses ?? {})) {
					const next = clone(base);
					delete next.paths[path][method].responses[status];
					expect(breakingChanges(base, next, NOW).map((c) => c.id)).toContain(`${method.toUpperCase()} ${path}: answer ${status} removed`);
				}
			}
		}
	});
});

describe('the command', () => {
	const run = (ref: string) => {
		try {
			return { code: 0, out: execFileSync('node', ['--experimental-strip-types', '--no-warnings', join(ROOT, 'scripts/release/api-compat.ts'), ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
		} catch (error) {
			const e = error as { status: number; stderr: string };
			return { code: e.status, out: e.stderr };
		}
	};

	it('fails, never passes, when the release it is told to compare with has no spec', () => {
		expect(run('HEAD').code).toBe(0);
		expect(run('0000000').code).not.toBe(0);
	});
});
