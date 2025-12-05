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
import type { Tenant as D1Tenant } from '../types/tenant';

// OpenAuth contract types (defined locally to avoid module resolution issues)
type TenantStatus = 'active' | 'suspended' | 'pending' | 'deleted';

interface OpenAuthTheme {
	primary?: string;
	secondary?: string;
	background?: string;
	text?: string;
	logo?: string;
	fontFamily?: string;
}

interface OpenAuthTenantBranding {
	theme?: Partial<OpenAuthTheme>;
	logoLight?: string;
	logoDark?: string;
	favicon?: string;
	customCss?: string;
}

interface OpenAuthTenantSettings {
	maxAccountsPerSession?: number;
	sessionLifetime?: number;
	allowPublicRegistration?: boolean;
	requireEmailVerification?: boolean;
	allowedProviders?: string[];
	mfaRequired?: boolean;
}

interface OpenAuthTenant {
	id: string;
	domain?: string;
	name: string;
	status: TenantStatus;
	branding: OpenAuthTenantBranding;
	settings: OpenAuthTenantSettings;
	created_at: number;
	updated_at: number;
}

interface OpenAuthTenantService {
	createTenant(params: {
		id: string;
		name: string;
		domain?: string;
		branding?: OpenAuthTenantBranding;
		settings?: OpenAuthTenantSettings;
	}): Promise<OpenAuthTenant>;
	getTenant(tenantId: string): Promise<OpenAuthTenant | null>;
	getTenantByDomain(domain: string): Promise<OpenAuthTenant | null>;
	updateTenant(tenantId: string, updates: Partial<OpenAuthTenant>): Promise<OpenAuthTenant>;
	deleteTenant(tenantId: string): Promise<void>;
	listTenants(params?: {
		status?: TenantStatus;
		limit?: number;
		offset?: number;
	}): Promise<OpenAuthTenant[]>;
}

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
	 * Create a new tenant
	 */
	async createTenant(params: {
		id: string;
		name: string;
		domain?: string;
		branding?: OpenAuthTenantBranding;
		settings?: OpenAuthTenantSettings;
	}): Promise<OpenAuthTenant> {
		const d1Tenant = await this.tenantService.createTenant({
			id: params.id, // Use provided ID directly
			name: params.name,
			domain: params.domain,
			branding: params.branding
				? {
						logoUrl: params.branding.logoLight,
						faviconUrl: params.branding.favicon,
						primaryColor: params.branding.theme?.primary,
						secondaryColor: params.branding.theme?.secondary,
						backgroundColor: params.branding.theme?.background,
						fontFamily: params.branding.theme?.fontFamily,
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
		const d1Tenant = await this.tenantService.getTenantById(tenantId);

		if (!d1Tenant) return null;

		return this.mapToOpenAuthTenant(d1Tenant);
	}

	/**
	 * Get a tenant by domain
	 */
	async getTenantByDomain(domain: string): Promise<OpenAuthTenant | null> {
		const d1Tenant = await this.tenantService.resolveTenantByDomain(domain);

		if (!d1Tenant) return null;

		return this.mapToOpenAuthTenant(d1Tenant);
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
			updateParams.branding = {
				logoUrl: updates.branding.logoLight,
				faviconUrl: updates.branding.favicon,
				primaryColor: updates.branding.theme?.primary,
				secondaryColor: updates.branding.theme?.secondary,
				backgroundColor: updates.branding.theme?.background,
				fontFamily: updates.branding.theme?.fontFamily,
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
	 * Map our D1 Tenant to OpenAuth's Tenant format
	 */
	private mapToOpenAuthTenant(tenant: D1Tenant): OpenAuthTenant {
		return {
			id: tenant.id,
			name: tenant.name,
			domain: tenant.domain || undefined,
			status: tenant.status as TenantStatus,
			branding: {
				theme: {
					primary: tenant.primaryColor,
					secondary: tenant.secondaryColor,
					background: tenant.backgroundColor,
					fontFamily: tenant.fontFamily,
				},
				logoLight: tenant.logoUrl || undefined,
				favicon: tenant.faviconUrl || undefined,
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
