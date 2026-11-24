/**
 * Does openapi.json still promise what the last release promised? (docs/API_VERSIONING.md)
 *
 *   pnpm check:api            # against the newest vYYYY.MM.DD[.N] release record
 *   pnpm check:api <git ref>
 *
 * Fails when something a client uses was removed or narrowed, unless the last release already had it
 * marked `deprecated: true` with an `x-sunset` date that has passed, or docs/api-exceptions.json
 * names the exact change (a security fix, or a correction of a spec that was wrong).
 * Also fails when a new deprecation gives less notice than its audience is owed.
 * It reads two JSON files: the server and the network are not involved.
 */
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { recordTags } from './record.ts';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const DAY = 24 * 60 * 60 * 1000;

/** Minimum notice in days. Pages are the server's own, rendered with it: no client reads them. */
export const NOTICE: Record<string, number> = { public: 182, app: 30, admin: 0 };

export interface Change {
	/** Stable text: docs/api-exceptions.json repeats it exactly */
	id: string;
	audience: string;
}

/** Parameter names in a path don't matter to a caller. */
const shape = (path: string) => path.replace(/\{[^}]+\}/g, '{}');

function deref(spec: Json, node: unknown): Json {
	let at = obj(node);
	for (let i = 0; typeof at.$ref === 'string' && i < 20; i++) {
		at = obj(
			at.$ref
				.slice(2)
				.split('/')
				.reduce<unknown>((n, key) => obj(n)[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec)
		);
	}
	return at;
}

/** Deprecated in the last release, and its time is up. */
const expired = (node: Json, now: number) => node.deprecated === true && typeof node['x-sunset'] === 'string' && Date.parse(node['x-sunset']) <= now;

const types = (s: Json): string[] => (typeof s.type === 'string' ? [s.type] : arr(s.type).map(String));
const values = (s: Json): unknown[] | null => ('const' in s ? [s.const] : Array.isArray(s.enum) ? s.enum : null);
const show = (v: unknown) => JSON.stringify(v);

/** Schema words compared one by one below. */
const COMPARED = new Set(['$ref', 'type', 'enum', 'const', 'format', 'pattern', 'additionalProperties', 'properties', 'required', 'items', 'oneOf', 'anyOf', 'allOf', 'discriminator', 'uniqueItems', 'multipleOf', 'maxLength', 'maximum', 'exclusiveMaximum', 'maxItems', 'maxProperties', 'minLength', 'minimum', 'exclusiveMinimum', 'minItems', 'minProperties']);
/** Words that promise nothing. Any other word must stay as it was: what is not understood never passes unseen. */
const NOTES = new Set(['title', 'description', 'default', 'example', 'examples', 'deprecated', 'externalDocs', '$comment']);
const STRICTER = { maxLength: -1, maximum: -1, exclusiveMaximum: -1, maxItems: -1, maxProperties: -1, minLength: 1, minimum: 1, exclusiveMinimum: 1, minItems: 1, minProperties: 1 } as const;

class Comparison {
	readonly changes: string[] = [];
	private readonly seen = new Set<string>();
	private readonly before: Json;
	private readonly after: Json;
	private readonly now: number;

	constructor(before: Json, after: Json, now: number) {
		this.before = before;
		this.after = after;
		this.now = now;
	}

	add(where: string, what: string): void {
		this.changes.push(`${where}: ${what}`);
	}

	/** `sent` by the client (the server may not become stricter) or received (it may not give less). */
	schema(a: unknown, b: unknown, where: string, sent: boolean): void {
		const key = `${sent}|${show(obj(a).$ref ?? a)}|${show(obj(b).$ref ?? b)}`;
		if (obj(a).$ref && obj(b).$ref && this.seen.has(`${where.split(' ').slice(0, 2).join(' ')}|${key}`)) return;
		this.seen.add(`${where.split(' ').slice(0, 2).join(' ')}|${key}`);
		const old = deref(this.before, a);
		const cur = deref(this.after, b);

		const [was, is] = [types(old), types(cur)];
		if (was.length || is.length) {
			const any = (t: string[]) => t.length === 0;
			const covers = (wide: string[], t: string) => any(wide) || wide.includes(t) || (t === 'integer' && wide.includes('number'));
			const lost = sent ? was.filter((t) => !covers(is, t)) : is.filter((t) => !covers(was, t));
			if (lost.length || (sent && any(was) && !any(is)) || (!sent && any(is) && !any(was))) this.add(where, `type ${was.join('|') || 'any'} became ${is.join('|') || 'any'}`);
		}

		const [wasValues, isValues] = [values(old), values(cur)];
		if (sent) {
			if (isValues && !wasValues) this.add(where, `only ${show(isValues)} accepted now`);
			else if (isValues && wasValues) for (const v of wasValues) if (!isValues.some((w) => show(w) === show(v))) this.add(where, `value ${show(v)} no longer accepted`);
			for (const [limit, stricter] of Object.entries(STRICTER)) {
				const [x, y] = [old[limit], cur[limit]];
				if (typeof y === 'number' && (typeof x !== 'number' ? !(limit.startsWith('min') && limit !== 'minimum' && y === 0) : (y - x) * stricter > 0)) this.add(where, `${limit} ${x ?? 'none'} became ${y}`);
			}
			if (cur.multipleOf !== undefined && cur.multipleOf !== old.multipleOf) this.add(where, `multipleOf ${old.multipleOf ?? 'none'} became ${cur.multipleOf}`);
			if (cur.uniqueItems === true && old.uniqueItems !== true) this.add(where, 'items must be unique now');
			if (cur.pattern !== undefined && cur.pattern !== old.pattern) this.add(where, `pattern ${show(old.pattern ?? 'none')} became ${show(cur.pattern)}`);
			if (cur.additionalProperties === false && old.additionalProperties !== false) this.add(where, 'unknown fields are refused now');
		}
		if (old.format !== cur.format && (sent ? cur.format !== undefined : old.format !== undefined)) this.add(where, `format ${old.format ?? 'none'} became ${cur.format ?? 'none'}`);

		const [oldPick, curPick] = [obj(old.discriminator), obj(cur.discriminator)];
		if (oldPick.propertyName !== undefined && oldPick.propertyName !== curPick.propertyName) this.add(where, `discriminator ${show(oldPick.propertyName)} became ${show(curPick.propertyName ?? 'none')}`);
		for (const [value, target] of Object.entries(obj(oldPick.mapping))) if (show(obj(curPick.mapping)[value]) !== show(target)) this.add(where, `discriminator value ${show(value)} changed`);
		for (const word of new Set([...Object.keys(old), ...Object.keys(cur)])) {
			if (COMPARED.has(word) || NOTES.has(word) || word.startsWith('x-')) continue;
			if (show(old[word]) !== show(cur[word])) this.add(where, `${word} ${show(old[word] ?? 'none')} became ${show(cur[word] ?? 'none')}`);
		}

		const [oldProps, curProps] = [obj(old.properties), obj(cur.properties)];
		const [oldReq, curReq] = [new Set(arr(old.required).map(String)), new Set(arr(cur.required).map(String))];
		for (const [name, prop] of Object.entries(oldProps)) {
			if (!(name in curProps)) {
				if (!expired(obj(prop), this.now) && !expired(deref(this.before, prop), this.now)) this.add(where, `field "${name}" removed`);
				continue;
			}
			this.schema(prop, curProps[name], `${where} ${name}`, sent);
			if (!sent && oldReq.has(name) && !curReq.has(name)) this.add(where, `field "${name}" is no longer always there`);
		}
		if (sent) for (const name of curReq) if (!oldReq.has(name)) this.add(where, `field "${name}" is required now`);

		if (old.items !== undefined || cur.items !== undefined) this.schema(old.items ?? {}, cur.items ?? {}, `${where} []`, sent);
		for (const word of ['oneOf', 'anyOf', 'allOf']) {
			const [x, y] = [arr(old[word]), arr(cur[word])];
			if (!x.length && !y.length) continue;
			const name = (v: unknown, i: number) => String(obj(v).$ref ?? obj(v).title ?? i);
			const next = new Map(y.map((v, i) => [name(v, i), v]));
			x.forEach((v, i) => {
				const n = name(v, i);
				const match = next.get(n);
				const label = n.split('/').pop()!;
				if (match === undefined) {
					if (sent !== (word === 'allOf')) this.add(where, `${word} ${label} removed`);
				} else this.schema(v, match, `${where} ${word} ${label}`, sent);
			});
			if (!sent && word !== 'allOf' && !y.length) this.add(where, `${word} is gone: anything may be answered`);
			const names = new Set(x.map(name));
			y.forEach((v, i) => {
				if (names.has(name(v, i))) return;
				// allOf adds a condition to what is sent; a choice that did not exist narrows what was free
				// and a client may meet an answer it has never seen
				if (sent ? word === 'allOf' || x.length === 0 : word !== 'allOf' && x.length > 0) this.add(where, `${word} ${name(v, i).split('/').pop()} added`);
			});
		}
	}

	content(a: Json, b: Json, where: string, sent: boolean): void {
		for (const [type, media] of Object.entries(obj(a.content))) {
			const other = obj(b.content)[type];
			if (other === undefined) this.add(where, `${type} removed`);
			else this.schema(obj(media).schema ?? {}, obj(other).schema ?? {}, where, sent);
		}
	}

	operation(where: string, a: Json, b: Json, pathA: Json, pathB: Json): void {
		const params = (spec: Json, item: Json, op: Json) => {
			const list = [...arr(item.parameters), ...arr(op.parameters)].map((p) => deref(spec, p));
			let inPath = 0;
			return new Map(list.map((p) => [p.in === 'path' ? `path ${inPath++}` : `${p.in} ${p.in === 'header' ? String(p.name).toLowerCase() : p.name}`, p]));
		};
		const [was, is] = [params(this.before, pathA, a), params(this.after, pathB, b)];
		for (const [name, p] of was) {
			const q = is.get(name);
			if (!q) {
				if (!expired(p, this.now)) this.add(where, `${name} parameter removed`);
				continue;
			}
			if (q.required === true && p.required !== true) this.add(where, `${name} parameter is required now`);
			this.schema(p.schema ?? {}, q.schema ?? {}, `${where} ${name}`, true);
		}
		for (const [name, q] of is) if (!was.has(name) && q.required === true) this.add(where, `new required ${name} parameter`);

		const [bodyA, bodyB] = [deref(this.before, a.requestBody), deref(this.after, b.requestBody)];
		if (bodyB.required === true && bodyA.required !== true) this.add(where, 'a body is required now');
		if (a.requestBody !== undefined) this.content(bodyA, bodyB, `${where} body`, true);

		for (const [status, res] of Object.entries(obj(a.responses))) {
			const other = obj(b.responses)[status];
			if (other === undefined) {
				this.add(where, `answer ${status} removed`);
				continue;
			}
			const [x, y] = [deref(this.before, res), deref(this.after, other)];
			this.content(x, y, `${where} ${status}`, false);
			for (const [h, header] of Object.entries(obj(x.headers))) {
				const same = Object.entries(obj(y.headers)).find(([k]) => k.toLowerCase() === h.toLowerCase());
				if (!same) this.add(`${where} ${status}`, `header ${h} removed`);
				else this.schema(deref(this.before, header).schema ?? {}, deref(this.after, same[1]).schema ?? {}, `${where} ${status} header ${h}`, false);
			}
		}

		// Alternatives: each way that worked must still work. None, or an empty one, is "anyone"
		const ways = (spec: Json, op: Json) => {
			const list = arr(op.security ?? spec.security).map(obj);
			return list.length ? list : [{}];
		};
		const now = ways(this.after, b);
		for (const way of ways(this.before, a)) {
			const still = now.some((w) => Object.entries(w).every(([name, scopes]) => name in way && arr(scopes).every((s) => arr(way[name]).includes(s))));
			if (!still) this.add(where, `access ${show(way)} no longer enough (now ${show(now)})`);
		}
	}
}

interface Op {
	where: string;
	op: Json;
	item: Json;
	audience: string;
}

function operations(spec: Json): Map<string, Op> {
	const out = new Map<string, Op>();
	for (const [path, item] of Object.entries(obj(spec.paths))) {
		for (const method of METHODS) {
			const op = obj(item)[method];
			if (op === undefined) continue;
			out.set(`${method} ${shape(path)}`, { where: `${method.toUpperCase()} ${path}`, op: obj(op), item: obj(item), audience: String(obj(op)['x-audience'] ?? 'public') });
		}
	}
	return out;
}

/** What `after` takes away from what `before` promised, pages left out. The audience is the promised one. */
export function breakingChanges(before: Json, after: Json, now = Date.now()): Change[] {
	const out: Change[] = [];
	// How a client proves itself: another kind or place for the credential breaks whoever sends it
	const schemes = (s: Json) => obj(obj(s.components).securitySchemes);
	const plain = (s: unknown) => show(Object.entries(obj(s)).filter(([k]) => k !== 'description' && !k.startsWith('x-')).sort(([x], [y]) => (x < y ? -1 : 1)));
	for (const [name, scheme] of Object.entries(schemes(before))) {
		const other = schemes(after)[name];
		if (other === undefined || plain(scheme) === plain(other)) continue; // a removed one shows where it was used
		out.push({ id: `security scheme ${name}: ${plain(scheme)} became ${plain(other)}`, audience: 'public' });
	}
	const next = operations(after);
	for (const [key, a] of operations(before)) {
		if (a.audience === 'page') continue;
		const b = next.get(key);
		if (!b) {
			if (!expired(a.op, now)) out.push({ id: `${a.where}: removed`, audience: a.audience });
			continue;
		}
		const c = new Comparison(before, after, now);
		c.operation(a.where, a.op, b.op, a.item, b.item);
		for (const id of new Set(c.changes)) out.push({ id, audience: a.audience });
	}
	return out;
}

interface Deprecation {
	where: string;
	audience: string;
	sunset: string | undefined;
}

/** Everything marked deprecated: operations, parameters, and fields and headers at any depth. Pages left out. */
function deprecations(spec: Json): Map<string, Deprecation> {
	const out = new Map<string, Deprecation>();
	for (const [key, { where, op, item, audience }] of operations(spec)) {
		if (audience === 'page') continue;
		const note = (node: Json, path: string) => {
			if (node.deprecated === true) out.set(`${key}${path}`, { where: `${where}${path}`, audience, sunset: typeof node['x-sunset'] === 'string' ? node['x-sunset'] : undefined });
		};
		const walk = (raw: unknown, path: string, refs: string[]): void => {
			// The marker may sit beside a $ref as well as on what it points to
			const ref = obj(raw).$ref;
			note(obj(raw), path);
			if (typeof ref === 'string' && refs.includes(ref)) return;
			const inside = typeof ref === 'string' ? [...refs, ref] : refs;
			const node = deref(spec, raw);
			note(node, path);
			for (const [name, prop] of Object.entries(obj(node.properties))) walk(prop, `${path} ${name}`, inside);
			if (node.items !== undefined) walk(node.items, `${path} []`, inside);
			for (const word of ['oneOf', 'anyOf', 'allOf']) arr(node[word]).forEach((v, i) => walk(v, `${path} ${word} ${String(obj(v).$ref ?? i).split('/').pop()}`, inside));
		};
		const media = (node: Json, path: string) => {
			for (const m of Object.values(obj(node.content))) walk(obj(m).schema ?? {}, path, []);
		};
		note(op, '');
		for (const raw of [...arr(item.parameters), ...arr(op.parameters)]) {
			const p = deref(spec, raw);
			note(p, ` ${p.in} ${p.name}`);
			walk(p.schema ?? {}, ` ${p.in} ${p.name}`, []);
		}
		media(deref(spec, op.requestBody), ' body');
		for (const [status, raw] of Object.entries(obj(op.responses))) {
			const res = deref(spec, raw);
			media(res, ` ${status}`);
			for (const [h, header] of Object.entries(obj(res.headers))) note(deref(spec, header), ` ${status} header ${h}`);
		}
	}
	return out;
}

/** New deprecations that give less notice than their audience is owed, or no date at all. */
export function shortNotice(before: Json, after: Json, now = Date.now()): string[] {
	const out: string[] = [];
	const earlier = deprecations(before);
	const promised = operations(before);
	for (const [key, d] of deprecations(after)) {
		const sunset = d.sunset === undefined ? NaN : Date.parse(d.sunset);
		if (Number.isNaN(sunset)) {
			out.push(`${d.where}: deprecated without an x-sunset date`);
			continue;
		}
		// A date already announced may move later, not earlier
		const was = earlier.get(key);
		if (was?.sunset !== undefined) {
			if (sunset < Date.parse(was.sunset)) out.push(`${d.where}: x-sunset moved earlier (${was.sunset} to ${d.sunset})`);
			continue;
		}
		const operation = [...promised].find(([k]) => key === k || key.startsWith(`${k} `));
		const audience = operation?.[1].audience ?? d.audience;
		const days = NOTICE[audience] ?? 0;
		if (sunset < now + days * DAY) out.push(`${d.where}: x-sunset ${d.sunset} is less than ${days} days away (${audience})`);
	}
	return out;
}

export interface Exception {
	/** The change, exactly as the check prints it */
	change: string;
	/** security: a hole closed at once. correction: the spec was wrong, the server did not change */
	kind: 'security' | 'correction';
	reason: string;
}

export function exceptionErrors(list: Exception[]): string[] {
	return list.flatMap((e, i) => {
		const bad: string[] = [];
		if (!e.change) bad.push(`exception ${i}: no change`);
		if (e.kind !== 'security' && e.kind !== 'correction') bad.push(`exception ${i}: kind must be "security" or "correction"`);
		if (!e.reason || e.reason.trim().length < 20) bad.push(`exception ${i}: say why (20 characters or more)`);
		return bad;
	});
}

function main(argv: string[]): void {
	const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
	const has = (ref: string) => {
		try {
			git('cat-file', '-e', `${ref}:openapi.json`);
			return true;
		} catch {
			return false;
		}
	};
	const reachable = (ref: string) => {
		try {
			git('merge-base', '--is-ancestor', ref, 'HEAD');
			return true;
		} catch {
			return false;
		}
	};
	const ref = argv[0] ?? recordTags(git('tag', '-l', 'v*').split('\n')).find((t) => reachable(t) && has(t));
	if (!ref) {
		// Never pass by not looking: CI checks out every tag
		process.stderr.write('No release record with an openapi.json in this history. Fetch the tags: git fetch --tags\n');
		process.exit(1);
	}
	const before = JSON.parse(git('show', `${ref}:openapi.json`)) as Json;
	const after = JSON.parse(readFileSync(join(root, 'openapi.json'), 'utf8')) as Json;
	const exceptions = JSON.parse(readFileSync(join(root, 'docs/api-exceptions.json'), 'utf8')) as Exception[];

	const errors = exceptionErrors(exceptions);
	for (const c of breakingChanges(before, after)) {
		const e = exceptions.find((x) => x.change === c.id);
		if (e) process.stdout.write(`allowed (${e.kind}): ${c.id}\n  ${e.reason}\n`);
		else errors.push(`[${c.audience}] ${c.id}`);
	}
	errors.push(...shortNotice(before, after));
	if (errors.length) {
		process.stderr.write(`openapi.json takes away what ${ref} promised (docs/API_VERSIONING.md):\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
		process.exit(1);
	}
	process.stdout.write(`openapi.json keeps every promise of ${ref}.\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main(process.argv.slice(2));
