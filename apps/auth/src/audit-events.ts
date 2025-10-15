/**
 * Audit Event Types and Interfaces
 *
 * This module defines the audit event system for tracking security-relevant
 * actions in the authentication server.
 */

/**
 * Enum of all audit event types
 */
export enum AuditEventType {
  // Authentication Events
  LOGIN_SUCCESS = 'auth.login.success',
  LOGIN_FAILED = 'auth.login.failed',
  LOGOUT = 'auth.logout',

  // Token Events
  TOKEN_ISSUED = 'auth.token.issued',
  TOKEN_REFRESH = 'auth.token.refresh',
  TOKEN_REVOKE = 'auth.token.revoke',
  TOKEN_VERIFY_FAILED = 'auth.token.verify_failed',

  // Account Events
  ACCOUNT_CREATED = 'auth.account.created',
  ACCOUNT_UPDATED = 'auth.account.updated',
  ACCOUNT_DELETED = 'auth.account.deleted',

  // Authorization Events
  AUTHORIZATION_GRANTED = 'auth.authorization.granted',
  AUTHORIZATION_DENIED = 'auth.authorization.denied',

  // Security Events
  RATE_LIMIT_EXCEEDED = 'security.rate_limit.exceeded',
  SUSPICIOUS_ACTIVITY = 'security.suspicious_activity',
}

/**
 * Severity levels for audit events
 */
export enum AuditEventSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

/**
 * Base audit event interface
 */
export interface AuditEvent {
  /** ISO 8601 timestamp when the event occurred */
  timestamp: string;

  /** Type of audit event */
  eventType: AuditEventType;

  /** Severity level of the event */
  severity: AuditEventSeverity;

  /** User ID associated with the event (null for unauthenticated events) */
  userId: string | null;

  /** IP address of the client */
  ipAddress: string | null;

  /** User agent string */
  userAgent: string | null;

  /** Unique request ID for tracing */
  requestId: string | null;

  /** Event-specific metadata */
  metadata: Record<string, any>;

  /** Whether the action was successful */
  success: boolean;

  /** Error message if action failed (null for successful actions) */
  errorMessage: string | null;
}

/**
 * Login event metadata
 */
export interface LoginEventMetadata {
  email: string;
  method: 'email_code' | 'oauth' | 'password';
  clientId?: string;
  failureReason?: string;
}

/**
 * Token event metadata
 */
export interface TokenEventMetadata {
  tokenType: 'access' | 'refresh';
  clientId: string;
  grantType?: string;
  expiresIn?: number;
  scopes?: string[];
}

/**
 * Account event metadata
 */
export interface AccountEventMetadata {
  email: string;
  role?: string;
  changedFields?: string[];
  initiatedBy?: string; // userId of admin who made the change
}

/**
 * Authorization event metadata
 */
export interface AuthorizationEventMetadata {
  clientId: string;
  redirectUri: string;
  scopes?: string[];
  denialReason?: string;
}

/**
 * Rate limit event metadata
 */
export interface RateLimitEventMetadata {
  endpoint: string;
  limit: number;
  window: number; // seconds
  retryAfter: number; // seconds
}

/**
 * Helper function to create an audit event
 */
export function createAuditEvent(
  eventType: AuditEventType,
  options: {
    severity: AuditEventSeverity;
    userId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    requestId?: string | null;
    metadata?: Record<string, any>;
    success: boolean;
    errorMessage?: string;
  }
): AuditEvent {
  const metadata = options.metadata ?? {};

  // Validate metadata size (10MB limit)
  const metadataStr = JSON.stringify(metadata);
  const metadataSize = new TextEncoder().encode(metadataStr).length;
  const maxSize = 10 * 1024 * 1024; // 10MB

  if (metadataSize > maxSize) {
    throw new Error(
      `Event metadata too large: ${metadataSize} bytes (max: ${maxSize} bytes). ` +
      `Consider reducing metadata or splitting into multiple events.`
    );
  }

  return {
    timestamp: new Date().toISOString(),
    eventType,
    severity: options.severity,
    userId: options.userId ?? null,
    ipAddress: options.ipAddress ?? null,
    userAgent: options.userAgent ?? null,
    requestId: options.requestId ?? null,
    metadata,
    success: options.success,
    errorMessage: options.errorMessage ?? null,
  };
}

/**
 * Helper functions for creating specific event types
 */

export function createLoginSuccessEvent(
  email: string,
  userId: string,
  options: {
    ipAddress?: string;
    userAgent?: string;
    requestId?: string;
    clientId?: string;
    method?: LoginEventMetadata['method'];
  }
): AuditEvent {
  return createAuditEvent(AuditEventType.LOGIN_SUCCESS, {
    severity: AuditEventSeverity.INFO,
    userId,
    ipAddress: options.ipAddress ?? null,
    userAgent: options.userAgent ?? null,
    requestId: options.requestId ?? null,
    success: true,
    metadata: {
      email,
      method: options.method ?? 'email_code',
      clientId: options.clientId,
    } satisfies LoginEventMetadata,
  });
}

export function createLoginFailedEvent(
  email: string,
  failureReason: string,
  options: {
    ipAddress?: string;
    userAgent?: string;
    requestId?: string;
  }
): AuditEvent {
  return createAuditEvent(AuditEventType.LOGIN_FAILED, {
    severity: AuditEventSeverity.WARNING,
    userId: null,
    ipAddress: options.ipAddress ?? null,
    userAgent: options.userAgent ?? null,
    requestId: options.requestId ?? null,
    success: false,
    errorMessage: failureReason,
    metadata: {
      email,
      method: 'email_code',
      failureReason,
    } satisfies LoginEventMetadata,
  });
}

export function createLogoutEvent(
  userId: string,
  options: {
    ipAddress?: string;
    userAgent?: string;
    requestId?: string;
  }
): AuditEvent {
  return createAuditEvent(AuditEventType.LOGOUT, {
    severity: AuditEventSeverity.INFO,
    userId,
    ipAddress: options.ipAddress ?? null,
    userAgent: options.userAgent ?? null,
    requestId: options.requestId ?? null,
    success: true,
    metadata: {},
  });
}

export function createTokenIssuedEvent(
  userId: string,
  clientId: string,
  options: {
    ipAddress?: string;
    userAgent?: string;
    requestId?: string;
    tokenType?: TokenEventMetadata['tokenType'];
    grantType?: string;
    expiresIn?: number;
  }
): AuditEvent {
  return createAuditEvent(AuditEventType.TOKEN_ISSUED, {
    severity: AuditEventSeverity.INFO,
    userId,
    ipAddress: options.ipAddress ?? null,
    userAgent: options.userAgent ?? null,
    requestId: options.requestId ?? null,
    success: true,
    metadata: {
      tokenType: options.tokenType ?? 'access',
      clientId,
      grantType: options.grantType,
      expiresIn: options.expiresIn,
    } satisfies TokenEventMetadata,
  });
}

export function createTokenRefreshEvent(
  userId: string,
  clientId: string,
  options: {
    ipAddress?: string;
    userAgent?: string;
    requestId?: string;
    expiresIn?: number;
  }
): AuditEvent {
  return createAuditEvent(AuditEventType.TOKEN_REFRESH, {
    severity: AuditEventSeverity.INFO,
    userId,
    ipAddress: options.ipAddress ?? null,
    userAgent: options.userAgent ?? null,
    requestId: options.requestId ?? null,
    success: true,
    metadata: {
      tokenType: 'refresh',
      clientId,
      grantType: 'refresh_token',
      expiresIn: options.expiresIn,
    } satisfies TokenEventMetadata,
  });
}

export function createRateLimitExceededEvent(
  endpoint: string,
  limit: number,
  window: number,
  retryAfter: number,
  options: {
    ipAddress?: string;
    userAgent?: string;
    requestId?: string;
    userId?: string;
  }
): AuditEvent {
  return createAuditEvent(AuditEventType.RATE_LIMIT_EXCEEDED, {
    severity: AuditEventSeverity.WARNING,
    userId: options.userId ?? null,
    ipAddress: options.ipAddress ?? null,
    userAgent: options.userAgent ?? null,
    requestId: options.requestId ?? null,
    success: false,
    errorMessage: `Rate limit exceeded for ${endpoint}`,
    metadata: {
      endpoint,
      limit,
      window,
      retryAfter,
    } satisfies RateLimitEventMetadata,
  });
}

export function createAccountCreatedEvent(
  userId: string,
  email: string,
  role: string,
  options: {
    ipAddress?: string;
    userAgent?: string;
    requestId?: string;
    initiatedBy?: string;
  }
): AuditEvent {
  return createAuditEvent(AuditEventType.ACCOUNT_CREATED, {
    severity: AuditEventSeverity.INFO,
    userId,
    ipAddress: options.ipAddress ?? null,
    userAgent: options.userAgent ?? null,
    requestId: options.requestId ?? null,
    success: true,
    metadata: {
      email,
      role,
      initiatedBy: options.initiatedBy,
    } satisfies AccountEventMetadata,
  });
}

export function createAccountUpdatedEvent(
  userId: string,
  email: string,
  changedFields: string[],
  options: {
    ipAddress?: string;
    userAgent?: string;
    requestId?: string;
    initiatedBy?: string;
  }
): AuditEvent {
  return createAuditEvent(AuditEventType.ACCOUNT_UPDATED, {
    severity: AuditEventSeverity.INFO,
    userId,
    ipAddress: options.ipAddress ?? null,
    userAgent: options.userAgent ?? null,
    requestId: options.requestId ?? null,
    success: true,
    metadata: {
      email,
      changedFields,
      initiatedBy: options.initiatedBy,
    } satisfies AccountEventMetadata,
  });
}
