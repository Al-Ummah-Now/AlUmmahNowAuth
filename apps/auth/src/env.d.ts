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
    AUDIT_WEBHOOK_URL: string;
    AUDIT_WEBHOOK_SECRET: string;
    PROFILE_APP_URL: string;
    PROFILE_CLIENT_ID?: string;
    RESEND_API_KEY: SecretBinding;
    ALLOWED_ORIGINS: string;
    OPENAUTH_ISSUER: string;
    AUTH_DB: D1Database;
    AUDIT_QUEUE: Queue;
    AUDIT_ARCHIVE?: R2Bucket;
    AUTH_ANALYTICS?: AnalyticsEngineDataset;
    TEST_PROMOTE_SECRET?: string;
    ACCESS_TOKEN_EXPIRY?: number;
    REFRESH_TOKEN_EXPIRY?: number;
    // Environment identifier: "production", "qa", or "development"
    ENVIRONMENT?: string;
    // 64-character hex string (32 bytes) for encrypting browser session cookies
    SESSION_SECRET?: string;
  }
}

export {};
