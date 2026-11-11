/**
 * Per-request timings for the sign-in chain (#804, AlUmmahNow#804).
 *
 * One RequestTimer per request. `instrumentEnv` wraps this request's D1, KV,
 * queue and rate-limit bindings so every call is timed and attributed
 * (`d1 SELECT users`, `kv get email`, `rl PASSWORD_EMAIL_LIMITER`); named stages
 * (`guard`, `theme`, `issuer`, `onsuccess.roles`, ...) are timed with `stage()`.
 *
 * Output:
 * - a `Server-Timing` header with the stages and per-kind I/O totals
 *   (`d1;dur=…;desc="n=7"`). Table names and keys stay out of the header.
 * - one structured log line, `auth.timing`, with the path (never the query
 *   string, which carries codes and state), status, stages, I/O totals and the
 *   slowest calls with their table or key prefix. No emails, ids or values.
 * - `auth.timing.background`: how long this request's `waitUntil` work took
 *   (audit delivery, analytics), which runs after the response.
 *
 * Workers clocks only advance across I/O, so CPU work (the scrypt password
 * hash) reads as 0 here; it shows in the invocation's CPU time instead.
 */

type Kind = 'd1' | 'kv' | 'rl' | 'queue';

interface Op {
	label: string;
	ms: number;
}

const MAX_SLOW_OPS = 8;
const MAX_STAGES = 40;
const MAX_OP_LABELS = 40;

const now = () => performance.now();
const round = (ms: number) => Math.round(ms * 10) / 10;

export class RequestTimer {
	readonly started = now();
	private readonly stages = new Map<string, { n: number; ms: number }>();
	private readonly io = new Map<Kind, { n: number; ms: number }>();
	private slow: Op[] = [];
	/** Every call by label (`d1 SELECT users`): count and total, in first-call order */
	private readonly ops = new Map<string, { n: number; ms: number }>();
	private readonly background: Promise<unknown>[] = [];

	/** Times `fn` as the named stage (stages may nest; repeats are summed). */
	async stage<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
		const t0 = now();
		try {
			return await fn();
		} finally {
			this.addStage(name, now() - t0);
		}
	}

	addStage(name: string, ms: number): void {
		const s = this.stages.get(name);
		if (s) {
			s.n++;
			s.ms += ms;
		} else if (this.stages.size < MAX_STAGES) {
			this.stages.set(name, { n: 1, ms });
		}
	}

	/** Times one binding call. */
	async op<T>(kind: Kind, label: string, fn: () => Promise<T>): Promise<T> {
		const t0 = now();
		try {
			return await fn();
		} finally {
			this.addOp(kind, label, now() - t0);
		}
	}

	private addOp(kind: Kind, label: string, ms: number): void {
		const t = this.io.get(kind) ?? { n: 0, ms: 0 };
		t.n++;
		t.ms += ms;
		this.io.set(kind, t);
		const key = `${kind} ${label}`;
		const o = this.ops.get(key);
		if (o) {
			o.n++;
			o.ms += ms;
		} else if (this.ops.size < MAX_OP_LABELS) {
			this.ops.set(key, { n: 1, ms });
		}
		if (this.slow.length < MAX_SLOW_OPS || ms > this.slow[this.slow.length - 1].ms) {
			this.slow.push({ label: `${kind} ${label}`, ms });
			this.slow.sort((a, b) => b.ms - a.ms);
			if (this.slow.length > MAX_SLOW_OPS) this.slow.length = MAX_SLOW_OPS;
		}
	}

	/** A promise handed to waitUntil: timed for the background log line. */
	track(p: Promise<unknown>): void {
		const t0 = now();
		this.background.push(
			p.then(
				() => now() - t0,
				() => now() - t0
			)
		);
	}

	elapsed(): number {
		return now() - this.started;
	}

	serverTiming(): string {
		const parts: string[] = [];
		for (const [name, s] of this.stages) parts.push(`${headerName(name)};dur=${round(s.ms)}`);
		for (const [kind, t] of this.io) parts.push(`${kind};dur=${round(t.ms)};desc="n=${t.n}"`);
		parts.push(`total;dur=${round(this.elapsed())}`);
		return parts.join(', ');
	}

	summary(): Record<string, unknown> {
		return {
			totalMs: round(this.elapsed()),
			stages: Object.fromEntries([...this.stages].map(([k, s]) => [k, s.n > 1 ? { ms: round(s.ms), n: s.n } : round(s.ms)])),
			io: Object.fromEntries([...this.io].map(([k, t]) => [k, { n: t.n, ms: round(t.ms) }])),
			slowest: this.slow.map((o) => ({ op: o.label, ms: round(o.ms) })),
			ops: Object.fromEntries([...this.ops].map(([k, o]) => [k, o.n > 1 ? { n: o.n, ms: round(o.ms) } : round(o.ms)])),
		};
	}

	/** Durations of this request's waitUntil work, once it has all settled. */
	async backgroundDurations(): Promise<number[]> {
		return (await Promise.all(this.background)).map(round);
	}
}

/** Server-Timing metric names are tokens: `onsuccess.roles` -> `onsuccess-roles`. */
function headerName(name: string): string {
	return name.replace(/[^A-Za-z0-9!#$%&'*+\-^_`|~]/g, '-');
}

/** `SELECT … FROM users WHERE …` -> `SELECT users`. Never the values. */
export function sqlLabel(sql: string): string {
	const verb = /^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase() ?? 'SQL';
	const table = /\b(?:FROM|INTO|UPDATE|JOIN)\s+["`]?([A-Za-z_][A-Za-z0-9_]*)/i.exec(sql)?.[1];
	return table ? `${verb} ${table}` : verb;
}

/** Last key segments that name a record kind rather than hold a value. */
const KV_KEY_SUFFIXES = new Set(['password', 'subject']);

/** `email::someone@x::password` -> `email::*::password`; keys can hold emails and token ids. */
export function kvLabel(key: string): string {
	// "::" (current) or U+001F (keys of the original openauth)
	const parts = key.split('::').flatMap((p) => p.split(String.fromCharCode(0x1f)));
	if (parts.length === 1) return parts[0].length > 24 ? '*' : parts[0];
	return [parts[0], ...parts.slice(1).map((p, i, all) => (i === all.length - 1 && KV_KEY_SUFFIXES.has(p) ? p : '*'))].join('::');
}

function timedStatement(stmt: D1PreparedStatement, label: string, timer: RequestTimer): D1PreparedStatement {
	const wrapped = {
		__raw: stmt,
		bind: (...values: unknown[]) => timedStatement(stmt.bind(...values), label, timer),
		first: (col?: string) => timer.op('d1', label, () => (col === undefined ? stmt.first() : stmt.first(col))),
		run: () => timer.op('d1', label, () => stmt.run()),
		all: () => timer.op('d1', label, () => stmt.all()),
		raw: (opts?: { columnNames?: boolean }) => timer.op('d1', label, () => stmt.raw(opts as { columnNames: true })),
	};
	return wrapped as unknown as D1PreparedStatement;
}

const rawStatement = (s: D1PreparedStatement) => ((s as unknown as { __raw?: D1PreparedStatement }).__raw ?? s);

export function timedD1(db: D1Database, timer: RequestTimer): D1Database {
	return new Proxy(db, {
		get(target, prop) {
			if (prop === 'prepare') return (sql: string) => timedStatement(target.prepare(sql), sqlLabel(sql), timer);
			if (prop === 'batch')
				return (stmts: D1PreparedStatement[]) =>
					timer.op('d1', `batch(${stmts.length})`, () => target.batch(stmts.map(rawStatement)));
			if (prop === 'exec') return (sql: string) => timer.op('d1', 'exec', () => target.exec(sql));
			const value = Reflect.get(target, prop, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

export function timedKV(kv: KVNamespace, timer: RequestTimer): KVNamespace {
	return new Proxy(kv, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target);
			if (typeof value !== 'function') return value;
			if (prop === 'get' || prop === 'getWithMetadata' || prop === 'put' || prop === 'delete') {
				return (key: string | string[], ...rest: unknown[]) =>
					timer.op('kv', `${String(prop)} ${Array.isArray(key) ? 'many' : kvLabel(key)}`, () =>
						(value as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest)
					);
			}
			if (prop === 'list') return (...args: unknown[]) => timer.op('kv', 'list', () => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
			return value.bind(target);
		},
	});
}

function timedQueue(queue: Queue, name: string, timer: RequestTimer): Queue {
	return new Proxy(queue, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target);
			if (typeof value !== 'function') return value;
			if (prop === 'send' || prop === 'sendBatch')
				return (...args: unknown[]) => timer.op('queue', `${String(prop)} ${name}`, () => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
			return value.bind(target);
		},
	});
}

function timedLimiter(limiter: RateLimit, name: string, timer: RequestTimer): RateLimit {
	return {
		limit: (opts: RateLimitOptions) => timer.op('rl', name, () => limiter.limit(opts)),
	} as RateLimit;
}

/**
 * The bindings that are timed, by name. Never by shape: a Secrets Store binding
 * or service binding is an RPC stub on which every property name is a function,
 * so it would look like KV and its get() would break.
 */
const TIMED_BINDINGS: Record<string, 'd1' | 'kv' | 'queue'> = {
	AUTH_DB: 'd1',
	AUTH_STORAGE: 'kv',
	TOKEN_REVOCATIONS: 'kv',
	AUTH_THEMES: 'kv',
	AUDIT_QUEUE: 'queue',
	MODERATION_QUEUE: 'queue',
};
/** Workers Rate Limiting bindings: PASSWORD_IP_LIMITER, TOKEN_LIMITER, ... */
const LIMITER = /^[A-Z_]+_LIMITER$/;

/**
 * This request's env with its D1, KV, queue and rate-limit bindings timed.
 * A Proxy over the real env (not a copy), so every other property, enumerable
 * or not, is the original value.
 */
export function instrumentEnv<E extends object>(env: E, timer: RequestTimer): E {
	const wrapped = new Map<string, unknown>();
	return new Proxy(env, {
		get(target, prop) {
			const value: unknown = Reflect.get(target, prop);
			if (typeof prop !== 'string' || !value || typeof value !== 'object') return value;
			const kind = TIMED_BINDINGS[prop] ?? (LIMITER.test(prop) ? 'rl' : undefined);
			if (!kind) return value;
			if (!wrapped.has(prop)) {
				const out =
					kind === 'd1'
						? timedD1(value as D1Database, timer)
						: kind === 'kv'
							? timedKV(value as KVNamespace, timer)
							: kind === 'queue'
								? timedQueue(value as Queue, prop, timer)
								: timedLimiter(value as RateLimit, prop, timer);
				wrapped.set(prop, out);
			}
			return wrapped.get(prop);
		},
	});
}

/** An ExecutionContext whose waitUntil work is timed for the background log line. */
export function instrumentCtx(ctx: ExecutionContext, timer: RequestTimer): ExecutionContext {
	return new Proxy(ctx, {
		get(target, prop) {
			if (prop === 'waitUntil')
				return (p: Promise<unknown>) => {
					timer.track(p);
					target.waitUntil(p);
				};
			const value = Reflect.get(target, prop, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

/** Sign-in chain paths whose timings are always logged; others only when slow. */
const SIGN_IN_PATH = /^\/(authorize|token|password\/|code\/|session\/|select-account|activate|device)/;
const SLOW_MS = 1000;

export function shouldLogTiming(pathname: string, elapsedMs: number): boolean {
	return SIGN_IN_PATH.test(pathname) || elapsedMs >= SLOW_MS;
}
