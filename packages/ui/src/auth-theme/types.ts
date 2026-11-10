import type { Localized, ThemePackage } from '../theme-packages/types.ts';

export type { Localized, ThemePackage } from '../theme-packages/types.ts';

export type Scheme = 'light' | 'dark';
/** One value for both schemes, or one per scheme. */
export type SchemeValue = string | { light: string; dark: string };

/**
 * Auth's extension of a theme package (`"x-auth"` in theme.json): what Auth's
 * own pages need beyond the platform format. Other apps ignore it.
 */
export interface AuthExtension {
	/** Site title on the sign-in pages and in the page <title>. */
	title?: Localized;
	/** OpenAuth's corner setting for its form controls. */
	radius?: 'none' | 'sm' | 'md' | 'lg' | 'full';
	/** Google Fonts stylesheets (the sign-in pages' CSP allows fonts.googleapis.com). */
	fontImports?: string[];
	/** Photos behind the sign-in card (one is picked per page): files in assets/ or https URLs. */
	photos?: { light: string[]; dark?: string[] };
	/** Per-page sections: { "<section>": { "<slot>": value } }; see catalog.ts. */
	sections?: Record<string, Record<string, SchemeValue>>;
}

export const AUTH_EXTENSION = 'x-auth';

/** An Auth theme: a format v1 package, optionally with the x-auth extension. */
export type AuthThemeJson = ThemePackage & { 'x-auth'?: AuthExtension };

export interface StoredAsset {
	hash: string;
	type: string;
	size: number;
}

/** A stored package: theme.json plus its assets/ files (by content hash). */
export interface StoredPackage {
	theme: AuthThemeJson;
	assets: Record<string, StoredAsset>;
}

export interface EmailTheme {
	headerImage?: string;
	background?: string;
	text?: string;
	buttonBackground?: string;
	buttonText?: string;
	buttonRadius?: string;
}

export interface CompiledTheme {
	id: string;
	version: string;
	name: Localized;
	/** Passed to OpenAuth as its per-request theme (css carries the placeholder below until a page picks a photo). */
	openauth: {
		/** By language code (OpenAuth's LocalizedString). */
		title?: Record<string, string>;
		primary: { light: string; dark: string };
		background: { light: string; dark: string };
		favicon?: string;
		logo?: { light: string; dark: string };
		radius: 'none' | 'sm' | 'md' | 'lg' | 'full';
		font?: { family?: string };
		css: string;
	};
	backgrounds: string[];
	/** Inline SVG markup per scheme (sanitized). */
	graphic?: { light: string; dark: string };
	/** Fonts + tokens + materials + section variables: what the profile and admin apps link. */
	tokensCss: string;
	/** Rules for the account switcher pages (they don't take OpenAuth's theme CSS). */
	pickerCss: string;
	email: EmailTheme;
}

export const BG_PLACEHOLDER = '__AUTH_THEME_BACKGROUND__';
