/**
 * Which theme a page gets: the one the app asked for (?theme=, if it is one
 * of Auth's published themes), else the app's own default, else Auth's
 * default, else the built-in default. Every step must be a published theme.
 */
export const BUILTIN_DEFAULT_THEME = 'fawanees';

export interface ThemeChoice {
	requested?: string | null;
	clientDefault?: string | null;
	authDefault?: string | null;
}

export type ThemeSource = 'requested' | 'client' | 'auth' | 'builtin';

export function chooseTheme(choice: ThemeChoice, isPublished: (id: string) => boolean): { id: string; source: ThemeSource } {
	if (choice.requested && isPublished(choice.requested)) return { id: choice.requested, source: 'requested' };
	if (choice.clientDefault && isPublished(choice.clientDefault)) return { id: choice.clientDefault, source: 'client' };
	if (choice.authDefault && isPublished(choice.authDefault)) return { id: choice.authDefault, source: 'auth' };
	return { id: BUILTIN_DEFAULT_THEME, source: 'builtin' };
}
