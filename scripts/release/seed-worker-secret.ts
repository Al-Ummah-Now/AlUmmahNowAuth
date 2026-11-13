/**
 * Seeds a generated random secret on one or more Workers, without printing it.
 *
 *   node --experimental-strip-types scripts/release/seed-worker-secret.ts \
 *     --worker <script>:<SECRET_NAME> [--worker ...] [--bytes 32] [--format hex|base64url] [--force]
 *
 * Every --worker gets its own value. Refuses to replace a secret that is already
 * set unless --force, because replacing e.g. SESSION_SECRET signs every user out.
 * For OAuth client secrets use rotate-client-secret.ts instead (D1 hash + consumers).
 */
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createCfClient, getWorkerBindings } from './cf-api.ts';

export function generate(bytes: number, format: 'hex' | 'base64url'): string {
	return randomBytes(bytes).toString(format);
}

async function main(argv: string[]): Promise<void> {
	const targets: { script: string; name: string }[] = [];
	let bytes = 32;
	let format: 'hex' | 'base64url' = 'hex';
	let force = false;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === '--worker') {
			const v = argv[++i] ?? '';
			const at = v.lastIndexOf(':');
			if (at <= 0) throw new Error(`--worker expects <script>:<SECRET_NAME>, got "${v}"`);
			targets.push({ script: v.slice(0, at), name: v.slice(at + 1) });
		} else if (flag === '--bytes') bytes = Number(argv[++i]);
		else if (flag === '--format') format = argv[++i] as typeof format;
		else if (flag === '--force') force = true;
		else throw new Error(`Unknown flag ${flag}`);
	}
	if (targets.length === 0) throw new Error('Name at least one --worker <script>:<SECRET_NAME>');
	if (!['hex', 'base64url'].includes(format) || !(bytes >= 16)) throw new Error('--format hex|base64url, --bytes >= 16');

	const cf = createCfClient();
	for (const { script, name } of targets) {
		const bindings = await getWorkerBindings(cf, script);
		if (!bindings) throw new Error(`Worker ${script} does not exist`);
		const existing = bindings.find((b) => b.name === name);
		if (existing && existing.type !== 'secret_text') throw new Error(`${script}: ${name} is bound as ${existing.type}, not a secret`);
		if (existing && !force) {
			console.log(`${script}: ${name} already set; skipped (use --force to replace).`);
			continue;
		}
		await cf.request('PUT', `/workers/scripts/${script}/secrets`, { name, text: generate(bytes, format), type: 'secret_text' });
		console.log(`${script}: ${name} ${existing ? 'replaced' : 'set'} (${bytes} random bytes, ${format}).`);
	}
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(`seed-worker-secret: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
}
