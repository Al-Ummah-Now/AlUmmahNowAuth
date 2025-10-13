/**
 * Audit Events Tests
 *
 * Tests for audit event creation functions
 */

import { describe, it, expect } from 'vitest';
import {
  AuditEventType,
  AuditEventSeverity,
  createAuditEvent,
  createLoginSuccessEvent,
  createLoginFailedEvent,
  createLogoutEvent,
  createTokenIssuedEvent,
  createTokenRefreshEvent,
  createRateLimitExceededEvent,
  createAccountCreatedEvent,
  createAccountUpdatedEvent,
} from './audit-events';

describe('Audit Events', () => {
  describe('createAuditEvent', () => {
    it('should create a basic audit event with required fields', () => {
      const event = createAuditEvent(AuditEventType.LOGIN_SUCCESS, {
        severity: AuditEventSeverity.INFO,
        success: true,
      });

      expect(event.eventType).toBe(AuditEventType.LOGIN_SUCCESS);
      expect(event.severity).toBe(AuditEventSeverity.INFO);
      expect(event.success).toBe(true);
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(event.userId).toBeNull();
      expect(event.metadata).toEqual({});
    });

    it('should create an audit event with all optional fields', () => {
      const event = createAuditEvent(AuditEventType.LOGIN_FAILED, {
        severity: AuditEventSeverity.WARNING,
        userId: 'user-123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        requestId: 'req-456',
        metadata: { reason: 'invalid_code' },
        success: false,
        errorMessage: 'Invalid verification code',
      });

      expect(event.eventType).toBe(AuditEventType.LOGIN_FAILED);
      expect(event.severity).toBe(AuditEventSeverity.WARNING);
      expect(event.userId).toBe('user-123');
      expect(event.ipAddress).toBe('192.168.1.1');
      expect(event.userAgent).toBe('Mozilla/5.0');
      expect(event.requestId).toBe('req-456');
      expect(event.metadata).toEqual({ reason: 'invalid_code' });
      expect(event.success).toBe(false);
      expect(event.errorMessage).toBe('Invalid verification code');
    });
  });

  describe('createLoginSuccessEvent', () => {
    it('should create a login success event with correct structure', () => {
      const event = createLoginSuccessEvent('user@example.com', 'user-123', {
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        requestId: 'req-789',
        clientId: 'profile',
      });

      expect(event.eventType).toBe(AuditEventType.LOGIN_SUCCESS);
      expect(event.severity).toBe(AuditEventSeverity.INFO);
      expect(event.userId).toBe('user-123');
      expect(event.ipAddress).toBe('192.168.1.1');
      expect(event.userAgent).toBe('Mozilla/5.0');
      expect(event.requestId).toBe('req-789');
      expect(event.success).toBe(true);
      expect(event.metadata.email).toBe('user@example.com');
      expect(event.metadata.method).toBe('email_code');
      expect(event.metadata.clientId).toBe('profile');
    });

    it('should work with minimal options', () => {
      const event = createLoginSuccessEvent('user@example.com', 'user-123', {});

      expect(event.eventType).toBe(AuditEventType.LOGIN_SUCCESS);
      expect(event.userId).toBe('user-123');
      expect(event.metadata.email).toBe('user@example.com');
    });
  });

  describe('createLoginFailedEvent', () => {
    it('should create a login failed event with correct structure', () => {
      const event = createLoginFailedEvent(
        'user@example.com',
        'Invalid verification code',
        {
          ipAddress: '192.168.1.1',
          userAgent: 'Mozilla/5.0',
          requestId: 'req-101',
        }
      );

      expect(event.eventType).toBe(AuditEventType.LOGIN_FAILED);
      expect(event.severity).toBe(AuditEventSeverity.WARNING);
      expect(event.userId).toBeNull();
      expect(event.success).toBe(false);
      expect(event.errorMessage).toBe('Invalid verification code');
      expect(event.metadata.email).toBe('user@example.com');
      expect(event.metadata.failureReason).toBe('Invalid verification code');
    });
  });

  describe('createLogoutEvent', () => {
    it('should create a logout event with correct structure', () => {
      const event = createLogoutEvent('user-123', {
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        requestId: 'req-202',
      });

      expect(event.eventType).toBe(AuditEventType.LOGOUT);
      expect(event.severity).toBe(AuditEventSeverity.INFO);
      expect(event.userId).toBe('user-123');
      expect(event.success).toBe(true);
      expect(event.metadata).toEqual({});
    });
  });

  describe('createTokenIssuedEvent', () => {
    it('should create a token issued event with correct structure', () => {
      const event = createTokenIssuedEvent('user-123', 'profile', {
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        requestId: 'req-303',
        tokenType: 'access',
        grantType: 'authorization_code',
        expiresIn: 3600,
      });

      expect(event.eventType).toBe(AuditEventType.TOKEN_ISSUED);
      expect(event.severity).toBe(AuditEventSeverity.INFO);
      expect(event.userId).toBe('user-123');
      expect(event.success).toBe(true);
      expect(event.metadata.tokenType).toBe('access');
      expect(event.metadata.clientId).toBe('profile');
      expect(event.metadata.grantType).toBe('authorization_code');
      expect(event.metadata.expiresIn).toBe(3600);
    });
  });

  describe('createTokenRefreshEvent', () => {
    it('should create a token refresh event with correct structure', () => {
      const event = createTokenRefreshEvent('user-123', 'profile', {
        ipAddress: '192.168.1.1',
        requestId: 'req-404',
        expiresIn: 3600,
      });

      expect(event.eventType).toBe(AuditEventType.TOKEN_REFRESH);
      expect(event.severity).toBe(AuditEventSeverity.INFO);
      expect(event.userId).toBe('user-123');
      expect(event.success).toBe(true);
      expect(event.metadata.tokenType).toBe('refresh');
      expect(event.metadata.grantType).toBe('refresh_token');
      expect(event.metadata.expiresIn).toBe(3600);
    });
  });

  describe('createRateLimitExceededEvent', () => {
    it('should create a rate limit exceeded event with correct structure', () => {
      const event = createRateLimitExceededEvent('/login', 5, 300, 240, {
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        requestId: 'req-505',
      });

      expect(event.eventType).toBe(AuditEventType.RATE_LIMIT_EXCEEDED);
      expect(event.severity).toBe(AuditEventSeverity.WARNING);
      expect(event.userId).toBeNull();
      expect(event.success).toBe(false);
      expect(event.errorMessage).toBe('Rate limit exceeded for /login');
      expect(event.metadata.endpoint).toBe('/login');
      expect(event.metadata.limit).toBe(5);
      expect(event.metadata.window).toBe(300);
      expect(event.metadata.retryAfter).toBe(240);
    });
  });

  describe('createAccountCreatedEvent', () => {
    it('should create an account created event with correct structure', () => {
      const event = createAccountCreatedEvent('user-123', 'user@example.com', 'user', {
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        requestId: 'req-606',
      });

      expect(event.eventType).toBe(AuditEventType.ACCOUNT_CREATED);
      expect(event.severity).toBe(AuditEventSeverity.INFO);
      expect(event.userId).toBe('user-123');
      expect(event.success).toBe(true);
      expect(event.metadata.email).toBe('user@example.com');
      expect(event.metadata.role).toBe('user');
    });

    it('should include initiatedBy when provided', () => {
      const event = createAccountCreatedEvent('user-123', 'user@example.com', 'admin', {
        initiatedBy: 'admin-456',
      });

      expect(event.metadata.initiatedBy).toBe('admin-456');
    });
  });

  describe('createAccountUpdatedEvent', () => {
    it('should create an account updated event with correct structure', () => {
      const event = createAccountUpdatedEvent(
        'user-123',
        'user@example.com',
        ['email', 'role'],
        {
          ipAddress: '192.168.1.1',
          userAgent: 'Mozilla/5.0',
          requestId: 'req-707',
          initiatedBy: 'admin-456',
        }
      );

      expect(event.eventType).toBe(AuditEventType.ACCOUNT_UPDATED);
      expect(event.severity).toBe(AuditEventSeverity.INFO);
      expect(event.userId).toBe('user-123');
      expect(event.success).toBe(true);
      expect(event.metadata.email).toBe('user@example.com');
      expect(event.metadata.changedFields).toEqual(['email', 'role']);
      expect(event.metadata.initiatedBy).toBe('admin-456');
    });
  });

  describe('Event Type Values', () => {
    it('should have correctly formatted event type values', () => {
      expect(AuditEventType.LOGIN_SUCCESS).toBe('auth.login.success');
      expect(AuditEventType.LOGIN_FAILED).toBe('auth.login.failed');
      expect(AuditEventType.LOGOUT).toBe('auth.logout');
      expect(AuditEventType.TOKEN_ISSUED).toBe('auth.token.issued');
      expect(AuditEventType.TOKEN_REFRESH).toBe('auth.token.refresh');
      expect(AuditEventType.TOKEN_REVOKE).toBe('auth.token.revoke');
      expect(AuditEventType.ACCOUNT_CREATED).toBe('auth.account.created');
      expect(AuditEventType.ACCOUNT_UPDATED).toBe('auth.account.updated');
      expect(AuditEventType.RATE_LIMIT_EXCEEDED).toBe('security.rate_limit.exceeded');
    });
  });

  describe('Severity Levels', () => {
    it('should have correct severity values', () => {
      expect(AuditEventSeverity.INFO).toBe('info');
      expect(AuditEventSeverity.WARNING).toBe('warning');
      expect(AuditEventSeverity.ERROR).toBe('error');
      expect(AuditEventSeverity.CRITICAL).toBe('critical');
    });
  });
});
