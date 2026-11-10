/**
 * The per-page sections of Auth's own pages (theme.json `x-auth.sections`):
 * every slot, the CSS property it sets and where. The extension schema, the
 * compiler and the admin builder all read this one list.
 */

/** OpenAuth's own corner setting for its form controls. */
export const AUTH_RADII = ['none', 'sm', 'md', 'lg', 'full'] as const;

export type SlotKind = 'paint' | 'color' | 'length' | 'shadow' | 'filter' | 'font' | 'display' | 'image' | 'spacing';

export interface SlotDef {
	/** e.g. "card.background" */
	key: string;
	label: string;
	kind: SlotKind;
	/** CSS property this slot sets (omitted: the slot is only a variable the page's own CSS reads). */
	property?: string;
	/** Selector the property is set on, inside the section's scope. */
	selector?: string;
}

/**
 * Slots of the "every sign-in page" section that the platform format already
 * has a field for: theme.json keeps them there (signIn.*), not in x-auth.
 */
export const SPEC_SLOTS: Record<string, string> = {
	'page.background': 'signIn.background',
	'card.background': 'signIn.card.background',
	'card.radius': 'signIn.card.radius',
	'card.shadow': 'signIn.card.edge',
};

export interface SectionDef {
	id: string;
	label: string;
	/** Where the section's rules apply: OpenAuth pages are told apart by html[data-auth-page]. */
	scope: 'openauth' | 'picker' | 'vars';
	/** data-auth-page values this section applies to ('base' = every OpenAuth page). */
	pages?: string[];
	slots: SlotDef[];
}

const ROOT = '[data-component="root"]';
const CARD = '[data-component="center"]';
const INNER = '[data-component="branding"], [data-component="form"], [data-component="form-footer"]';

/** The slots every OpenAuth page (sign-in, register, code, reset, consent) shares. */
const OPENAUTH_SLOTS: SlotDef[] = [
	{ key: 'page.background', label: 'Page background', kind: 'paint', property: 'background', selector: ROOT },
	{ key: 'page.backgroundImage', label: 'Page background image', kind: 'image', property: 'background-image', selector: ROOT },
	{ key: 'page.text', label: 'Page text', kind: 'color', property: 'color', selector: ROOT },
	{ key: 'card.width', label: 'Card width', kind: 'length', property: 'width', selector: CARD },
	{ key: 'card.padding', label: 'Card padding', kind: 'spacing', property: 'padding', selector: CARD },
	{ key: 'card.radius', label: 'Card corners', kind: 'length', property: 'border-radius', selector: CARD },
	{ key: 'card.background', label: 'Card background', kind: 'paint', property: 'background', selector: CARD },
	{ key: 'card.border', label: 'Card border', kind: 'spacing', property: 'border', selector: CARD },
	{ key: 'card.text', label: 'Card text', kind: 'color', property: 'color', selector: CARD },
	{ key: 'card.shadow', label: 'Card shadow', kind: 'shadow', property: 'box-shadow', selector: CARD },
	{ key: 'card.blur', label: 'Card backdrop', kind: 'filter', property: 'backdrop-filter', selector: CARD },
	{ key: 'card.contentPadding', label: 'Card content side padding', kind: 'length', property: 'padding-inline', selector: INNER },
	{ key: 'graphic.display', label: 'Header graphic', kind: 'display', property: 'display', selector: `${CARD} > .demo-gfx` },
	{ key: 'logo.display', label: 'Logo', kind: 'display', property: 'display', selector: '[data-component="logo"]' },
	{ key: 'logo.filter', label: 'Logo glow', kind: 'filter', property: 'filter', selector: '[data-component="logo"]' },
	{ key: 'title.text', label: 'Site title', kind: 'color', property: 'color', selector: '[data-component="site-title"]' },
	{ key: 'title.font', label: 'Site title font', kind: 'font', property: 'font-family', selector: '[data-component="site-title"]' },
	{ key: 'title.fontAr', label: 'Site title font (Arabic)', kind: 'font', property: 'font-family', selector: ':lang(ar) [data-component="site-title"]' },
	{ key: 'heading.text', label: 'Page headings', kind: 'color', property: 'color', selector: '[data-component="title"]' },
	{ key: 'heading.font', label: 'Page heading font', kind: 'font', property: 'font-family', selector: '[data-component="title"]' },
	{ key: 'heading.fontAr', label: 'Page heading font (Arabic)', kind: 'font', property: 'font-family', selector: ':lang(ar) [data-component="title"]' },
	{ key: 'label.text', label: 'Field labels', kind: 'color', property: 'color', selector: '[data-component="label"]' },
	{ key: 'input.background', label: 'Field background', kind: 'paint', property: 'background', selector: '[data-component="input"]' },
	{ key: 'input.text', label: 'Field text', kind: 'color', property: 'color', selector: '[data-component="input"]' },
	{ key: 'input.border', label: 'Field border', kind: 'spacing', property: 'border', selector: '[data-component="input"]' },
	{ key: 'input.radius', label: 'Field corners', kind: 'length', property: 'border-radius', selector: '[data-component="input"]' },
	{ key: 'button.background', label: 'Button', kind: 'paint', property: 'background', selector: '[data-component="button"]' },
	{ key: 'button.text', label: 'Button text', kind: 'color', property: 'color', selector: '[data-component="button"]' },
	{ key: 'button.radius', label: 'Button corners', kind: 'length', property: 'border-radius', selector: '[data-component="button"]' },
	{ key: 'button.shadow', label: 'Button shadow', kind: 'shadow', property: 'box-shadow', selector: '[data-component="button"]' },
	{ key: 'button.hover', label: 'Button (hover)', kind: 'paint', property: 'background', selector: '[data-component="button"]:hover' },
	{ key: 'link.text', label: 'Links', kind: 'color', property: 'color', selector: '[data-component="link"]' },
	{ key: 'alert.background', label: 'Message background', kind: 'paint', property: 'background', selector: '[data-component="form-alert"]' },
	{ key: 'alert.text', label: 'Message text', kind: 'color', property: 'color', selector: '[data-component="form-alert"]' },
];

const PICKER_SLOTS: SlotDef[] = [
	{ key: 'page.background', label: 'Page background', kind: 'paint', property: 'background', selector: 'body' },
	{ key: 'page.text', label: 'Page text', kind: 'color', property: 'color', selector: 'body' },
	{ key: 'card.background', label: 'Card background', kind: 'paint', property: 'background', selector: '.container' },
	{ key: 'card.padding', label: 'Card padding', kind: 'spacing', property: 'padding', selector: '.container' },
	{ key: 'card.radius', label: 'Card corners', kind: 'length', property: 'border-radius', selector: '.container' },
	{ key: 'card.shadow', label: 'Card shadow', kind: 'shadow', property: 'box-shadow', selector: '.container' },
	{ key: 'item.background', label: 'Account row', kind: 'paint', property: 'background', selector: '.account-btn, .account' },
	{ key: 'item.border', label: 'Account row border', kind: 'spacing', property: 'border', selector: '.account-btn, .account' },
	{ key: 'item.text', label: 'Account row text', kind: 'color', property: 'color', selector: '.account-btn, .account' },
	{ key: 'item.radius', label: 'Account row corners', kind: 'length', property: 'border-radius', selector: '.account-btn, .account' },
	{ key: 'avatar.background', label: 'Avatar', kind: 'paint', property: 'background', selector: '.avatar' },
	{ key: 'avatar.text', label: 'Avatar text', kind: 'color', property: 'color', selector: '.avatar' },
	{ key: 'add.background', label: 'Add account', kind: 'paint', property: 'background', selector: '.add-account' },
	{ key: 'add.text', label: 'Add account text', kind: 'color', property: 'color', selector: '.add-account' },
];

/** Variables only: the profile app's and admin app's own stylesheets read --auth-<section>-<slot> with their current look as fallback. */
const varSlot = (key: string, label: string, kind: SlotKind): SlotDef => ({ key, label, kind });

export const SECTIONS: SectionDef[] = [
	{ id: 'base', label: 'Every sign-in page', scope: 'openauth', pages: ['base'], slots: OPENAUTH_SLOTS },
	{ id: 'signIn', label: 'Sign-in', scope: 'openauth', pages: ['sign-in'], slots: OPENAUTH_SLOTS },
	{ id: 'register', label: 'Register', scope: 'openauth', pages: ['register'], slots: OPENAUTH_SLOTS },
	{ id: 'code', label: 'Code entry', scope: 'openauth', pages: ['code'], slots: OPENAUTH_SLOTS },
	{ id: 'reset', label: 'Forgot / reset password', scope: 'openauth', pages: ['reset'], slots: OPENAUTH_SLOTS },
	{ id: 'consent', label: 'Device sign-in approval', scope: 'openauth', pages: ['consent'], slots: OPENAUTH_SLOTS },
	{ id: 'accountSwitcher', label: 'Account switcher', scope: 'picker', pages: ['account-switcher'], slots: PICKER_SLOTS },
	{
		id: 'profile',
		label: 'Profile pages',
		scope: 'vars',
		slots: [
			varSlot('page.background', 'Page background', 'paint'),
			varSlot('nav.background', 'Top bar', 'paint'),
			varSlot('card.background', 'Cards', 'paint'),
			varSlot('card.border', 'Card border', 'color'),
			varSlot('card.radius', 'Card corners', 'length'),
			varSlot('card.shadow', 'Card shadow', 'shadow'),
			varSlot('heading.text', 'Headings', 'color'),
			varSlot('button.background', 'Primary button', 'paint'),
			varSlot('button.text', 'Primary button text', 'color'),
		],
	},
	{
		id: 'adminShell',
		label: 'Admin shell',
		scope: 'vars',
		slots: [
			varSlot('sidebar.background', 'Sidebar', 'paint'),
			varSlot('sidebar.text', 'Sidebar text', 'color'),
			varSlot('sidebar.active', 'Sidebar current item', 'paint'),
			varSlot('sidebar.activeText', 'Sidebar current item text', 'color'),
			varSlot('header.background', 'Header', 'paint'),
			varSlot('header.text', 'Header text', 'color'),
			varSlot('page.background', 'Page background', 'paint'),
			varSlot('accent', 'Accent', 'color'),
		],
	},
];

export const SECTION_IDS = SECTIONS.map((s) => s.id);

export function sectionDef(id: string): SectionDef | undefined {
	return SECTIONS.find((s) => s.id === id);
}

/** Email header/button styling: the platform format's `email` section. */
export const EMAIL_KEYS = ['headerImage', 'background', 'text', 'buttonBackground', 'buttonText', 'buttonRadius'] as const;

export const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/\./g, '-');
