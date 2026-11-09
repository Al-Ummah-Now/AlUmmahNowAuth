// Type for Cloudflare Secrets Store binding
interface SecretsStoreBinding {
  get(): Promise<string>;
}

// Union type for secrets that can be either a plain string (local dev) or Secrets Store binding (production)
type SecretBinding = string | SecretsStoreBinding;

// Declare Env bindings globally to work with declare global pattern in other files
// Type for Cloudflare Analytics Engine
interface AnalyticsEngineDataset {
  writeDataPoint(data: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}

declare global {
  interface Env {
    AUTH_STORAGE: KVNamespace;
    /** Token revocation list shared with the resource servers (u:<usr_id>). */
    TOKEN_REVOCATIONS?: KVNamespace;
    AUDIT_WEBHOOK_URL: string;
    AUDIT_WEBHOOK_SECRET: string;
    PROFILE_APP_URL: string;
    ADMIN_API_URL?: string;
    /** Where the "Start sign-in again" page links when the sign-in's app is unknown. */
    SIGN_IN_FALLBACK_URL?: string;
    /** Comma-separated app logout URLs walked on single sign-out */
    FRONTCHANNEL_LOGOUT_URLS?: string;
    /** "enforce" | "report": check /authorize against oauth_clients */
    CLIENT_REGISTRY_MODE?: string;
    PREVIEW_WEB_CLIENT_ID?: string;
    PREVIEW_WORKERS_SUBDOMAIN?: string;
    PROFILE_CLIENT_ID?: string;
    RESEND_API_KEY: SecretBinding;
    ALLOWED_ORIGINS: string;
    OPENAUTH_ISSUER: string;
    AUTH_DB: D1Database;
    AUDIT_QUEUE: Queue;
    AUTH_ANALYTICS?: AnalyticsEngineDataset;
    TEST_PROMOTE_SECRET?: string;
    ACCESS_TOKEN_EXPIRY?: number;
    /**
     * Access-token lifetime in seconds (#437), e.g. "900". Unset: the issuer
     * default (30 days). Existing sessions are capped on their next refresh.
     */
    ACCESS_TOKEN_TTL?: string;
    REFRESH_TOKEN_EXPIRY?: number;
    // Environment identifier: "production", "qa", or "development"
    ENVIRONMENT?: string;
    // 64-character hex string (32 bytes) for encrypting browser session cookies
    SESSION_SECRET?: string;
    /** Workers Rate Limiting: POST /password/* per client IP (AU-2) */
    PASSWORD_IP_LIMITER?: RateLimit;
    /** Workers Rate Limiting: POST /password/* per email (AU-2) */
    PASSWORD_EMAIL_LIMITER?: RateLimit;
    /** Workers Rate Limiting (AU-1): /token per user (refresh) or per client IP */
    TOKEN_LIMITER?: RateLimit;
    /** Workers Rate Limiting (AU-1): /token per client for our own server-side apps */
    TOKEN_CLIENT_LIMITER?: RateLimit;
    /** Workers Rate Limiting (AU-1): verification emails per client IP (per address for E2E) */
    SEND_CODE_LIMITER?: RateLimit;
    /** Workers Rate Limiting (AU-1): admin API per admin */
    ADMIN_LIMITER?: RateLimit;
    /** Workers Rate Limiting (AU-1): destructive admin actions per admin */
    ADMIN_SENSITIVE_LIMITER?: RateLimit;
  }
}

export {};
