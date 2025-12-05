/**
 * Tenant Types and Interfaces
 *
 * Type definitions for multi-tenant support, including tenant management,
 * branding customization, and tenant-scoped configuration.
 *
 * @module types/tenant
 */

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  status: 'active' | 'suspended' | 'deleted';

  // Branding
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  backgroundColor: string;
  fontFamily: string;

  // Email
  emailFromName: string | null;
  emailFromAddress: string | null;
  emailReplyTo: string | null;

  // Settings
  settings: TenantSettings;

  // Metadata
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;

  // Limits
  maxUsers: number;
  maxClients: number;
  maxSessionsPerUser: number;
}

export interface TenantSettings {
  // Authentication
  allowPasswordAuth?: boolean;
  allowSocialAuth?: boolean;
  allowEmailAuth?: boolean;
  requireMfa?: boolean;
  mfaMethods?: ('totp' | 'sms' | 'email')[];

  // Session
  sessionLifetimeDays?: number;
  maxAccountsPerBrowser?: number;

  // Security
  passwordPolicy?: {
    minLength: number;
    requireUppercase: boolean;
    requireNumbers: boolean;
    requireSymbols: boolean;
  };

  // Features
  features?: {
    multiAccountSessions: boolean;
    sso: boolean;
    auditLogs: boolean;
  };
}

export interface TenantBranding {
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  backgroundColor: string;
  fontFamily: string;
  customCss?: string;
}

export interface TenantAdmin {
  id: string;
  tenantId: string;
  userId: string;
  role: 'owner' | 'admin' | 'viewer';
  grantedAt: string;
  grantedBy: string | null;
  user?: {
    email: string;
    name?: string;
  };
}

export interface TenantContext {
  tenant: Tenant;
  branding: TenantBranding;
  isDefault: boolean;
}

export const DEFAULT_TENANT_ID = 'default';
