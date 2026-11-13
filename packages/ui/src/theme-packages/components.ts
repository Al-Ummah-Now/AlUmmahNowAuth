// Which part of the apps each component section styles, and the CSS custom property each
// style field compiles to. The apps' component CSS reads only these properties.

/** Component section -> the colour-part group it owns (`--fanous-c-<group>-*`). */
export const COMPONENT_PARTS: Record<string, string | null> = {
  page: null,
  header: 'nav',
  drawer: 'drawer',
  sidebar: null,
  buttonPrimary: 'button.primary',
  buttonSecondary: 'button.secondary',
  buttonGhost: 'button.ghost',
  buttonDestructive: 'button.destructive',
  buttonIcon: 'button.icon',
  upload: 'upload',
  input: 'form',
  card: null,
  videoCard: 'card.video',
  channelCard: 'card.channel',
  hero: null,
  tabs: 'tabs',
  segment: 'segment',
  menu: 'menu',
  dialog: 'dialog',
  toast: 'toast',
  badge: 'badge',
  player: 'player',
  footer: 'footer',
  link: 'link',
  divider: 'divider',
  skeleton: 'skeleton',
  empty: 'empty',
};

/**
 * Material fields in output order: [package path, CSS custom property].
 * `materials.*` are shared; `components.<name>.style.<field>` are per component.
 */
export const MATERIAL_VARS: [string, string][] = [
  ['materials.radius.sm', '--r-sm'],
  ['materials.radius.md', '--r-md'],
  ['materials.radius.lg', '--r-lg'],
  ['materials.radius.xl', '--r-xl'],
  ['materials.radius.pill', '--r-pill'],
  ['materials.blur', '--m-blur'],
  ['materials.glow', '--m-glow'],
  ['components.page.style.background', '--m-page'],
  ['components.header.style.background', '--m-header'],
  ['components.header.style.edge', '--m-header-edge'],
  ['components.sidebar.style.background', '--m-rail'],
  ['components.sidebar.style.edge', '--m-rail-edge'],
  ['components.card.style.background', '--m-card'],
  ['components.card.style.border', '--m-border'],
  ['components.card.style.edge', '--m-card-edge'],
  ['components.menu.style.background', '--m-raised'],
  ['components.menu.style.edge', '--m-raised-edge'],
  ['components.input.style.background', '--m-control'],
  ['components.input.style.edge', '--m-control-edge'],
  ['components.buttonPrimary.style.background', '--m-primary'],
  ['components.buttonPrimary.style.hover', '--m-primary-hover'],
  ['components.buttonPrimary.style.pressed', '--m-primary-press'],
  ['components.buttonPrimary.style.edge', '--m-primary-edge'],
  ['components.sidebar.style.active', '--m-active'],
  ['components.sidebar.style.activeEdge', '--m-active-edge'],
  ['materials.hover', '--m-hover'],
  ['components.sidebar.style.indicator', '--m-ind'],
  ['components.sidebar.style.indicatorWidth', '--m-ind-w'],
  ['components.sidebar.style.indicatorHeight', '--m-ind-h'],
  ['components.sidebar.style.indicatorShadow', '--m-ind-shadow'],
  ['components.sidebar.style.indicatorShape', '--m-ind-shape'],
  ['components.hero.style.background', '--m-hero'],
  ['components.videoCard.style.thumbnailEdge', '--m-thumb-edge'],
  ['components.sidebar.style.selection', '--m-sel'],
  ['components.sidebar.style.selectionEdge', '--m-sel-edge'],
  ['components.sidebar.style.selectionBar', '--m-sel-bar'],
  ['components.sidebar.style.selectionGlow', '--m-sel-glow'],
  ['components.player.style.frame', '--m-player'],
  ['components.player.style.inner', '--m-player-inner'],
  ['components.player.style.ring', '--m-player-ring'],
];

/**
 * Optional material fields: emitted only when the package sets them (packages made before
 * they existed keep the old look through the CSS fallback). Dialog edge: an opaque `line`
 * drawn as a real border, so the rounded corners stay one continuous line (a translucent
 * box-shadow ring left gaps at the corners), and a `shadow` without a ring.
 */
export const OPTIONAL_MATERIAL_VARS: [string, string][] = [
  ['components.dialog.style.line', '--m-dialog-line'],
  ['components.dialog.style.shadow', '--m-dialog-shadow'],
];

/** Names a {material.*} reference may use: the --m-* properties above, without the prefix. */
export const MATERIAL_NAMES = new Set([...MATERIAL_VARS, ...OPTIONAL_MATERIAL_VARS].map(([, v]) => v).filter((v) => v.startsWith('--m-')).map((v) => v.slice(4)));

/** Player chrome fields. `bar-pad-compact` is optional (packages made before it fall back to `bar-pad`). */
export const PLAYER_TOKENS = [
  'bar', 'bar-edge', 'bar-pad', 'bar-pad-compact', 'bar-inset', 'bar-radius', 'blur',
  'icon', 'dim',
  'track', 'track-edge', 'buffered', 'played', 'glow',
  'handle', 'handle-edge',
  'hover', 'press', 'shape',
  'tip-bg', 'tip-text', 'tip-edge',
  'menu', 'menu-edge', 'menu-hover', 'menu-selected',
  'accent',
  'big', 'big-icon', 'big-edge',
  'spin',
  'pill', 'pill-edge',
  'cue', 'err', 'scrim',
  'live', 'live-text',
] as const;

/** Stacking level of the player's portalled layers; the same in every theme. */
export const PLAYER_SHARED = { layer: '1100' } as const;

export const RADIUS_NAMES = ['none', 'sm', 'md', 'lg', 'xl', 'full'];
export const ELEVATION_NAMES = ['low', 'medium', 'high'];
export const BRAND_NAMES = ['night', 'nightDeep', 'nightShallow', 'lantern', 'glow', 'earth', 'parchment', 'verified', 'error'];

export const get = (obj: unknown, path: string): any => path.split('.').reduce<any>((n, k) => (n == null ? undefined : n[k]), obj);
