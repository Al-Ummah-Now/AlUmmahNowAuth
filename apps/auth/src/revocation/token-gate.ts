/**
 * Where the revocation list (#437) meets the OpenAuth issuer.
 *
 * guardIssuerStorage wraps the storage handed to the issuer. Reading a
 * refresh token (["oauth:refresh", subject, token]) is how the refresh grant
 * starts, so:
 * - a refresh token whose sign-in (`authTime`) predates the user's revocation
 *   reads as missing and is deleted: the issuer answers invalid_grant. This
 *   works whatever the subject hash is, so every sign-out path only has to
 *   write the revocation entry.
 * - refresh tokens and codes minted before the access-token TTL was cut carry
 *   their old `ttl.access` (the issuer copies it into every rotated token);
 *   it's capped here, so existing sessions get short tokens on their next
 *   refresh and nobody has to sign in again.
 *
 * handleTokenRevoke is POST /token/revoke (RFC 7009) in front of the issuer:
 * a refresh token is deleted (single sign-out). Access tokens are not listed
 * (see revocation-list.ts); they expire within ACCESS_TOKEN_TTL. Always 200,
 * as the RFC asks, so tokens can't be probed.
 */
import type { StorageAdapter } from '@al-ummah-now/openauth/storage/storage';
import { loadRefreshToken, refreshKey, removeRefreshToken } from '@al-ummah-now/openauth/refresh-token';
import { logger } from '../logger';
import { isRevoked, readRevocation } from './revocation-list';

interface TokenRecord {
	properties?: { id?: string };
	clientID?: string;
	/** Milliseconds: when the user signed in. */
	authTime?: number;
	ttl?: { access?: number; refresh?: number };
	[key: string]: unknown;
}

export interface IssuerStorageGuard {
	/** TOKEN_REVOCATIONS; without it refresh tokens are not checked. */
	revocations?: KVNamespace;
	/** Access-token lifetime cap in seconds (ACCESS_TOKEN_TTL). */
	accessTtl?: number;
}

const GUARDED = new Set(['oauth:refresh', 'oauth:code']);

/** Positive ACCESS_TOKEN_TTL in seconds, else undefined (issuer default). */
export function parseAccessTtl(value: string | number | undefined): number | undefined {
	const n = Number(value);
	return Number.isInteger(n) && n >= 60 ? n : undefined;
}

/** Caps a code's or refresh token's access-token lifetime at ACCESS_TOKEN_TTL. */
function capAccessTtl<T extends TokenRecord | undefined>(value: T, accessTtl: number | undefined): T {
	const access = value?.ttl?.access;
	if (value && accessTtl && typeof access === 'number' && access > accessTtl) {
		return { ...value, ttl: { ...value.ttl, access: accessTtl } };
	}
	return value;
}

export function guardIssuerStorage(storage: StorageAdapter, guard: IssuerStorageGuard): StorageAdapter {
	if (!guard.revocations && !guard.accessTtl) return storage;

	/** Refused (revoked sign-in) -> undefined; else the value with the TTL cap. */
	async function check(key: string[], value: TokenRecord | undefined, remove: () => Promise<void>) {
		if (!value || !GUARDED.has(key[0] ?? '')) return value;
		if (key[0] === 'oauth:refresh' && guard.revocations) {
			const userId = value.properties?.id;
			const entry = userId ? await readRevocation(guard.revocations, userId) : null;
			const authTime = typeof value.authTime === 'number' ? Math.floor(value.authTime / 1000) : undefined;
			if (entry && isRevoked(entry, { authTime })) {
				await remove();
				logger.info('[revocation] Refused a refresh token of a revoked sign-in', { userId, reason: entry.reason });
				return undefined;
			}
		}
		return capAccessTtl(value, guard.accessTtl);
	}

	const atomic = storage.atomic;
	return {
		...storage,
		// Codes and refresh tokens live in the atomic store (D1): guard them there too
		...(atomic
			? {
					atomic: {
						...atomic,
						async get(key: string[]) {
							const value = (await atomic.get(key)) as TokenRecord | undefined;
							return check(key, value, () => atomic.remove(key));
						},
						// The issuer compares against what it read, which may carry the
						// TTL cap: compare against the stored value that caps to it
						async replace(key: string[], expected: unknown, value: unknown, expiry?: Date) {
							if (GUARDED.has(key[0] ?? '')) {
								const raw = (await atomic.get(key)) as TokenRecord | undefined;
								if (raw && JSON.stringify(capAccessTtl(raw, guard.accessTtl)) === JSON.stringify(expected)) expected = raw;
							}
							return atomic.replace(key, expected, value, expiry);
						},
					},
				}
			: {}),
		async get(key: string[]) {
			const value = (await storage.get(key)) as TokenRecord | undefined;
			return check(key, value, () => storage.remove(key));
		},
	};
}

function presentedClientIds(request: Request, form: FormData): string[] {
	const ids: string[] = [];
	const formId = form.get('client_id')?.toString();
	if (formId) ids.push(formId);
	const [type, credentials] = (request.headers.get('Authorization') ?? '').split(' ');
	if (type === 'Basic' && credentials) {
		try {
			const decoded = atob(credentials);
			const id = decoded.split(':')[0];
			if (id) ids.push(decodeURIComponent(id));
		} catch {
			// Malformed Basic credentials: no client presented
		}
	}
	return ids;
}

const ok = () =>
	new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function handleTokenRevoke(request: Request, storage: StorageAdapter): Promise<Response> {
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return new Response(JSON.stringify({ error: 'invalid_request', error_description: 'Form body required' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}
	const token = form.get('token')?.toString().trim();
	if (!token) {
		return new Response(JSON.stringify({ error: 'invalid_request', error_description: 'Missing token' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}
	const clients = presentedClientIds(request, form);

	// Access tokens are short-lived and not listed (RFC 7009 lets a server
	// support refresh tokens only); sign-out everywhere is /account/sign-out-all
	if (token.split('.').length === 3) return ok();

	const parts = token.split(':');
	const secret = parts.pop();
	const subject = parts.join(':');
	if (!subject || !secret) return ok();
	const key = refreshKey(subject, secret);
	// D1 since openauth OA-2; older tokens are still read from KV
	const record = (await loadRefreshToken(storage, key)) as TokenRecord | undefined;
	if (!record) return ok();
	// A client may only revoke its own tokens
	if (clients.length && clients.some((id) => id !== record.clientID)) return ok();
	await removeRefreshToken(storage, key);
	logger.info('[revocation] Refresh token revoked', { userId: record.properties?.id });
	return ok();
}
