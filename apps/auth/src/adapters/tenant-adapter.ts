/**
 * @fileoverview D1 Tenant Adapter for OpenAuth Enterprise
 *
 * This adapter wraps our D1-based TenantService to implement the
 * TenantService interface expected by OpenAuth's createMultiTenantIssuer.
 *
 * Updated to work with OpenAuth's schema (002_add_tenant_support.sql):
 * - tenants: id, domain, name, status, branding (JSON), settings (JSON), created_at, updated_at
 * - Timestamps stored as INTEGER (Unix epoch ms)
 */

import type { D1Database } from '@cloudflare/workers-types';
import { TenantService as D1TenantService } from '../services/tenant.service';
import { cachedTenant } from '../services/tenant-cache';
import type { Tenant as D1Tenant } from '../types/tenant';
import type { Theme, ColorScheme } from '@al-ummah-now/openauth/ui/theme';
import type {
	TenantBranding,
	TenantSettings,
	TenantStatus,
	Tenant as OpenAuthTenant,
	TenantService as OpenAuthTenantService,
} from '@al-ummah-now/openauth/contracts/types';

/**
 * Convert ISO string timestamp to Unix timestamp (seconds)
 */
function isoToUnix(isoString: string): number {
	return Math.floor(new Date(isoString).getTime() / 1000);
}

/**
 * D1 Tenant Adapter implementing OpenAuth's TenantService interface
 */
export class D1TenantAdapter implements OpenAuthTenantService {
	private tenantService: D1TenantService;

	constructor(private db: D1Database) {
		this.tenantService = new D1TenantService(db);
	}

	/**
	 * Helper to extract string value from Theme color (handles string | ColorScheme)
	 */
	private extractColorValue(value: string | ColorScheme | undefined, mode: 'light' | 'dark' = 'light'): string | undefined {
		if (!value) return undefined;
		if (typeof value === 'string') return value;
		return value[mode];
	}

	/**
	 * Create a new tenant
	 */
	async createTenant(params: {
		id: string;
		name: string;
		domain?: string;
		branding?: TenantBranding;
		settings?: TenantSettings;
	}): Promise<OpenAuthTenant> {
		const theme = params.branding?.theme;

		const d1Tenant = await this.tenantService.createTenant({
			id: params.id, // Use provided ID directly
			name: params.name,
			domain: params.domain,
			branding: theme
				? {
						logoUrl: this.extractColorValue(theme.logo),
						faviconUrl: theme.favicon,
						primaryColor: this.extractColorValue(theme.primary),
						backgroundColor: this.extractColorValue(theme.background),
						fontFamily: theme.font?.family,
					}
				: undefined,
			settings: params.settings
				? {
						// Map OpenAuth settings to D1 settings
						maxAccountsPerBrowser: params.settings.maxAccountsPerSession,
						sessionLifetimeDays: params.settings.sessionLifetime
							? Math.ceil(params.settings.sessionLifetime / (24 * 60 * 60))
							: undefined,
						requireMfa: params.settings.mfaRequired,
					}
				: undefined,
		});

		return this.mapToOpenAuthTenant(d1Tenant);
	}

	/**
	 * Get a tenant by ID
	 */
	async getTenant(tenantId: string): Promise<OpenAuthTenant | null> {
		return cachedTenant(`id:${tenantId}`, async () => {
			const d1Tenant = await this.tenantService.getTenantById(tenantId);
			return d1Tenant ? this.mapToOpenAuthTenant(d1Tenant) : null;
		});
	}

	/**
	 * Get a tenant by domain
	 */
	async getTenantByDomain(domain: string): Promise<OpenAuthTenant | null> {
		return cachedTenant(`domain:${domain}`, async () => {
			const d1Tenant = await this.tenantService.resolveTenantByDomain(domain);
			return d1Tenant ? this.mapToOpenAuthTenant(d1Tenant) : null;
		});
	}

	/**
	 * Update a tenant
	 */
	async updateTenant(tenantId: string, updates: Partial<OpenAuthTenant>): Promise<OpenAuthTenant> {
		const updateParams: Parameters<typeof this.tenantService.updateTenant>[1] = {};

		if (updates.name !== undefined) {
			updateParams.name = updates.name;
		}

		if (updates.domain !== undefined) {
			updateParams.domain = updates.domain;
		}

		if (updates.status !== undefined) {
			// Map OpenAuth status to our status
			if (updates.status === 'active' || updates.status === 'suspended') {
				updateParams.status = updates.status;
			}
		}

		if (updates.branding !== undefined) {
			const theme = updates.branding.theme;
			updateParams.branding = {
				logoUrl: this.extractColorValue(theme?.logo),
				faviconUrl: theme?.favicon,
				primaryColor: this.extractColorValue(theme?.primary),
				backgroundColor: this.extractColorValue(theme?.background),
				fontFamily: theme?.font?.family,
			};
		}

		if (updates.settings !== undefined) {
			updateParams.settings = {
				// Map OpenAuth settings to D1 settings
				maxAccountsPerBrowser: updates.settings.maxAccountsPerSession,
				sessionLifetimeDays: updates.settings.sessionLifetime
					? Math.ceil(updates.settings.sessionLifetime / (24 * 60 * 60))
					: undefined,
				requireMfa: updates.settings.mfaRequired,
			};
		}

		const d1Tenant = await this.tenantService.updateTenant(tenantId, updateParams);

		return this.mapToOpenAuthTenant(d1Tenant);
	}

	/**
	 * Delete a tenant (soft delete)
	 */
	async deleteTenant(tenantId: string): Promise<void> {
		await this.tenantService.deleteTenant(tenantId);
	}

	/**
	 * List tenants
	 */
	async listTenants(params?: {
		status?: TenantStatus;
		limit?: number;
		offset?: number;
	}): Promise<OpenAuthTenant[]> {
		// Map OpenAuth status to our status type
		const status = params?.status as 'active' | 'suspended' | 'deleted' | undefined;

		const { tenants } = await this.tenantService.listTenants({
			status,
			limit: params?.limit,
			offset: params?.offset,
		});

		return tenants.map((t) => this.mapToOpenAuthTenant(t));
	}

	/**
	 * Map our D1 Tenant to OpenAuth's Tenant format (NEW theme format from ui/theme.d.ts)
	 *
	 * IMPORTANT: Only sets branding.theme if tenant has explicit custom branding
	 * (logo or favicon). This allows config theme to be used as fallback when
	 * tenant doesn't have explicit branding. Without this, tenants with just
	 * primary/background colors would override the config theme's logo.
	 */
	private mapToOpenAuthTenant(tenant: D1Tenant): OpenAuthTenant {
		// Build theme object using the NEW Theme format
		const theme: Partial<Theme> = {
			title: tenant.name,
		};

		if (tenant.primaryColor) {
			theme.primary = tenant.primaryColor;
		}
		if (tenant.backgroundColor) {
			theme.background = tenant.backgroundColor;
		}
		if (tenant.logoUrl) {
			theme.logo = tenant.logoUrl;
		}
		if (tenant.faviconUrl) {
			theme.favicon = tenant.faviconUrl;
		}
		if (tenant.fontFamily) {
			theme.font = { family: tenant.fontFamily };
		}

		// Only set branding.theme if tenant has EXPLICIT custom branding (logo or favicon).
		// This allows config theme (with logo) to be used as fallback.
		// Without this check, tenants with only default colors would override config theme.
		const hasExplicitBranding = tenant.logoUrl || tenant.faviconUrl;

		return {
			id: tenant.id,
			name: tenant.name,
			domain: tenant.domain || undefined,
			status: tenant.status as TenantStatus,
			branding: {
				theme: hasExplicitBranding && Object.keys(theme).length > 1 ? theme : undefined,
			},
			settings: {
				// Map D1 settings to OpenAuth settings
				maxAccountsPerSession: tenant.settings?.maxAccountsPerBrowser,
				sessionLifetime: tenant.settings?.sessionLifetimeDays
					? tenant.settings.sessionLifetimeDays * 24 * 60 * 60
					: undefined,
				mfaRequired: tenant.settings?.requireMfa,
			},
			created_at: isoToUnix(tenant.createdAt),
			updated_at: isoToUnix(tenant.updatedAt),
		};
	}
}
