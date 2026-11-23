/**
 * Which accounts on the E2E domain are kept, and which look disposable (#312, AUTH-R6 R6-8).
 * Used by the dry run only (routes/test-run-users.ts): nothing here deletes anything, and what
 * may be deleted is still decided by the run marker alone.
 *
 * Anything not recognised is kept. The kept addresses were collected from the specs, seeds and
 * scripts of every repository on 2026-11-23.
 */
import { isRunUserEmail } from './e2e-sink';

export const E2E_DOMAIN = '@e2e.alummahnow.net';

/** Seeded or shared accounts, by the part before the @. */
const KEPT_NAMES: ReadonlySet<string> = new Set([
	// Seeded QA accounts (every repository)
	'qa-superadmin',
	'qa-admin',
	'qa-moderator',
	'qa-creator',
	'qa-viewer',
	// CMS single sign-on specs
	'qa-sso-cms',
	// AlUmmahNow contact form specs, Auth fixtures
	'contact-test',
	'prod-check',
]);

/** AlUmmahNow's pinned CI users: scripts/qa/e2e-leftovers.ts PINNED_E2E_USER_TIMESTAMPS. */
const PINNED = /^test-(single|multi|none|scratch)-179500000000[1-5]$/;

/** <prefix>-<ms timestamp>-<random>: e2e/utils/test-data.ts legacyTestEmail, and the release and probe suites. */
const DISPOSABLE = /^[a-z0-9][a-z0-9-]*-1[789]\d{11}-[a-z0-9]{1,16}$/;
/** <prefix>-<ms timestamp>: AlUmmahNow's per-run users before the run accounts. */
const DISPOSABLE_USER = /^test-(single|multi|none|scratch)-1[789]\d{11}$/;

export type E2EAccountKind = 'run' | 'kept' | 'disposable' | 'other' | 'outside';

export function e2eAccountKind(email: string): E2EAccountKind {
	const e = email.trim().toLowerCase();
	if (!e.endsWith(E2E_DOMAIN)) return 'outside';
	if (isRunUserEmail(e)) return 'run';
	const name = e.slice(0, -E2E_DOMAIN.length);
	if (KEPT_NAMES.has(name) || PINNED.test(name)) return 'kept';
	if (DISPOSABLE.test(name) || DISPOSABLE_USER.test(name)) return 'disposable';
	return 'other';
}
