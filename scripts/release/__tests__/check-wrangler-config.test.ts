import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { APPS } from '../apps.ts';
import { runCheck } from '../check-wrangler-config.ts';
import { checkDeployCommands, scanPackageScripts, scanWorkflow } from '../deploy-commands.ts';
import { parseJsonc } from '../jsonc.ts';
import { checkApp, type WranglerConfig } from '../wrangler-config.ts';

const ROOT = resolve(__dirname, '../../..');
const authRule = APPS.find((a) => a.app === 'auth')!;
const authConfig = () => parseJsonc(readFileSync(join(ROOT, authRule.configPath), 'utf8')) as WranglerConfig;

describe('repository config', () => {
	it('passes the check as committed', () => {
		expect(runCheck(ROOT)).toEqual([]);
	});
});

describe('deploy commands (incident 2026-11-07: bare wrangler deploy shipped the dev config)', () => {
	const prodJob = (command: string) => `
jobs:
  deploy-auth-production:
    steps:
      - name: Deploy Auth to Cloudflare Workers (Production)
        uses: cloudflare/wrangler-action@v3
        with:
          workingDirectory: apps/auth
          command: ${command}
`;

	it('rejects the exact command that caused the incident', () => {
		const errors = checkDeployCommands(scanWorkflow('deploy.yml', prodJob('deploy')), APPS);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('bare deploy for auth');
	});

	it.each(['deploy --env production', 'deploy --env=stage', 'deploy --config wrangler.qa.json', 'deploy --dry-run --outdir dist', 'versions upload --env production'])(
		'accepts %s',
		(command) => {
			expect(checkDeployCommands(scanWorkflow('deploy.yml', prodJob(command)), APPS)).toEqual([]);
		}
	);

	it('rejects a bare versions upload too', () => {
		expect(checkDeployCommands(scanWorkflow('release.yml', prodJob('versions upload')), APPS)).toHaveLength(1);
	});

	it('attributes `cd apps/auth` and working-directory run steps', () => {
		const wf = `
    steps:
      - name: a
        run: |
          cd apps/auth
          pnpm exec wrangler deploy
      - name: b
        working-directory: apps/auth
        run: pnpm exec wrangler deploy \\
          --env production
`;
		const errors = checkDeployCommands(scanWorkflow('x.yml', wf), APPS);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('x.yml:6');
	});

	it('allows bare deploys for apps whose top level is the prod config', () => {
		const cmds = scanPackageScripts('apps/profile/package.json', 'apps/profile', { scripts: { deploy: 'wrangler deploy' } });
		expect(checkDeployCommands(cmds, APPS)).toEqual([]);
	});

	it('checks auth package scripts', () => {
		const cmds = scanPackageScripts('apps/auth/package.json', 'apps/auth', { scripts: { deploy: 'pnpm build && wrangler deploy' } });
		expect(checkDeployCommands(cmds, APPS)).toHaveLength(1);
	});
});

describe('auth env.production', () => {
	it('fails when a Secrets Store binding is missing', () => {
		const config = authConfig();
		const prod = config.env!.production as { secrets_store_secrets: { binding: string }[] };
		prod.secrets_store_secrets = prod.secrets_store_secrets.filter((s) => s.binding !== 'RESEND_API_KEY');
		expect(checkApp(authRule, config)).toContain('auth (env.production): missing required secrets_store_secrets binding RESEND_API_KEY');
	});

	it('fails on the dev (top-level) config, as deployed in the incident', () => {
		const config = authConfig();
		const devAsProd = { ...config, env: { production: { ...config, env: undefined } } } as WranglerConfig;
		const errors = checkApp(authRule, devAsProd);
		expect(errors.some((e) => e.includes('OPENAUTH_ISSUER must be "https://auth.alummahnow.net"'))).toBe(true);
		expect(errors.some((e) => e.includes('missing required secrets_store_secrets binding RESEND_API_KEY'))).toBe(true);
		expect(errors.some((e) => e.includes('points at localhost'))).toBe(true);
	});

	it('fails when a test-only secret is bound in production', () => {
		const config = authConfig();
		const prod = config.env!.production as { secrets_store_secrets: object[] };
		prod.secrets_store_secrets.push({ binding: 'E2E_CODE_SINK_SECRET', store_id: 'x', secret_name: 'E2E_CODE_SINK_SECRET_STAGE' });
		expect(checkApp(authRule, config)).toContain('auth (env.production): test-only binding E2E_CODE_SINK_SECRET must not be deployed here');
	});

	it('fails when the E2E run-account flag is set in production', () => {
		const config = authConfig();
		const prod = config.env!.production as { vars: Record<string, string> };
		prod.vars.E2E_RUN_USERS = 'enabled';
		expect(checkApp(authRule, config)).toContain('auth (env.production): test-only var E2E_RUN_USERS must not be deployed here');
	});

	it('fails on a non-prod route', () => {
		const config = authConfig();
		(config.env!.production as { routes: object[] }).routes.push({ pattern: 'auth.qa.alummahnow.net', custom_domain: true });
		expect(checkApp(authRule, config).some((e) => e.includes('route auth.qa.alummahnow.net is not an allowed host'))).toBe(true);
	});
});

describe('profile production hosts', () => {
	const profileRule = APPS.find((a) => a.app === 'profile')!;
	const profileConfig = () => parseJsonc(readFileSync(join(ROOT, profileRule.configPath), 'utf8')) as WranglerConfig & { routes: { pattern: string }[] };

	it('allows the account.alummahnow.net redirect alias', () => {
		const config = profileConfig();
		expect(config.routes.map((r) => r.pattern)).toContain('account.alummahnow.net');
		expect(checkApp(profileRule, config)).toEqual([]);
	});

	it('still rejects any other host on the profile Worker', () => {
		const config = profileConfig();
		config.routes.push({ pattern: 'account.qa.alummahnow.net' });
		expect(checkApp(profileRule, config).some((e) => e.includes('route account.qa.alummahnow.net is not an allowed host'))).toBe(true);
	});
});

describe('auth env.stage parity', () => {
	const withStage = (mutate: (stage: Record<string, unknown>) => void) => {
		const config = authConfig();
		const prod = config.env!.production;
		const stage = JSON.parse(JSON.stringify(prod)) as Record<string, unknown>;
		stage.name = 'al-ummah-now-auth-stage';
		stage.routes = [{ pattern: 'auth.stage.alummahnow.net', custom_domain: true }];
		stage.vars = { ...(prod.vars as object), ENVIRONMENT: 'stage', OPENAUTH_ISSUER: 'https://auth.stage.alummahnow.net', PROFILE_APP_URL: 'https://profile.auth.stage.alummahnow.net/' };
		mutate(stage);
		config.env!.stage = stage;
		return checkApp(authRule, config);
	};

	it('accepts a stage env that mirrors production', () => {
		expect(withStage(() => {})).toEqual([]);
	});

	it('fails when stage lacks a binding production has', () => {
		const errors = withStage((s) => {
			s.queues = { producers: [] };
		});
		expect(errors).toContain('auth: binding queue_producer:AUDIT_QUEUE is in production but not in stage');
	});

	it('fails when stage uses the prod issuer', () => {
		const errors = withStage((s) => {
			(s.vars as Record<string, string>).OPENAUTH_ISSUER = 'https://auth.alummahnow.net';
		});
		expect(errors.some((e) => e.includes('env.stage') && e.includes('OPENAUTH_ISSUER'))).toBe(true);
	});
});

describe('parseJsonc', () => {
	it('handles comments, trailing commas and slashes inside strings', () => {
		const text = `{
  // comment
  "url": "https://example.com/a", /* block */
  "list": [1, 2,],
}`;
		expect(parseJsonc(text)).toEqual({ url: 'https://example.com/a', list: [1, 2] });
	});
});
