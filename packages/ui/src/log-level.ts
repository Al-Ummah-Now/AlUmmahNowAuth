/**
 * LOG_LEVEL for the Auth workers (auth, profile, admin, audit-consumer): console
 * calls below the level are dropped, so Workers Logs (billed per line) keeps only
 * what matters. QA and stage set "warn" and log every invocation (no sampling, so
 * no error is lost); production sets "debug" (everything). Unset or unknown: everything.
 *
 * console.log/info/debug are swapped per isolate; that also quiets libraries
 * (openauth logs each password attempt with console.log).
 */
/* eslint-disable no-console -- this module sets which console calls print */
const RANK: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const original = { debug: console.debug, log: console.log, info: console.info };
const noop = () => {};
let applied: string | undefined;

export function applyLogLevel(level: string | undefined): void {
	if (level === applied) return;
	applied = level;
	const min = RANK[level ?? ''] ?? 0;
	console.debug = min > 0 ? noop : original.debug;
	console.log = min > 1 ? noop : original.log;
	console.info = min > 1 ? noop : original.info;
}
