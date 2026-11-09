import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SITE_THEME, SITE_THEMES, fetchSiteTheme, resolveSiteTheme, themeAssets, themeCss } from '../../../packages/ui/src/site-theme';

const answer = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

describe('site theme', () => {
  it('defaults to fawanees', () => {
    expect(DEFAULT_SITE_THEME).toBe('fawanees');
    expect(resolveSiteTheme(undefined)).toBe('fawanees');
    expect(resolveSiteTheme('neon')).toBe('fawanees');
    expect(resolveSiteTheme('nahas')).toBe('nahas');
  });

  it('reads the setting from the admin API', async () => {
    const fetcher = answer({ theme: 'zujaj' });
    await expect(fetchSiteTheme('https://admin.test', fetcher)).resolves.toBe('zujaj');
    expect(fetcher).toHaveBeenCalledWith('https://admin.test/public/site-theme', expect.anything());
  });

  it('falls back to fawanees when the videos side has no endpoint, fails or is unset', async () => {
    await expect(fetchSiteTheme(undefined, answer({ theme: 'nahas' }))).resolves.toBe('fawanees');
    await expect(fetchSiteTheme('https://admin.test', answer({}, false))).resolves.toBe('fawanees');
    await expect(fetchSiteTheme('https://admin.test', vi.fn(async () => { throw new Error('timeout'); }) as unknown as typeof fetch)).resolves.toBe('fawanees');
  });

  it('bundles tokens and a sign-in graphic for every theme', () => {
    for (const theme of SITE_THEMES) {
      expect(themeCss(theme)).toContain('--fanous-color-primary');
      expect(themeAssets(theme).graphic).toContain('<svg');
      expect(themeAssets(theme).primary.dark).toMatch(/^#/);
    }
  });
});
