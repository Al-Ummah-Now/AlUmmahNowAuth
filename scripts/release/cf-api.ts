/**
 * Minimal Cloudflare REST client for the release scripts (no dependencies).
 *
 * Token: CLOUDFLARE_API_TOKEN, or locally the OAuth token from `wrangler login`.
 * Account: CLOUDFLARE_ACCOUNT_ID, defaulting to the Al Ummah Now account.
 * Never logs the token or any request/response body that could hold a secret.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_ACCOUNT_ID = '0e4b6e7f9faf280c3c9bf95995edc64f';

function wranglerOAuthToken(): string | undefined {
	const candidates = [
		join(homedir(), 'Library/Preferences/.wrangler/config/default.toml'),
		join(homedir(), '.config/.wrangler/config/default.toml'),
		join(homedir(), '.wrangler/config/default.toml'),
	];
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		const match = readFileSync(path, 'utf8').match(/^oauth_token\s*=\s*"([^"]+)"/m);
		if (match) return match[1];
	}
	return undefined;
}

export interface CfClient {
	accountId: string;
	request<T>(method: string, path: string, body?: unknown): Promise<T>;
	/** The raw response: KV values are not wrapped in the API envelope, and list cursors live in result_info. */
	fetchRaw?(method: string, path: string): Promise<Response>;
}

export function createCfClient(env: NodeJS.ProcessEnv = process.env): CfClient {
	const token = env.CLOUDFLARE_API_TOKEN || wranglerOAuthToken();
	if (!token) throw new Error('No Cloudflare credentials: set CLOUDFLARE_API_TOKEN or run `wrangler login`');
	const accountId = env.CLOUDFLARE_ACCOUNT_ID || DEFAULT_ACCOUNT_ID;

	return {
		accountId,
		fetchRaw: (method: string, path: string) =>
			fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
				method,
				headers: { Authorization: `Bearer ${token}` },
			}),
		async request<T>(method: string, path: string, body?: unknown): Promise<T> {
			const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
				method,
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const json = (await res.json().catch(() => ({}))) as {
				success?: boolean;
				result?: T;
				errors?: { code: number; message: string }[];
			};
			if (!res.ok || json.success === false) {
				const msg = json.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') || res.statusText;
				throw new CfApiError(res.status, `${method} ${path.split('?')[0]} -> ${res.status} ${msg}`);
			}
			return json.result as T;
		},
	};
}

export class CfApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export interface WorkerBinding {
	type: string;
	name: string;
	text?: string;
	secret_name?: string;
	store_id?: string;
}

/** Deployed bindings of a Worker, or null if the Worker does not exist. */
export async function getWorkerBindings(cf: CfClient, script: string): Promise<WorkerBinding[] | null> {
	try {
		const settings = await cf.request<{ bindings?: WorkerBinding[] }>('GET', `/workers/scripts/${script}/settings`);
		return settings.bindings ?? [];
	} catch (error) {
		if (error instanceof CfApiError && error.status === 404) return null;
		throw error;
	}
}

/** Runs a parameterised query on a D1 database (by UUID) and returns its rows. */
export async function d1Query<Row>(cf: CfClient, databaseId: string, sql: string, params: unknown[] = []): Promise<Row[]> {
	const result = await cf.request<{ results: Row[] }[]>('POST', `/d1/database/${databaseId}/query`, { sql, params });
	return result[0]?.results ?? [];
}

function rawFetcher(cf: CfClient) {
	if (!cf.fetchRaw) throw new Error('This Cloudflare client cannot make raw requests');
	return cf.fetchRaw.bind(cf);
}

/** Every key name under `prefix` in a KV namespace (read-only; pages through the cursor). */
export async function kvListKeys(cf: CfClient, namespaceId: string, prefix: string): Promise<string[]> {
	const fetchRaw = rawFetcher(cf);
	const names: string[] = [];
	let cursor = '';
	do {
		const query = new URLSearchParams({ limit: '1000', prefix });
		if (cursor) query.set('cursor', cursor);
		const path = `/storage/kv/namespaces/${namespaceId}/keys?${query}`;
		const res = await fetchRaw('GET', path);
		const json = (await res.json().catch(() => ({}))) as { result?: { name: string }[]; result_info?: { cursor?: string } };
		if (!res.ok || !json.result) throw new CfApiError(res.status, `GET ${path.split('?')[0]} -> ${res.status}`);
		names.push(...json.result.map((k) => k.name));
		cursor = json.result_info?.cursor ?? '';
	} while (cursor);
	return names;
}

/** A KV value parsed as JSON, or undefined when the key does not exist (read-only). */
export async function kvGetJson(cf: CfClient, namespaceId: string, key: string): Promise<unknown> {
	const path = `/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
	const res = await rawFetcher(cf)('GET', path);
	if (res.status === 404) return undefined;
	if (!res.ok) throw new CfApiError(res.status, `GET ${path.split('/values/')[0]}/values/... -> ${res.status}`);
	return JSON.parse(await res.text());
}
