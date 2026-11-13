import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { setupDatabase } from '../test-setup';
import { handleTokenCron, resolveCronJob, CRON_SCHEDULE } from '../cron/token-cron';
import { TokenCleanupService, BROWSER_SESSION_MAX_IDLE_MS, ANALYTICS_RETENTION_DAYS } from '../services/token-cleanup';
import wranglerProd from '../../wrangler.json';
import wranglerQa from '../../wrangler.qa.json';

const DAY = 24 * 60 * 60 * 1000;

async function insertBrowserSession(id: string, lastActivity: number) {
  await env.AUTH_DB.prepare(
    `INSERT INTO browser_sessions (id, tenant_id, created_at, last_activity, version) VALUES (?, 'default', ?, ?, 1)`
  ).bind(id, lastActivity, lastActivity).run();
}

async function insertAccountSession(id: string, browserSessionId: string, expiresAt: number) {
  await env.AUTH_DB.prepare(
    `INSERT INTO account_sessions (id, browser_session_id, user_id, is_active, authenticated_at, expires_at, subject_type, refresh_token, client_id)
     VALUES (?, ?, ?, 1, ?, ?, 'user', 'rt', 'client')`
  ).bind(id, browserSessionId, `user-${id}`, expiresAt - DAY, expiresAt).run();
}

async function count(table: string): Promise<number> {
  const row = await env.AUTH_DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first<{ c: number }>();
  return row?.c ?? 0;
}

describe('cron schedule mapping', () => {
  it('maps the configured cron expression to the cleanup job', () => {
    expect(resolveCronJob('0 * * * *')).toBe('token-cleanup');
    expect(resolveCronJob('*/10 * * * *')).toBe('code-sweep');
  });

  it('accepts legacy job names', () => {
    expect(resolveCronJob('token-cleanup')).toBe('token-cleanup');
    expect(resolveCronJob('token-maintenance')).toBe('token-cleanup');
  });

  it('returns null for unknown expressions', () => {
    expect(resolveCronJob('*/5 * * * *')).toBeNull();
    expect(resolveCronJob('')).toBeNull();
    expect(resolveCronJob(undefined)).toBeNull();
  });

  it('every cron trigger in the wrangler configs is mapped to a job', () => {
    const configured = [
      ...((wranglerQa as { triggers?: { crons?: string[] } }).triggers?.crons ?? []),
      ...((wranglerProd as { env: { production: { triggers?: { crons?: string[] } } } }).env.production.triggers?.crons ?? []),
    ];
    expect(configured.length).toBeGreaterThan(0);
    for (const cron of configured) {
      expect(CRON_SCHEDULE[cron], `cron "${cron}" has no job`).toBeDefined();
    }
  });
});

describe('TokenCleanupService (real schema)', () => {
  beforeAll(async () => {
    await setupDatabase();
  });

  beforeEach(async () => {
    await env.AUTH_DB.prepare('DELETE FROM account_sessions').run();
    await env.AUTH_DB.prepare('DELETE FROM browser_sessions').run();
    await env.AUTH_DB.prepare('DELETE FROM token_usage').run();
  });

  it('deletes expired account sessions and idle browser sessions, keeps live ones', async () => {
    const now = Date.now();
    await insertBrowserSession('bs-live', now - 60_000);
    await insertBrowserSession('bs-idle', now - BROWSER_SESSION_MAX_IDLE_MS - DAY);
    await insertAccountSession('as-live', 'bs-live', now + DAY);
    await insertAccountSession('as-expired', 'bs-live', now - 1000);
    await insertAccountSession('as-on-idle', 'bs-idle', now + DAY);

    const result = await TokenCleanupService.runCleanup(env, now);

    expect(result.expiredAccountSessionsDeleted).toBe(1);
    expect(result.expiredBrowserSessionsDeleted).toBe(1);
    const remainingAccounts = await env.AUTH_DB.prepare('SELECT id FROM account_sessions ORDER BY id').all<{ id: string }>();
    expect(remainingAccounts.results.map((r) => r.id)).toEqual(['as-live']);
    const remainingBrowsers = await env.AUTH_DB.prepare('SELECT id FROM browser_sessions').all<{ id: string }>();
    expect(remainingBrowsers.results.map((r) => r.id)).toEqual(['bs-live']);
  });

  it('deletes token_usage rows older than the retention window (created_at in ms)', async () => {
    const now = Date.now();
    const old = now - (ANALYTICS_RETENTION_DAYS + 1) * DAY;
    const recent = now - DAY;
    for (const [id, ts] of [['old', old], ['recent', recent]] as const) {
      await env.AUTH_DB.prepare(
        `INSERT INTO token_usage (id, client_id, token_type, created_at) VALUES (?, 'c', 'access', ?)`
      ).bind(id, ts).run();
    }

    const result = await TokenCleanupService.runCleanup(env, now);

    expect(result.oldAnalyticsDeleted).toBe(1);
    expect(await count('token_usage')).toBe(1);
  });

  it('handleTokenCron runs cleanup for the hourly expression', async () => {
    await insertBrowserSession('bs-idle', Date.now() - BROWSER_SESSION_MAX_IDLE_MS - DAY);
    await expect(handleTokenCron(env, '0 * * * *')).resolves.toBe('token-cleanup');
    expect(await count('browser_sessions')).toBe(0);
  });

  it('handleTokenCron skips unmapped expressions without touching data', async () => {
    await insertBrowserSession('bs-idle', Date.now() - BROWSER_SESSION_MAX_IDLE_MS - DAY);
    await expect(handleTokenCron(env, '*/5 * * * *')).resolves.toBeNull();
    expect(await count('browser_sessions')).toBe(1);
  });
});

describe('code sweep (#348)', () => {
  beforeAll(async () => {
    await setupDatabase();
  });

  it('every 10 minutes deletes expired codes, used-code markers and device records; keeps live ones and other families', async () => {
    const now = Date.now();
    const put = (key: string, expiresAt: number | null) =>
      env.AUTH_DB.prepare('INSERT OR REPLACE INTO openauth_atomic (key, value, expires_at) VALUES (?, ?, ?)').bind(key, '{"properties":{"id":"usr_x"}}', expiresAt).run();
    await put('oauth:code::sw-expired', now - 1000);
    await put('oauth:code::sw-live', now + 600_000);
    await put('oauth:code_used::sw-expired', now - 1000);
    await put('oauth:device::sw-expired', now - 1000);
    await put('oauth:refresh::user:sw::expired', now - 1000);
    await put('oauth:key::sw-forever', null);
    expect(await handleTokenCron(env as unknown as Env, '*/10 * * * *')).toBe('code-sweep');
    const left = await env.AUTH_DB.prepare("SELECT key FROM openauth_atomic WHERE key LIKE '%sw%' ORDER BY key").all<{ key: string }>();
    // Refresh tokens and keys are the hourly cleanup's (or never expire)
    expect(left.results.map((r) => r.key)).toEqual(['oauth:code::sw-live', 'oauth:key::sw-forever', 'oauth:refresh::user:sw::expired']);
    const plan = await env.AUTH_DB.prepare(
      "EXPLAIN QUERY PLAN SELECT key FROM openauth_atomic WHERE expires_at IS NOT NULL AND expires_at <= ? AND ((key >= 'oauth:code::' AND key < 'oauth:code:;')) LIMIT 10"
    ).bind(now).all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(' ')).not.toMatch(/^SCAN openauth_atomic$/);
    await env.AUTH_DB.prepare("DELETE FROM openauth_atomic WHERE key LIKE '%sw%'").run();
  });
});
