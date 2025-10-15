/**
 * Audit Event Types and Interfaces
 */

export enum AuditEventType {
  // Authentication events
  LOGIN_SUCCESS = 'LOGIN_SUCCESS',
  LOGIN_FAILED = 'LOGIN_FAILED',
  LOGOUT = 'LOGOUT',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  PASSWORD_RESET_REQUESTED = 'PASSWORD_RESET_REQUESTED',
  PASSWORD_RESET_COMPLETED = 'PASSWORD_RESET_COMPLETED',

  // Role management events
  ROLE_CREATED = 'ROLE_CREATED',
  ROLE_UPDATED = 'ROLE_UPDATED',
  ROLE_DELETED = 'ROLE_DELETED',
  ROLE_ASSIGNED = 'ROLE_ASSIGNED',
  ROLE_REMOVED = 'ROLE_REMOVED',

  // Permission management events
  PERMISSION_CREATED = 'PERMISSION_CREATED',
  PERMISSION_DELETED = 'PERMISSION_DELETED',
  PERMISSION_GRANTED_TO_ROLE = 'PERMISSION_GRANTED_TO_ROLE',
  PERMISSION_REVOKED_FROM_ROLE = 'PERMISSION_REVOKED_FROM_ROLE',
  PERMISSION_GRANTED_TO_USER = 'PERMISSION_GRANTED_TO_USER',
  PERMISSION_REVOKED_FROM_USER = 'PERMISSION_REVOKED_FROM_USER',
  PERMISSION_CHECK_FAILED = 'PERMISSION_CHECK_FAILED',

  // User management events
  USER_CREATED = 'USER_CREATED',
  USER_UPDATED = 'USER_UPDATED',
  USER_DELETED = 'USER_DELETED',
  USER_SUSPENDED = 'USER_SUSPENDED',
  USER_REACTIVATED = 'USER_REACTIVATED',

  // Security events
  SECURITY_ALERT = 'SECURITY_ALERT',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  INVALID_TOKEN = 'INVALID_TOKEN',
  UNAUTHORIZED_ACCESS = 'UNAUTHORIZED_ACCESS',
  PRIVILEGE_ESCALATION_ATTEMPT = 'PRIVILEGE_ESCALATION_ATTEMPT',
}

export enum AuditEventSeverity {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL',
}

export interface AuditEvent {
  timestamp: string;
  eventType: AuditEventType;
  severity: AuditEventSeverity;
  userId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string;
  metadata: Record<string, any>;
  success: boolean;
  errorMessage?: string;
}

/**
 * Helper functions for creating audit events
 */

export function createAuditEvent(
  eventType: AuditEventType,
  severity: AuditEventSeverity,
  {
    userId = null,
    ipAddress = null,
    userAgent = null,
    requestId = crypto.randomUUID(),
    metadata = {},
    success = true,
    errorMessage,
  }: Partial<Omit<AuditEvent, 'timestamp' | 'eventType' | 'severity'>> = {}
): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    eventType,
    severity,
    userId,
    ipAddress,
    userAgent,
    requestId,
    metadata,
    success,
    errorMessage,
  };
}

export function createLoginSuccessEvent(
  userId: string,
  email: string,
  ipAddress: string | null = null,
  userAgent: string | null = null
): AuditEvent {
  return createAuditEvent(AuditEventType.LOGIN_SUCCESS, AuditEventSeverity.INFO, {
    userId,
    ipAddress,
    userAgent,
    metadata: { email },
  });
}

export function createLoginFailedEvent(
  email: string,
  reason: string,
  ipAddress: string | null = null,
  userAgent: string | null = null
): AuditEvent {
  return createAuditEvent(AuditEventType.LOGIN_FAILED, AuditEventSeverity.WARNING, {
    ipAddress,
    userAgent,
    metadata: { email, reason },
    success: false,
    errorMessage: reason,
  });
}

export function createSecurityAlertEvent(
  alertType: string,
  details: Record<string, any>,
  userId: string | null = null,
  ipAddress: string | null = null
): AuditEvent {
  return createAuditEvent(AuditEventType.SECURITY_ALERT, AuditEventSeverity.CRITICAL, {
    userId,
    ipAddress,
    metadata: { alertType, ...details },
    success: false,
  });
}

export function createRoleManagementEvent(
  eventType: AuditEventType,
  roleId: string,
  roleName: string,
  performedBy: string,
  details: Record<string, any> = {}
): AuditEvent {
  return createAuditEvent(eventType, AuditEventSeverity.INFO, {
    userId: performedBy,
    metadata: {
      roleId,
      roleName,
      ...details,
    },
  });
}

export function createPermissionManagementEvent(
  eventType: AuditEventType,
  permissionId: string,
  permissionName: string,
  performedBy: string,
  details: Record<string, any> = {}
): AuditEvent {
  return createAuditEvent(eventType, AuditEventSeverity.INFO, {
    userId: performedBy,
    metadata: {
      permissionId,
      permissionName,
      ...details,
    },
  });
}