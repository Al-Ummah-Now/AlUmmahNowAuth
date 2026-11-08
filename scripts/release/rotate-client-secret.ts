/**
 * Rotates an OAuth client secret and hands the new value to its consumers,
 * without the secret ever being printed or written to disk.
 *
 *   node --experimental-strip-types scripts/release/rotate-client-secret.ts \
 *     --db <d1-database-uuid> --client <oauth_clients.id> \
 *     --worker <script>:<SECRET_NAME> [--worker ...] \
 *     [--gh-secret <owner/repo>:<NAME> ...] \
 *     [--token-url https://auth.example/token --scope "admin:users admin:roles"] \
 *     [--probe /admin/users --acting-user <admin user id>] \
 *     [--grace 3600] [--dry-run]
 *
 * Mirrors ClientD1Adapter.rotateSecret in @al-ummah-now/openauth: a 32-byte
 * base64url secret, stored as `$pbkdf2-sha256$100000$<salt>$<hash>` with a
 * random per-secret salt (CLIENT_SECRET_SALT is not involved). The old hash
 * stays valid as previous_secret_hash for --grace seconds, so consumers you
 * have not updated yet keep working while you roll the new value out.
 *
 * List EVERY consumer of the client's secret (workers and CI secrets) before
 * running this: anything you leave out stops authenticating once the grace
 * period ends.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createCfClient, d1Query, type CfClient } from './cf-api.ts';

const SECRET_BYTES = 32;
const SALT_BYTES = 16;
const PBKDF2_ITERATIONS = 100_000;

function toBase64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateClientSecret(): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

async function pbkdf2(secret: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
	return new Uint8Array(bits);
}

/** Same output format as hashClientSecret() in @al-ummah-now/openauth. */
export async function hashClientSecret(secret: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const hash = await pbkdf2(secret, salt, PBKDF2_ITERATIONS);
	return `$pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

/** Same check as verifyClientSecret() in @al-ummah-now/openauth. */
export async function verifyClientSecret(secret: string, stored: string): Promise<boolean> {
	const parts = stored.split('$');
	if (parts.length !== 5 || parts[1] !== 'pbkdf2-sha256') return false;
	const salt = Buffer.from(parts[3], 'base64url');
	const expected = Buffer.from(parts[4], 'base64url');
	const actual = await pbkdf2(secret, new Uint8Array(salt), parseInt(parts[2], 10));
	return actual.length === expected.length && actual.every((b, i) => b === expected[i]);
}

interface Target {
	kind: 'worker' | 'gh';
	scope: string; // worker script name, or owner/repo
	name: string; // secret name
}

export interface RotateArgs {
	db: string;
	client: string;
	grace: number;
	targets: Target[];
	tokenUrl?: string;
	scope?: string;
	probes: string[];
	actingUser?: string;
	dryRun: boolean;
}

export function parseArgs(argv: string[]): RotateArgs {
	const args: RotateArgs = { db: '', client: '', grace: 3600, targets: [], probes: [], dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${flag} needs a value`);
			return v;
		};
		const target = (kind: Target['kind']) => {
			const v = value();
			const at = v.lastIndexOf(':');
			if (at <= 0 || at === v.length - 1) throw new Error(`${flag} expects <scope>:<SECRET_NAME>, got "${v}"`);
			args.targets.push({ kind, scope: v.slice(0, at), name: v.slice(at + 1) });
		};
		switch (flag) {
			case '--db': args.db = value(); break;
			case '--client': args.client = value(); break;
			case '--grace': args.grace = Number(value()); break;
			case '--worker': target('worker'); break;
			case '--gh-secret': target('gh'); break;
			case '--token-url': args.tokenUrl = value(); break;
			case '--scope': args.scope = value(); break;
			case '--probe': args.probes.push(value()); break;
			case '--acting-user': args.actingUser = value(); break;
			case '--dry-run': args.dryRun = true; break;
			default: throw new Error(`Unknown flag ${flag}`);
		}
	}
	if (!args.db || !args.client) throw new Error('--db and --client are required');
	if (!Number.isFinite(args.grace) || args.grace < 0) throw new Error('--grace must be a number of seconds');
	if (args.probes.length > 0 && !args.tokenUrl) throw new Error('--probe needs --token-url');
	if (args.targets.length === 0) throw new Error('Name at least one consumer with --worker or --gh-secret');
	return args;
}

async function putWorkerSecret(cf: CfClient, script: string, name: string, text: string): Promise<void> {
	await cf.request('PUT', `/workers/scripts/${script}/secrets`, { name, text, type: 'secret_text' });
}

function putGhSecret(repo: string, name: string, text: string): void {
	const res = spawnSync('gh', ['secret', 'set', name, '--repo', repo], { input: text, stdio: ['pipe', 'ignore', 'pipe'] });
	if (res.status !== 0) throw new Error(`gh secret set ${name} --repo ${repo} failed: ${res.stderr?.toString().trim()}`);
}

async function fetchToken(tokenUrl: string, clientId: string, secret: string, scope?: string): Promise<{ status: number; token?: string }> {
	const url = new URL(tokenUrl);
	const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret });
	if (scope) body.set('scope', scope);
	const res = await fetch(tokenUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'X-Forwarded-Host': url.host,
			'X-Forwarded-Proto': url.protocol.replace(':', ''),
		},
		body,
	});
	const json = (await res.json().catch(() => ({}))) as { access_token?: string };
	return { status: res.status, token: res.ok ? json.access_token : undefined };
}

/** GETs `path` on the token's issuer with the M2M token; reports status and item count only. */
async function probe(tokenUrl: string, path: string, token: string, actingUser?: string): Promise<string> {
	const url = new URL(path, tokenUrl);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		'X-Forwarded-Host': url.host,
		'X-Forwarded-Proto': url.protocol.replace(':', ''),
	};
	if (actingUser) headers['X-Acting-User-Id'] = actingUser;
	const res = await fetch(url, { headers });
	const body = (await res.json().catch(() => null)) as unknown;
	const list = Array.isArray(body)
		? body
		: body && typeof body === 'object'
			? Object.values(body as Record<string, unknown>).find(Array.isArray)
			: undefined;
	if (!res.ok) throw new Error(`probe GET ${url.pathname} -> HTTP ${res.status}`);
	return `GET ${url.pathname} -> ${res.status}${list ? `, ${list.length} item(s)` : ''}`;
}

export async function rotate(args: RotateArgs, cf: CfClient = createCfClient()): Promise<void> {
	const [client] = await d1Query<{ id: string; name: string; enabled: number; client_secret_hash: string | null }>(
		cf,
		args.db,
		'SELECT id, name, enabled, client_secret_hash FROM oauth_clients WHERE id = ?',
		[args.client]
	);
	if (!client) throw new Error(`Client ${args.client} not found in D1 ${args.db}`);
	if (!client.enabled) throw new Error(`Client ${args.client} (${client.name}) is disabled`);
	const consumers = args.targets.map((t) => `${t.kind}:${t.scope}:${t.name}`).join(', ');
	console.log(`Client ${client.id} "${client.name}" -> consumers: ${consumers}`);
	if (args.dryRun) {
		console.log('Dry run: nothing changed.');
		return;
	}

	const secret = generateClientSecret();
	const hash = await hashClientSecret(secret);
	if (!(await verifyClientSecret(secret, hash))) throw new Error('Self-check of the new hash failed');

	const now = Date.now();
	await d1Query(
		cf,
		args.db,
		`UPDATE oauth_clients SET client_secret_hash = ?, previous_secret_hash = ?, previous_secret_expires_at = ?,
		   rotated_at = ?, updated_at = ? WHERE id = ? AND client_secret_hash IS ?`,
		[hash, client.client_secret_hash, now + args.grace * 1000, now, now, client.id, client.client_secret_hash]
	);
	const [after] = await d1Query<{ client_secret_hash: string }>(cf, args.db, 'SELECT client_secret_hash FROM oauth_clients WHERE id = ?', [client.id]);
	if (after?.client_secret_hash !== hash) throw new Error('D1 update did not apply (concurrent rotation?). Consumers were not changed.');
	console.log(`D1: new hash stored; previous secret valid for ${args.grace}s.`);

	for (const t of args.targets) {
		if (t.kind === 'worker') await putWorkerSecret(cf, t.scope, t.name, secret);
		else putGhSecret(t.scope, t.name, secret);
		console.log(`Set ${t.name} on ${t.kind === 'worker' ? 'worker' : 'GitHub repo'} ${t.scope}`);
	}

	if (args.tokenUrl) {
		const { status, token } = await fetchToken(args.tokenUrl, client.id, secret, args.scope);
		if (!token) throw new Error(`client_credentials with the new secret returned HTTP ${status}`);
		console.log(`Verified: client_credentials at ${args.tokenUrl} -> ${status} with access_token.`);
		for (const path of args.probes) console.log(`Probe: ${await probe(args.tokenUrl, path, token, args.actingUser)}`);
	}
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
	try {
		await rotate(parseArgs(process.argv.slice(2)));
	} catch (error) {
		console.error(`rotate-client-secret: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
