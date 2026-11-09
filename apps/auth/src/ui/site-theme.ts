import { themeAssets, themeCss, type SiteTheme } from '../../../../packages/ui/src/site-theme';

/** Sign-in layout from the design: a card with the theme's graphic, on the theme's background. */
export const SIGN_IN_CSS = `
[data-component="root"] { background: var(--fanous-color-background); background-image: none; }
[data-component="center"] {
  width: min(400px, calc(100vw - 32px));
  padding: 0 0 1.5rem;
  overflow: hidden;
  border-radius: var(--fanous-radius-xl, 16px);
  background: var(--fanous-c-form-section-bg, var(--fanous-color-surface-raised));
  color: var(--fanous-color-text-primary);
  box-shadow: 0 18px 40px rgb(0 0 0 / 0.28);
}
[data-component="center"] > .demo-gfx svg { display: block; width: 100%; height: auto; }
[data-component="branding"], [data-component="form"], [data-component="form-footer"] { padding-inline: 1.5rem; }
[data-component="logo"] { display: none; }
[data-component="site-title"] { color: var(--fanous-color-text-primary); }
[data-component="label"] { color: var(--fanous-color-text-primary); }
[data-component="input"] { background: var(--fanous-c-form-input-bg, var(--fanous-color-surface)); color: var(--fanous-color-text-primary); }
[data-component="button"] { background: var(--fanous-color-primary); color: var(--fanous-color-on-primary); border-radius: var(--fanous-radius-md, 8px); }
[data-component="button"]:hover { background: var(--fanous-color-primary-hover); }
[data-component="link"] { color: var(--fanous-color-link); }
`;

/** Sets data-theme on every page, and puts the graphic on the sign-in card. */
export function applySiteTheme(response: Response, theme: SiteTheme): Response {
  if (!(response.headers.get('Content-Type') ?? '').includes('text/html')) return response;
  const graphic = `<div class="demo-gfx" data-t="${theme}" aria-hidden="true">${themeAssets(theme).graphic}</div>`;
  return new HTMLRewriter()
    .on('html', { element: (el) => { el.setAttribute('data-theme', theme); } })
    .on('[data-component="center"]', { element: (el) => { el.prepend(graphic, { html: true }); } })
    .transform(response);
}

/** Puts the site-wide theme on the per-request OpenAuth theme: its colours, then its CSS last so it wins. */
export function withSiteTheme<T extends { css: string }>(theme: T, site: SiteTheme): T & { primary: ReturnType<typeof themeAssets>['primary']; background: ReturnType<typeof themeAssets>['background'] } {
  return { ...theme, primary: themeAssets(site).primary, background: themeAssets(site).background, css: `${theme.css}\n${themeCss(site)}\n${SIGN_IN_CSS}` };
}
