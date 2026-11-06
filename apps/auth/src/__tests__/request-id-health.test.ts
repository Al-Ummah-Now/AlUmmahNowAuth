import { describe, it, expect } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../index';
import { resolveRequestId, withRequestId, REQUEST_ID_HEADER } from '../utils/request-id';

describe('resolveRequestId', () => {
  it('honors a valid incoming X-Request-ID', () => {
    const req = new Request('https://auth.test/', { headers: { 'X-Request-ID': 'abc-123_DEF.4:5' } });
    expect(resolveRequestId(req)).toBe('abc-123_DEF.4:5');
  });

  it('falls back to CF-Ray when X-Request-ID is absent', () => {
    const req = new Request('https://auth.test/', { headers: { 'CF-Ray': '8f1e2d3c4b5a6978-IAD' } });
    expect(resolveRequestId(req)).toBe('8f1e2d3c4b5a6978-IAD');
  });

  it('rejects unsafe incoming IDs and generates a UUID', () => {
    const req = new Request('https://auth.test/', {
      headers: { 'X-Request-ID': 'bad id <script>', 'CF-Ray': 'x'.repeat(200) },
    });
    expect(resolveRequestId(req)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('generates a UUID when nothing is provided', () => {
    expect(resolveRequestId(new Request('https://auth.test/'))).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('withRequestId', () => {
  it('sets the header on mutable responses', () => {
    const res = withRequestId(new Response('ok'), 'rid-1');
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('rid-1');
  });

  it('copies responses with immutable headers', () => {
    const res = withRequestId(Response.redirect('https://example.com/', 302), 'rid-2');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://example.com/');
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('rid-2');
  });
});

describe('GET /health', () => {
  it('returns {status:"ok"} without auth and echoes the request id', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request('https://auth.test/health', { headers: { 'X-Request-ID': 'health-check-1' } }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.headers.get('X-Request-ID')).toBe('health-check-1');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('supports HEAD with an empty body', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request('https://auth.test/health', { method: 'HEAD' }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('admin health stays behind the admin guard', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request('https://auth.test/admin/health'), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(500);
    expect(res.headers.get('X-Request-ID')).toBeTruthy();
  });
});
