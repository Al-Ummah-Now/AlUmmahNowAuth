/**
 * The guides developers follow stay true (AUTH-R4): their links resolve, the routes
 * they name exist in openapi.json, and the names and ports we retired don't return.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const GUIDES = ['API_REFERENCE.md', 'AUTHENTICATION_FLOWS.md', 'SDK_USAGE.md', 'QUICKSTART.md', 'apps/auth/README.md'];
/** Plans for a package that was never built: kept, and they say so first. */
const HISTORY = ['docs/plans/CLIENT-INTEGRATION-GUIDE.md', 'docs/plans/CLIENT-MIGRATION-GUIDE.md', 'docs/plans/SDK-AUTH-CLIENT.md', 'docs/OPENAUTH_FORK_SETUP.md'];
const spec = JSON.parse(read('openapi.json')) as { paths: Record<string, Record<string, unknown>> };

const slug = (heading: string) =>
	heading
		.toLowerCase()
		.replace(/[^\w\s-]/g, '')
		.trim()
		.replace(/\s/g, '-');
const anchors = (text: string) => [...text.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]!));

describe.each(GUIDES)('%s', (guide) => {
	const text = read(guide);

	it('links resolve', () => {
		const broken = [...text.matchAll(/\]\(([^)\s]+)\)/g)]
			.map((m) => m[1]!)
			.filter((href) => !/^https?:/.test(href))
			.filter((href) => {
				const [file, anchor] = href.split('#') as [string, string?];
				const target = file ? join(ROOT, dirname(guide), file) : join(ROOT, guide);
				return !existsSync(target) || (anchor !== undefined && !anchors(readFileSync(target, 'utf8')).includes(anchor));
			});
		expect(broken).toEqual([]);
	});

	it('names only routes the server has', () => {
		const named = [...text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE) (\/[\w./{}-]*)/g)].map((m) => [m[1]!.toLowerCase(), m[2]!.replace(/[.,]$/, '')] as const);
		const unknown = named.filter(([method, path]) => !(path in spec.paths && method in spec.paths[path]!));
		expect(unknown).toEqual([]);
	});

	it('uses no retired package, repository or port', () => {
		expect(text).not.toMatch(/@openauthjs\/|@alummahnow\/|meywd\/|\/tmp\/openauth|workers\.dev/);
		expect(text).not.toMatch(/localhost:(8787|8788|517\d)/);
	});

	it('holds no real client id or secret', () => {
		expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
	});
});

describe('what is history says so', () => {
	it.each(HISTORY)('%s', (file) => {
		expect(read(file).split('\n').slice(0, 5).join('\n')).toContain('**History.**');
	});
});

describe('the quickstart matches the apps', () => {
	const quickstart = read('QUICKSTART.md');
	it.each([
		['auth', 'Auth server'],
		['profile', 'Profile'],
		['admin', 'Admin'],
		['audit-consumer', 'Audit consumer'],
	])('%s: the port in the table is the port it runs on', (app, label) => {
		const dev = (JSON.parse(read(`apps/${app}/package.json`)) as { scripts: { dev: string } }).scripts.dev;
		const port = /--port (\d+)/.exec(dev)![1];
		expect(quickstart).toContain(`| ${label} | http://localhost:${port} |`);
	});

	it('the example settings point at those ports', () => {
		const ports = new Set([...quickstart.matchAll(/localhost:(\d+)/g)].map((m) => m[1]));
		// The admin's own address is the one wrangler serves it on for E2E
		const own = /^APP_URL=.*5175$/m;
		for (const app of ['auth', 'profile', 'admin']) {
			const text = read(`apps/${app}/.dev.vars.example`).replace(own, '');
			for (const [, port] of text.matchAll(/localhost:(\d+)/g)) expect(ports, `${app}: ${port}`).toContain(port);
		}
	});

	it('every pnpm script it names exists', () => {
		const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
		const named = [...quickstart.matchAll(/pnpm ([a-z][\w:-]*)/g)].map((m) => m[1]!).filter((s) => !['install', 'config', 'add'].includes(s));
		expect(named.filter((s) => !(s in scripts))).toEqual([]);
	});
});
