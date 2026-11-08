import { describe, it, expect } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../index';
import { deepHealth } from '../health';

const baseEnv = () => env as unknown as Env & Record<string, unknown>;

/** Env shaped like a correct deployment: every Secrets Store binding resolves. */
function deployedEnv(overrides: Record<string, unknown> = {}): Env {
  const secret = (value: string) => ({ get: async () => value });
  return {
    ...baseEnv(),
    ENVIRONMENT: 'production',
    OPENAUTH_ISSUER: 'https://auth.alummahnow.net',
    CLIENT_SECRET_SALT: secret('salt'),
    KEY_ENCRYPTION_MASTER_KEY: secret('key'),
    RESEND_API_KEY: secret('re_test'),
    ...overrides,
  } as unknown as Env;
}

describe('deepHealth', () => {
  it('is ok when every binding resolves', async () => {
    const report = await deepHealth(deployedEnv());
    expect(report).toEqual({
      status: 'ok',
      environment: 'production',
      issuer: 'https://auth.alummahnow.net',
      checks: {
        config: true,
        d1: true,
        kv: true,
        queue: true,
        'secret:CLIENT_SECRET_SALT': true,
        'secret:KEY_ENCRYPTION_MASTER_KEY': true,
        'secret:RESEND_API_KEY': true,
      },
    });
  });

  it('is degraded when RESEND_API_KEY is not bound (incident 2026-11-07)', async () => {
    const report = await deepHealth(deployedEnv({ RESEND_API_KEY: undefined }));
    expect(report.status).toBe('degraded');
    expect(report.checks['secret:RESEND_API_KEY']).toBe(false);
  });

  it('is degraded when a Secrets Store binding throws', async () => {
    const report = await deepHealth(
      deployedEnv({ KEY_ENCRYPTION_MASTER_KEY: { get: async () => { throw new Error('denied'); } } })
    );
    expect(report.checks['secret:KEY_ENCRYPTION_MASTER_KEY']).toBe(false);
  });

  it('flags a localhost issuer outside development', async () => {
    const report = await deepHealth(deployedEnv({ OPENAUTH_ISSUER: 'http://localhost:3301' }));
    expect(report.checks.config).toBe(false);
  });

  it('never includes secret values in the report', async () => {
    const report = await deepHealth(deployedEnv());
    expect(JSON.stringify(report)).not.toMatch(/salt|re_test|"key"/);
  });
});

describe('GET /health?deep=1', () => {
  it('returns 503 with the failed checks when a secret is missing', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request('https://auth.test/health?deep=1'),
      deployedEnv({ RESEND_API_KEY: undefined }),
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as { status: string; checks: Record<string, boolean> };
    expect(body.status).toBe('degraded');
    expect(body.checks['secret:RESEND_API_KEY']).toBe(false);
  });

  it('plain /health stays dependency-free', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request('https://auth.test/health'), deployedEnv({ AUTH_DB: undefined }), ctx);
    await waitOnExecutionContext(ctx);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
