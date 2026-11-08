/**
 * Host → tenant map for the multi-tenant issuer.
 *
 * The deployment's own issuer host (OPENAUTH_ISSUER) always resolves to the
 * default tenant, so a new environment (e.g. auth.stage.alummahnow.net) works
 * without a code change. The fixed entries keep local dev and existing hosts.
 */
export function tenantCustomDomains(issuer: string | undefined): Map<string, string> {
	const domains = new Map<string, string>([
		['localhost', 'default'],
		['127.0.0.1', 'default'],
		['auth.alummahnow.net', 'default'],
		['auth.qa.alummahnow.net', 'default'],
	]);
	if (issuer) {
		try {
			domains.set(new URL(issuer).hostname, 'default');
		} catch {
			// A malformed issuer is reported by /health?deep=1 (config check); keep the fixed map.
		}
	}
	return domains;
}
