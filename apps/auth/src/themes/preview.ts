/**
 * Admin live preview: the real Auth pages, rendered by the same OpenAuth page
 * renderers and the same decoration as sign-in, for a theme that may be an
 * unsaved draft. Forms are inert (the admin shows them in a sandboxed frame).
 */
import { PasswordUI } from '@al-ummah-now/openauth/ui/password';
import { DevicePage } from '@al-ummah-now/openauth/ui/device';
import { decorateHtml, forceScheme, type AuthPage } from '../../../../packages/ui/src/auth-theme/decorate.ts';
import { openauthThemeFor } from '../../../../packages/ui/src/auth-theme/compile.ts';
import type { CompiledTheme, Scheme } from '../../../../packages/ui/src/auth-theme/types.ts';
import { renderHomePage } from '../../../profile/src/page';
import { appsForUser } from '../../../profile/src/apps';
import { renderAccountSelector } from '../ui/select-account';
import { CODE_INPUT_LABEL } from '../ui/copy';

export const PREVIEW_PAGES = ['sign-in', 'register', 'code', 'reset', 'consent', 'account-switcher', 'profile'] as const;
export type PreviewPage = (typeof PREVIEW_PAGES)[number];

export interface PreviewOptions {
	page: PreviewPage;
	lang: 'en' | 'ar';
	scheme: Scheme;
	issuer: string;
	profileUrl: string;
}

const SAMPLE_EMAIL = 'amina@example.com';

export async function renderPreview(compiled: CompiledTheme, opts: PreviewOptions): Promise<string> {
	const { lang, scheme, page } = opts;
	const direction = lang === 'ar' ? 'rtl' : 'ltr';
	// The first photo, so the preview doesn't change on every keystroke
	const theme = openauthThemeFor(compiled, () => 0);
	const render = { theme, locale: lang, direction } as const;
	const req = new Request(`${opts.issuer}/password/authorize?lang=${lang}&auth_flow=preview`);

	if (page === 'profile') {
		const html = renderHomePage({
			locale: lang,
			apps: appsForUser(['user', 'admin'], 'production', lang),
			user: { id: 'usr_preview', email: SAMPLE_EMAIL, roles: ['user'] },
			authServerUrl: opts.issuer,
			appUrl: opts.profileUrl,
			clientId: 'preview',
			theme: { id: compiled.id, css: compiled.tokensCss },
		});
		return inert(forceScheme(html, scheme));
	}

	if (page === 'account-switcher') {
		const html = renderAccountSelector({
			accounts: [
				{ userId: 'usr_1', email: SAMPLE_EMAIL, name: 'Amina', lastUsed: new Date().toISOString(), isActive: true },
				{ userId: 'usr_2', email: 'yusuf@example.com', name: 'Yusuf', lastUsed: new Date().toISOString(), isActive: false },
			] as never,
			clientId: 'preview',
			clientName: 'Al Ummah Now',
			redirectUri: `${opts.profileUrl}/callback`,
			allowAddAccount: true,
		});
		return inert(decorateHtml(html, compiled, { page: 'account-switcher', forceScheme: scheme }));
	}

	let response: Response;
	let kind: AuthPage;
	const ui = PasswordUI({ sendCode: async () => {}, copy: { input_code: CODE_INPUT_LABEL[lang] } });
	switch (page) {
		case 'register':
			response = await ui.register(req, { type: 'start' }, undefined, undefined, render);
			kind = 'register';
			break;
		case 'code':
			response = await ui.register(req, { type: 'code', code: '000000', email: SAMPLE_EMAIL, password: 'x' } as never, undefined, undefined, render);
			kind = 'code';
			break;
		case 'reset':
			response = await ui.change(req, { type: 'start', redirect: '/password/authorize' }, undefined, undefined, render);
			kind = 'reset';
			break;
		case 'consent':
			response = DevicePage(lang, { page: 'confirm', userCode: 'ABCDEFGH', appName: 'Al Ummah Now TV', csrf: 'preview' }, { theme });
			kind = 'consent';
			break;
		default:
			response = await ui.login(req, undefined, undefined, render);
			kind = 'sign-in';
	}
	return inert(decorateHtml(await response.text(), compiled, { page: kind, forceScheme: scheme }));
}

/** No scripts, no form posts: the frame shows the page only. */
function inert(html: string): string {
	// every script element becomes an inert <template>: its contents are never run or shown
	return html.replace(/<(\/?)script\b/gi, '<$1template');
}
