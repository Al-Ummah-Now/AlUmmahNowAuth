import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { APPS } from '../apps.ts';
import { runDevConfigCheck } from '../check-dev-config.ts';
import { scanPackageScripts, scanWorkflow } from '../deploy-commands.ts';
import { checkDevBindings, checkDevConfig, checkDevNotDeployed, checkLocalScripts, checkViteConfig, deployedIds } from '../dev-config.ts';
import { parseJsonc } from '../jsonc.ts';
import type { WranglerConfig } from '../wrangler-config.ts';

const ROOT = resolve(__dirname, '../../..');
const rule = (app: string) => APPS.find((a) => a.app === app)!;
const read = (path: string) => parseJsonc(readFileSync(join(ROOT, path), 'utf8')) as WranglerConfig;
const allDeployed = () => APPS.flatMap((a) => deployedIds(a, read(a.configPath)));

const PROD_KV = 'c3f796d40db8420c920aef1ce10a7f13';
const PROD_D1 = 'af76f007-e21e-43aa-88de-ebfefe46fb56';
const STAGE_D1 = 'c7886ef6-c70b-4b7f-a65b-3df9f9aba9e2';
const QA_KV = '14fd32ab385b496c88b5dba88c2492ea';
const QA_D1 = '28590f3c-dd92-4c26-a803-d73a9bbe2b58';

describe('repository dev configs', () => {
	it('pass the check as committed', () => {
		expect(runDevConfigCheck(ROOT)).toEqual([]);
	});

	it('every app has a dev config, and none of them names a deployed id', () => {
		for (const app of APPS) {
			expect(app.devConfigPath).toMatch(/\/wrangler\.dev\.jsonc?$/);
			const text = readFileSync(join(ROOT, app.devConfigPath), 'utf8');
			expect(text).not.toContain(PROD_KV);
			expect(text).not.toContain(PROD_D1);
			expect(text).not.toContain(STAGE_D1);
		}
	});

	it('knows the production and stage ids', () => {
		const ids = allDeployed().map((d) => d.id);
		expect(ids).toEqual(expect.arrayContaining([PROD_KV, PROD_D1, STAGE_D1]));
		expect(ids).not.toContain(QA_KV);
		expect(ids).not.toContain(QA_D1);
	});
});

describe('checkDevConfig', () => {
	// The auth admin's dev config before this check: wrangler.json, production, AUTH_STORAGE remote
	const before = {
		name: 'al-ummah-now-auth-admin',
		vars: { AUTH_SERVER_URL: 'https://auth.alummahnow.net', APP_URL: 'https://admin.auth.alummahnow.net' },
		kv_namespaces: [{ binding: 'AUTH_STORAGE', id: PROD_KV, preview_id: 'c9f1b1f1492e4a61b5e20d1872aa14fb', remote: true }],
		d1_databases: [{ binding: 'AUTH_DB', database_name: 'al-ummah-now-d1', database_id: PROD_D1 }],
	};

	it('rejects the production store, the remote flag and production hosts', () => {
		const errors = checkDevConfig('apps/admin/wrangler.json', before, allDeployed());
		expect(errors.join('\n')).toContain(`kv_namespaces[0].id is ${PROD_KV}, the id used by auth env.production kv_namespaces AUTH_STORAGE`);
		expect(errors.join('\n')).toContain(`d1_databases[0].database_id is ${PROD_D1}`);
		expect(errors.join('\n')).toContain('kv_namespaces[0].remote is `remote: true`');
		expect(errors.join('\n')).toContain('vars.AUTH_SERVER_URL points at auth.alummahnow.net');
		expect(errors.join('\n')).toContain('vars.APP_URL points at admin.auth.alummahnow.net');
	});

	it('rejects stage resources and hosts too', () => {
		const errors = checkDevConfig(
			'x',
			{ d1_databases: [{ binding: 'AUTH_DB', database_id: STAGE_D1 }], vars: { AUTH_SERVER_URL: 'https://auth.stage.alummahnow.net' } },
			allDeployed()
		);
		expect(errors).toHaveLength(2);
		expect(errors[0]).toContain('auth env.stage d1_databases AUTH_DB');
		expect(errors[1]).toContain('auth.stage.alummahnow.net');
	});

	it('accepts local stores, localhost and QA', () => {
		const local = { kv_namespaces: [{ binding: 'AUTH_STORAGE', id: 'local-auth-storage' }], vars: { AUTH_SERVER_URL: 'http://localhost:3301' } };
		const qa = {
			kv_namespaces: [{ binding: 'AUTH_STORAGE', id: QA_KV }],
			d1_databases: [{ binding: 'AUTH_DB', database_id: QA_D1 }],
			vars: { AUTH_SERVER_URL: 'https://auth.qa.alummahnow.net' },
		};
		expect(checkDevConfig('x', local, allDeployed())).toEqual([]);
		expect(checkDevConfig('x', qa, allDeployed())).toEqual([]);
	});

	it('rejects env blocks', () => {
		expect(checkDevConfig('x', { env: { stage: {} } }, allDeployed())[0]).toContain('no env blocks');
	});
});

describe('checkDevBindings', () => {
	it('reports a binding the dev config is missing', () => {
		const config = { kv_namespaces: [{ binding: 'AUTH_STORAGE', id: 'a' }], d1_databases: [{ binding: 'AUTH_DB', database_id: 'b' }] };
		const dev = { kv_namespaces: [{ binding: 'AUTH_STORAGE', id: 'local' }] };
		expect(checkDevBindings(rule('admin'), config, dev)).toEqual([
			'apps/admin/wrangler.dev.json: binding d1_databases:AUTH_DB is in apps/admin/wrangler.json but not in the dev config',
		]);
	});
});

describe('checkLocalScripts', () => {
	const run = (app: string, scripts: Record<string, string>) => checkLocalScripts(rule(app), 'package.json', { scripts });

	it('rejects the old dev scripts, which ran on wrangler.json', () => {
		expect(run('profile', { dev: 'wrangler dev --port 3302 --inspector-port 3312' })[0]).toContain('without -c wrangler.dev.json, so it would use wrangler.json');
		expect(run('auth', { 'migrations:local': 'npx openauth migrate AUTH_DB --local --withSeed && wrangler d1 migrations apply AUTH_DB --local' })).toHaveLength(2);
		expect(run('audit-consumer', { dev: 'wrangler dev --port 3304' })[0]).toContain('-c wrangler.dev.jsonc');
	});

	it('rejects wrangler dev --remote on anything but a QA config', () => {
		expect(run('auth', { 'dev:remote': 'wrangler dev -c wrangler.dev.json --remote' })[0]).toContain('only with a QA config');
		expect(run('auth', { 'dev:remote': 'wrangler dev --remote' })).toHaveLength(1);
	});

	it('accepts the dev config, QA, deploys and remote QA scripts', () => {
		expect(
			run('auth', {
				dev: 'wrangler dev -c wrangler.dev.json --port 3301',
				'dev:qa': 'wrangler dev -c wrangler.qa.json --remote',
				'seed:local': 'wrangler -c wrangler.dev.json d1 execute AUTH_DB --local --file=x.sql',
				'migrations:qa': 'wrangler -c wrangler.qa.json d1 migrations apply AUTH_DB --remote',
				deploy: 'wrangler deploy --env production',
				types: 'wrangler types --env-file .dev.vars.example',
			})
		).toEqual([]);
	});
});

describe('checkViteConfig', () => {
	it('requires the dev config in the Cloudflare plugin', () => {
		expect(checkViteConfig(rule('admin'), 'vite.config.ts', 'cloudflare({ configPath: "wrangler.json" })')).toHaveLength(1);
		expect(checkViteConfig(rule('admin'), 'vite.config.ts', 'cloudflare({ configPath: command === "serve" ? "wrangler.dev.json" : "wrangler.json" })')).toEqual([]);
		expect(checkViteConfig(rule('admin'), 'vite.config.ts', 'export default {}')).toEqual([]);
	});
});

describe('checkDevNotDeployed', () => {
	it('rejects a deploy of a dev config', () => {
		const pkg = scanPackageScripts('apps/profile/package.json', 'apps/profile', { scripts: { oops: 'wrangler deploy -c wrangler.dev.json' } });
		const wf = scanWorkflow('w.yml', 'jobs:\n  x:\n    steps:\n      - run: npx wrangler deploy --config wrangler.dev.jsonc\n');
		expect(checkDevNotDeployed([...pkg, ...wf])).toHaveLength(2);
	});
});
