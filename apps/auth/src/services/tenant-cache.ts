import type { Tenant } from '@al-ummah-now/openauth/contracts/types';

/**
 * The issuer resolves the tenant on every request (`SELECT * FROM tenants WHERE
 * id = ?`, ~450k reads a day on QA). Tenants change only from the admin API, so
 * each isolate keeps what it read for a minute; a change made through TenantService
 * clears the isolate's copy at once, other isolates see it within the TTL.
 */
const TENANT_TTL_MS = 60_000;
const tenantCache = new Map<string, { at: number; tenant: Tenant | null }>();

export async function cachedTenant(key: string, load: () => Promise<Tenant | null>): Promise<Tenant | null> {
	const hit = tenantCache.get(key);
	if (hit && Date.now() - hit.at < TENANT_TTL_MS) return hit.tenant;
	const tenant = await load();
	if (tenantCache.size > 100) tenantCache.clear();
	tenantCache.set(key, { at: Date.now(), tenant });
	return tenant;
}

/** Forget every cached tenant (after a change, and in tests). */
export function clearTenantCache(): void {
	tenantCache.clear();
}
