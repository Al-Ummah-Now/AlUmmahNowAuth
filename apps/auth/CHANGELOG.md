# Changelog

All notable changes to the Auth Server will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking Changes

#### Audit Event API Changes

**`createAuditEvent()` Function Signature Change**

The `createAuditEvent()` function signature has been updated to improve consistency and extensibility.

**Before:**
```typescript
createAuditEvent(
  type: AuditEventType,
  severity: AuditEventSeverity,
  options: {
    userId?: string;
    ipAddress?: string;
    // ... other options
  }
): AuditEvent
```

**After:**
```typescript
createAuditEvent(
  type: AuditEventType,
  options: {
    severity?: AuditEventSeverity;  // Now part of options object
    userId?: string;
    ipAddress?: string;
    // ... other options
  }
): AuditEvent
```

**Migration Guide:**

Update all calls to `createAuditEvent()` to move the `severity` parameter into the options object:

```typescript
// Old code (will cause TypeScript errors):
const event = createAuditEvent(
  'user.login.success',
  AuditEventSeverity.INFO,
  {
    userId: '123',
    ipAddress: '1.2.3.4'
  }
);

// New code:
const event = createAuditEvent(
  'user.login.success',
  {
    severity: AuditEventSeverity.INFO,  // Moved into options
    userId: '123',
    ipAddress: '1.2.3.4'
  }
);
```

**Note:** If `severity` is not specified, it defaults to `AuditEventSeverity.INFO`.

**Files affected:**
- `src/audit-events.ts` - Function signature updated
- All files calling `createAuditEvent()` have been updated in the codebase

### Added

- Enhanced queue management for audit event sinks with metrics tracking
- Test endpoint safeguard: `/test/promote` now requires `TEST_PROMOTE_SECRET` header
- Configuration validation for audit queue sizes (prevents misconfiguration)

### Changed

- JWT token service now uses `env.OPENAUTH_ISSUER` instead of hardcoded issuer value
- Queue configuration validation now throws errors (instead of warnings) when `maxQueueSize < batchSize * 2`

### Removed

- Unused `GRACE_PERIOD_MS` constant from token service (dead code from Issue #77)

### Security

- Added `TEST_PROMOTE_SECRET` environment variable requirement for test user promotion endpoint
- Strengthened audit queue configuration validation to prevent immediate overflow
- Fixed hardcoded JWT issuer to support multi-environment deployments

---

## Version History

This is the first CHANGELOG for the Auth Server. Previous changes were tracked in git commit history and pull requests.
