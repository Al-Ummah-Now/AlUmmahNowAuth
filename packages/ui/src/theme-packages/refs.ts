// Token references inside theme package values, and how each compiles to CSS.
// A reference is written {kind.name}; an image is {asset:assets/file.svg}.

export const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

export type RefKind = 'color' | 'brand' | 'component' | 'material' | 'radius' | 'spacing' | 'asset';
export interface Ref { kind: RefKind; name: string; raw: string }

const REF = /\{([^{}]+)\}/g;
const KINDS: RefKind[] = ['color', 'brand', 'component', 'material', 'radius', 'spacing'];

/** Every reference in a value, in order. An unknown kind is returned as-is for the validator to name. */
export function parseRefs(value: string): Ref[] {
  const out: Ref[] = [];
  for (const m of value.matchAll(REF)) {
    const body = m[1];
    if (body.startsWith('asset:')) out.push({ kind: 'asset', name: body.slice(6), raw: m[0] });
    else {
      const dot = body.indexOf('.');
      out.push({ kind: body.slice(0, dot) as RefKind, name: body.slice(dot + 1), raw: m[0] });
    }
  }
  return out;
}

export const isKnownKind = (kind: string): kind is RefKind => kind === 'asset' || (KINDS as string[]).includes(kind);

/** The CSS custom property a reference reads. */
export function refVar(kind: Exclude<RefKind, 'asset'>, name: string): string {
  switch (kind) {
    case 'color': return `--fanous-color-${kebab(name)}`;
    case 'brand': return `--fanous-brand-${kebab(name)}`;
    case 'component': return `--fanous-c-${name.split('.').map(kebab).join('-')}`;
    case 'material': return `--m-${name}`;
    case 'radius': return `--r-${name}`;
    case 'spacing': return `--fanous-spacing-${kebab(name)}`;
  }
}

/** A CSS-safe url() for an asset URL. */
export const cssUrl = (url: string) => `url("${url.replace(/["\\\n\r]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}")`;

/** Replaces every reference with CSS: var(--...) for tokens, url("...") for assets. */
export function toCss(value: string, assetUrl: (path: string) => string): string {
  return value.replace(REF, (_, body: string) => {
    if (body.startsWith('asset:')) return cssUrl(assetUrl(body.slice(6)));
    const dot = body.indexOf('.');
    return `var(${refVar(body.slice(0, dot) as Exclude<RefKind, 'asset'>, body.slice(dot + 1))})`;
  });
}
