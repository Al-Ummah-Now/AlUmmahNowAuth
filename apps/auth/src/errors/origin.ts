/**
 * Where an Auth request came from, for the videos admin Errors page (AlUmmahNow
 * shared-types request-origin.ts is the model; ingest validates this with scrubOrigin).
 * Classified from the request only: no IP, no User-Agent text, no URL, no cookie is kept.
 */
export interface AuthRequestOrigin {
	surface: string;
	app?: string;
	appVersion?: string;
	source: string;
	referrerHost?: string;
	entry?: string;
	country?: string;
	device: string;
}

const NATIVE: [RegExp, string][] = [
	[/^ipados$/, 'ipados'],
	[/^(ios|iphoneos)$/, 'ios'],
	[/^(macos|osx|mac)$/, 'macos'],
	[/^(tvos|appletv)$/, 'apple_tv'],
	[/^(androidtv|android_tv|googletv|firetv|fireos)$/, 'android_tv'],
	[/^android$/, 'android'],
	[/^windows$/, 'windows'],
	[/^linux$/, 'linux'],
	[/^tizen$/, 'tizen'],
];
const BOT = /bot|crawl|spider|slurp|facebookexternalhit|preview|headlesschrome|lighthouse|curl\/|wget\/|python-requests|go-http-client|node-fetch|axios\//i;
const DEVICE: Record<string, string> = { ios: 'phone', android: 'phone', ipados: 'tablet', macos: 'desktop', windows: 'desktop', linux: 'desktop', android_tv: 'tv', apple_tv: 'tv', tizen: 'tv' };

/** "/password/authorize", "/admin/users/usr_1/roles" → "/admin/users/:id/roles": ids never leave. */
export function routeTemplate(path: string): string {
	return (
		'/' +
		path
			.split('/')
			.filter(Boolean)
			.map((s) => (/^(usr_|role_|ses_|cli_)|^[0-9a-f-]{16,}$|^\d{3,}$|[A-Za-z0-9_-]{24,}/.test(s) ? ':id' : s))
			.join('/')
	).slice(0, 200);
}

export function requestOrigin(request: Request): AuthRequestOrigin | undefined {
	try {
		const h = request.headers;
		const url = new URL(request.url);
		const client = /^\s*([A-Za-z0-9._-]{1,40})(?:\/([A-Za-z0-9._+-]{1,40}))?\s*(?:\(([A-Za-z]{1,20})(?:\s+[A-Za-z0-9._-]{1,20})?\))?\s*$/.exec(h.get('x-aun-client') ?? '');
		const os = client?.[3]?.toLowerCase();
		const ua = h.get('user-agent') ?? '';
		const native = os ? NATIVE.find(([re]) => re.test(os))?.[1] : undefined;
		const surface = native ?? (ua && BOT.test(ua) ? 'bot' : h.get('authorization')?.startsWith('Bearer ') && !ua.includes('Mozilla') ? 'api' : ua ? (url.hostname.startsWith('admin.') ? 'admin' : 'web') : 'unknown');
		let device = DEVICE[surface] ?? (surface === 'bot' || surface === 'api' ? 'unknown' : 'desktop');
		if (surface === 'web' || surface === 'admin') {
			if (/smart-?tv|tizen|webos|appletv|googletv|android tv/i.test(ua)) device = 'tv';
			else if (/ipad|tablet|kindle|silk/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) device = 'tablet';
			else if (h.get('sec-ch-ua-mobile') === '?1' || /mobi|iphone|ipod|android.+mobile/i.test(ua)) device = 'phone';
		}
		let referrerHost: string | undefined;
		try {
			const ref = h.get('referer');
			referrerHost = ref ? new URL(ref).hostname.toLowerCase() : undefined;
		} catch {
			referrerHost = undefined;
		}
		const ours = referrerHost && /(^|\.)alummahnow\.(net|org|app|com)$/.test(referrerHost);
		const source = !referrerHost ? 'direct' : /(^|\.)alummahnow\.link$/.test(referrerHost) ? 'short_link' : ours ? 'platform' : 'site';
		const cf = (request as { cf?: { country?: unknown } }).cf;
		const country = typeof cf?.country === 'string' && /^[A-Z]{2}$/.test(cf.country) && cf.country !== 'XX' ? cf.country : undefined;
		return {
			surface,
			...(client ? { app: client[1]!.toLowerCase(), ...(client[2] ? { appVersion: client[2] } : {}) } : {}),
			source,
			...(referrerHost && source !== 'direct' && source !== 'short_link' ? { referrerHost } : {}),
			entry: routeTemplate(url.pathname),
			...(country ? { country } : {}),
			device,
		};
	} catch {
		return undefined;
	}
}
