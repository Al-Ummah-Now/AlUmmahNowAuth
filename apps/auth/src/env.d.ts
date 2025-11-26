// Declare Env bindings globally to work with declare global pattern in other files
declare global {
  interface Env {
    AUTH_STORAGE: KVNamespace;
    AUDIT_WEBHOOK_URL: string;
    AUDIT_WEBHOOK_SECRET: string;
    PROFILE_APP_URL: string;
    RESEND_API_KEY: string;
    ALLOWED_ORIGINS: string;
    OPENAUTH_ISSUER: string;
    AUTH_DB: D1Database;
    AUDIT_QUEUE: Queue;
    TEST_PROMOTE_SECRET?: string;
  }
}

export {};
