/**
 * X-Release-Check (packages/ui/src/release-check.ts) in the Workers runtime: an "ok" never reaches the Cache API or
 * anyone else, what a copied response keeps, and this Worker's entry.
 */
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../index';
import { withReleaseCheck } from '../../../../packages/ui/src/release-check.ts';

const ID = '48155759-f731-482f-8a64-627bb3a56f48';
const HEADER = 'X-Release-Check';
const released = { CF_VERSION_METADATA: { id: ID, tag: '', timestamp: '' } };
const asks = (value?: string) => new Request('https://auth.test/x', value === undefined ? {} : { headers: { [HEADER]: value } });

describe('X-Release-Check in the Workers runtime', () => {
  it('an ok is never stored, and never answered to anyone else', async () => {
    const key = new Request('https://cache.test/release-check');
    const handle = async (request: Request) => {
      const hit = await caches.default.match(key);
      const response = hit ?? new Response('stored', { headers: { 'Cache-Control': 'public, max-age=60' } });
      const leaves = response.clone();
      if (!hit) await caches.default.put(key, response);
      return withReleaseCheck(request, released, leaves);
    };
    const first = await handle(asks(ID));
    expect([first.headers.get(HEADER), await first.text()]).toEqual(['ok', 'stored']);
    for (const other of [asks(), asks('11111111-1111-1111-1111-111111111111')]) {
      const res = await handle(other);
      expect([res.headers.get(HEADER), res.headers.get('Cloudflare-CDN-Cache-Control'), await res.text()]).toEqual([null, null, 'stored']);
    }
    const again = await handle(asks(ID));
    expect([again.headers.get(HEADER), await again.text()]).toEqual(['ok', 'stored']);
    const stored = (await caches.default.match(key))!;
    expect([stored.headers.get(HEADER), await stored.text()]).toEqual([null, 'stored']);
  });

  it('several Set-Cookie, empty answers, redirects and streams survive the copy', async () => {
    const cookies = withReleaseCheck(asks(ID), released, new Response('x', { headers: [['Set-Cookie', 'a=1; Path=/'], ['Set-Cookie', 'b=2; Path=/']] }));
    expect(cookies.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    for (const status of [204, 304]) expect(withReleaseCheck(asks(ID), released, new Response(null, { status })).headers.get(HEADER)).toBe('ok');
    const redirect = withReleaseCheck(asks(ID), released, Response.redirect('https://auth.test/password/authorize', 302));
    expect([redirect.status, redirect.headers.get('location'), redirect.headers.get(HEADER)]).toEqual([302, 'https://auth.test/password/authorize', 'ok']);
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const stream = withReleaseCheck(asks(ID), released, new Response(readable));
    void writer.write(new TextEncoder().encode('one ')).then(() => writer.write(new TextEncoder().encode('two'))).then(() => writer.close());
    expect([stream.headers.get(HEADER), await stream.text()]).toEqual(['ok', 'one two']);
  });
});

describe('the auth Worker', () => {
  const get = async (path: string, value?: string, bindings: object = released) => {
    const ctx = createExecutionContext();
    const res = await worker.fetch!(
      new Request(`https://auth.test${path}`, value === undefined ? {} : { headers: { [HEADER]: value } }) as never,
      { ...env, CF_VERSION_METADATA: undefined, ...bindings } as never,
      ctx
    );
    await res.text();
    await waitOnExecutionContext(ctx);
    return res;
  };

  it('proves its version on every kind of answer, only when asked for it', async () => {
    for (const path of ['/robots.txt', '/health', '/health?deep=1', '/.well-known/jwks.json', '/authorize', '/no/such/path']) {
      expect((await get(path, ID)).headers.get(HEADER), path).toBe('ok');
      expect((await get(path)).headers.get(HEADER), path).toBeNull();
      expect((await get(path, 'other')).headers.get(HEADER), path).toBeNull();
      expect((await get(path, ID, {})).headers.get(HEADER), path).toBeNull();
    }
  });
});
