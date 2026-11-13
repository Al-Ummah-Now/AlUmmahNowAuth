import { describe, expect, it, vi } from 'vitest';
import { NOINDEX, noIndexWorker } from '../../../packages/ui/src/crawlers.ts';

describe('noIndexWorker (auth, profile and auth admin hosts)', () => {
  const inner = {
    fetch: vi.fn(async (request: Request, _env?: unknown, _ctx?: ExecutionContext) =>
      new URL(request.url).pathname === '/moved'
        ? Response.redirect('https://profile.auth.alummahnow.net/login', 302)
        : new Response('page', { status: 200, headers: { 'Set-Cookie': 'a=1' } })),
    scheduled: vi.fn(),
  };
  const worker = noIndexWorker(inner);
  const ctx = {} as ExecutionContext;

  it('answers robots.txt itself: Disallow everything', async () => {
    const res = await worker.fetch(new Request('https://auth.alummahnow.net/robots.txt'), {}, ctx);
    expect(await res.text()).toBe('User-agent: *\nDisallow: /\n');
    expect(res.headers.get('X-Robots-Tag')).toBe(NOINDEX);
    expect(inner.fetch).not.toHaveBeenCalledWith(expect.objectContaining({ url: 'https://auth.alummahnow.net/robots.txt' }), expect.anything(), expect.anything());
  });

  it('marks every other response noindex and keeps its headers', async () => {
    const res = await worker.fetch(new Request('https://profile.auth.alummahnow.net/'), {}, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Robots-Tag')).toBe(NOINDEX);
    expect(res.headers.get('Set-Cookie')).toBe('a=1');
  });

  it('copies responses whose headers are immutable (redirects)', async () => {
    const res = await worker.fetch(new Request('https://profile.auth.alummahnow.net/moved'), {}, ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://profile.auth.alummahnow.net/login');
    expect(res.headers.get('X-Robots-Tag')).toBe(NOINDEX);
  });

  it('keeps the other handlers', () => {
    expect(worker.scheduled).toBe(inner.scheduled);
  });
});
