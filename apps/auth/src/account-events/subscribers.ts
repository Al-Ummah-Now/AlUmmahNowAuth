/**
 * The clients that subscribe to account events: `oauth_clients.metadata.events`
 * = { "uri": "https://…", "types": [...] }. Only an enabled confidential machine
 * client with the scope account-events:receive counts (docs/account-hub/SPEC.md §5.4).
 */
import { ACCOUNT_EVENT_TYPES, type AccountEventType } from './types';

export const RECEIVE_SCOPE = 'account-events:receive';
export const EXPORT_SCOPE = 'account-exports:write';

export interface Subscriber {
	clientId: string;
	uri: string;
	types: AccountEventType[];
}

interface ClientRow {
	id: string;
	client_secret_hash: string | null;
	grant_types: string | null;
	scopes: string | null;
	metadata: string | null;
	enabled: number | null;
}

const COLUMNS = 'id, client_secret_hash, grant_types, scopes, metadata, enabled';
// The same expression as idx_oauth_clients_events, so the planner uses it
const SUBSCRIBERS_SQL = `SELECT ${COLUMNS} FROM oauth_clients INDEXED BY idx_oauth_clients_events WHERE instr(metadata, '"events"') > 0`;
const CLIENT_SQL = `SELECT ${COLUMNS} FROM oauth_clients WHERE id = ?1`;

function parse(json: string | null): unknown {
	try {
		return JSON.parse(json ?? 'null');
	} catch {
		return null;
	}
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/** An https address with a host name: no IP address, port, credentials or fragment. */
export function isDeliverable(uri: unknown): uri is string {
	if (typeof uri !== 'string' || uri.length > 500) return false;
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return false;
	}
	return (
		url.protocol === 'https:' &&
		!url.port &&
		!url.username &&
		!url.password &&
		!url.hash &&
		// a dotted name whose last label is letters: no address, no single-label host, no trailing dot
		/^(?:[a-z0-9-]+\.)+[a-z][a-z-]*$/.test(url.hostname) &&
		!/(?:^|\.)(?:localhost|local|internal|arpa)$/.test(url.hostname)
	);
}

export function subscriberOf(row: ClientRow | null): Subscriber | null {
	if (!row || row.enabled !== 1 || !row.client_secret_hash) return null;
	if (!strings(parse(row.grant_types)).includes('client_credentials')) return null;
	const scopes = strings(parse(row.scopes));
	if (!scopes.includes(RECEIVE_SCOPE)) return null;
	const metadata = parse(row.metadata) as { events?: { uri?: unknown; types?: unknown }; exportPart?: unknown } | null;
	const uri = metadata?.events?.uri;
	if (!isDeliverable(uri)) return null;
	const wanted = strings(metadata?.events?.types);
	const canExport = scopes.includes(EXPORT_SCOPE) && typeof metadata?.exportPart === 'string' && metadata.exportPart !== '';
	const types = ACCOUNT_EVENT_TYPES.filter((t) => wanted.includes(t) && (t !== 'account-export-requested' || canExport));
	return types.length ? { clientId: row.id, uri, types } : null;
}

export async function subscribers(db: D1Database): Promise<Subscriber[]> {
	const { results } = await db.prepare(SUBSCRIBERS_SQL).all<ClientRow>();
	return results.map(subscriberOf).filter((s): s is Subscriber => s !== null);
}

export async function subscriber(db: D1Database, clientId: string): Promise<Subscriber | null> {
	return subscriberOf(await db.prepare(CLIENT_SQL).bind(clientId).first<ClientRow>());
}
