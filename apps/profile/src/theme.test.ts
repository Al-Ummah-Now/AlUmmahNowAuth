import { describe, expect, it, vi } from 'vitest';
import { defaultTheme, fetchAuthTheme } from './theme';

const AUTH = 'https://auth.example';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('fetchAuthTheme', () => {
  it("asks Auth for the client's theme, passing a valid ?theme= on", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ id: 'nahas', css: ':root{--x:1}' }));
    expect(await fetchAuthTheme(AUTH, 'client-1', 'nahas', fetcher)).toEqual({ id: 'nahas', css: ':root{--x:1}' });
    const url = new URL(fetcher.mock.calls[0][0]);
    expect(url.pathname).toBe('/themes/resolve');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('theme')).toBe('nahas');
  });

  it('drops a malformed ?theme=', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ id: 'fawanees', css: '' }));
    await fetchAuthTheme(AUTH, 'c', 'Bad Theme!', fetcher);
    expect(new URL(fetcher.mock.calls[0][0]).searchParams.has('theme')).toBe(false);
  });

  it('keeps the built-in default when Auth fails or answers oddly', async () => {
    const fallback = defaultTheme(AUTH);
    expect(fallback.id).toBe('fawanees');
    expect(await fetchAuthTheme(AUTH, 'c', null, vi.fn().mockRejectedValue(new Error('down')))).toEqual(fallback);
    expect(await fetchAuthTheme(AUTH, 'c', null, vi.fn().mockResolvedValue(json({}, 500)))).toEqual(fallback);
    expect(await fetchAuthTheme(AUTH, 'c', null, vi.fn().mockResolvedValue(json({ id: 'x', css: '</style><script>' })))).toEqual(fallback);
  });
});
