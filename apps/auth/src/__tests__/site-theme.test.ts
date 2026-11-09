import { describe, expect, it } from 'vitest';
import { applySiteTheme } from '../ui/site-theme';

const page = (type = 'text/html; charset=utf-8') =>
  new Response('<html lang="en"><body><div data-component="center"><form></form></div></body></html>', { headers: { 'Content-Type': type } });

describe('applySiteTheme', () => {
  it('names the theme in the HTML and adds the sign-in graphic', async () => {
    const html = await applySiteTheme(page(), 'nahas').text();
    expect(html).toContain('data-theme="nahas"');
    expect(html).toMatch(/data-component="center"><div class="demo-gfx" data-t="nahas"/);
  });

  it('leaves other responses alone', async () => {
    const json = applySiteTheme(new Response('{"a":1}', { headers: { 'Content-Type': 'application/json' } }), 'nahas');
    expect(await json.text()).toBe('{"a":1}');
  });
});
