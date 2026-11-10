/**
 * Guard: an E2E file that ends sessions must never touch a SHARED account.
 *
 * A global sign-out, token revoke, password reset/change, role change or session
 * termination ends every session of that account, in every app and every other
 * suite (or run) signed in to it. So a file under e2e/ that does any of those must
 * sign in only to accounts it creates itself (generateTestEmail / TEST_USERS, the
 * per-run e2e+<run>-<attempt>-<name>@e2e.alummahnow.net accounts in CI).
 *
 * Checked per file (stricter than per test): if the file has a session-ending
 * action AND references a shared account, it is flagged. Shared accounts are the
 * seeded QA/stage accounts (qa-superadmin|admin|moderator|creator|viewer@...),
 * fixed users read from the environment (process.env.*EMAIL* / *USER*), and any
 * literal address other than the reserved example.com/.org/.net domains.
 * Run by scripts/__tests__/e2e-shared-accounts.test.ts (pnpm test:scripts in CI).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Actions that end sessions of the signed-in account. */
export const SESSION_ENDING: Array<[string, RegExp]> = [
	['sign-out', /\blogout\b|\/logout|sign[-_ ]?out|signout/i],
	['token revoke', /\brevoke/i],
	['password reset/change', /forgot[-_ ]?password|reset[-_ ]?code|requestReset|change[-_ ]?password|NEW_TEST_PASSWORD/i],
	['role change', /\/test\/promote|editUser\(|role[-_ ]?change|assignRole/i],
	['session termination', /terminate|revoke_sessions|suspend_account|end[-_ ]?session/i],
];

/** References to accounts shared between specs or runs. */
export const SHARED_ACCOUNT: Array<[string, RegExp]> = [
	['seeded QA/stage account', /\bqa-(?:superadmin|admin|moderator|creator|viewer)@/i],
	['fixed user from the environment', /process\.env\.[A-Z0-9_]*(?:EMAIL|USER)[A-Z0-9_]*/],
	['fixed email address', /['"`][A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+['"`]/],
];

export interface Finding {
	file: string;
	sessionEnding: string;
	shared: string;
	match: string;
}

/** Comments are stripped first so documentation never trips the guard. */
function code(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

export function checkSource(file: string, source: string): Finding[] {
	const text = code(source);
	const ending = SESSION_ENDING.find(([, re]) => re.test(text));
	if (!ending) return [];
	return SHARED_ACCOUNT.flatMap(([shared, re]) => {
		const m = text.match(re);
		return m ? [{ file, sessionEnding: ending[0], shared, match: m[0] }] : [];
	});
}

function tsFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : tsFiles(path);
		return name.endsWith('.ts') ? [path] : [];
	});
}

/** Every spec and fixture under e2e/ (fixtures do the signing in for the specs). */
export function checkE2eDir(root: string): Finding[] {
	return tsFiles(join(root, 'e2e')).flatMap((path) => checkSource(relative(root, path), readFileSync(path, 'utf8')));
}
