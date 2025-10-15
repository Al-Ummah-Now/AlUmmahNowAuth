# Webhook Retry with DLQ - Test Plan

## Overview

Comprehensive test plan for validating the webhook retry logic and Dead Letter Queue implementation for audit events.

## Test Objectives

1. Verify retry logic handles transient failures correctly
2. Validate DLQ storage for permanent failures
3. Ensure performance remains acceptable under load
4. Confirm manual replay functionality works correctly
5. Validate security (HMAC signatures) during retries

## Test Environment Setup

### Prerequisites

```bash
# 1. Apply migration
wrangler d1 execute AUTH_DB --file=migrations/0010_create_webhook_dlq_table.sql

# 2. Set environment variables
export AUDIT_WEBHOOK_URL=https://webhook.example.com/audit
export AUDIT_WEBHOOK_SECRET=test-secret-at-least-32-characters-long
export ENABLE_AUDIT_DLQ=true

# 3. Start mock webhook server
npm run test:webhook-mock

# 4. Initialize test database
npm run test:db:seed
```

### Mock Webhook Server

```javascript
// test/mock-webhook-server.js
import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

let requestCount = 0;
let failureMode = 'none'; // none, transient, permanent, timeout

app.post('/audit', (req, res) => {
  requestCount++;

  // Verify HMAC signature
  const signature = req.headers['x-audit-signature'];
  if (signature) {
    const expected = `sha256=${crypto
      .createHmac('sha256', process.env.AUDIT_WEBHOOK_SECRET)
      .update(JSON.stringify(req.body))
      .digest('hex')}`;

    if (signature !== expected) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  // Simulate different failure modes
  switch (failureMode) {
    case 'transient':
      if (requestCount % 3 === 1) {
        return res.status(500).json({ error: 'Internal Server Error' });
      }
      break;
    case 'permanent':
      return res.status(400).json({ error: 'Bad Request' });
    case 'timeout':
      // Don't respond
      return;
    case 'partial':
      if (requestCount <= 2) {
        return res.status(503).json({ error: 'Service Unavailable' });
      }
      break;
  }

  // Success
  res.json({ success: true, received: req.body.events.length });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', requestCount, failureMode });
});

app.post('/control', (req, res) => {
  failureMode = req.body.mode;
  requestCount = 0;
  res.json({ failureMode, requestCount });
});

app.listen(3000, () => {
  console.log('Mock webhook server listening on port 3000');
});
```

## Test Cases

### 1. Unit Tests

#### Test Suite: WebhookSink Retry Logic

```javascript
describe('WebhookSink Retry Logic', () => {
  // Test 1.1: Successful delivery on first attempt
  test('should deliver successfully on first attempt', async () => {
    // Given: Webhook endpoint is healthy
    // When: Events are emitted
    // Then: Delivery succeeds without retry
    // Verify: fetch called once, no DLQ write
  });

  // Test 1.2: Retry on 5xx errors
  test('should retry on server errors', async () => {
    // Given: Webhook returns 500, then 200
    // When: Events are emitted
    // Then: Delivery succeeds after retry
    // Verify: fetch called twice, no DLQ write
  });

  // Test 1.3: No retry on 4xx errors
  test('should not retry on client errors', async () => {
    // Given: Webhook returns 400
    // When: Events are emitted
    // Then: Events stored in DLQ immediately
    // Verify: fetch called once, DLQ write occurs
  });

  // Test 1.4: Exponential backoff timing
  test('should apply exponential backoff', async () => {
    // Given: Multiple failures
    // When: Retries occur
    // Then: Delays increase exponentially
    // Verify: 1s, 2s, 4s delays observed
  });

  // Test 1.5: DLQ storage after exhausted retries
  test('should store to DLQ after max retries', async () => {
    // Given: Persistent failures
    // When: All retries exhausted
    // Then: Events stored in DLQ
    // Verify: DLQ contains correct data
  });

  // Test 1.6: HMAC signature on retries
  test('should maintain HMAC signature on retries', async () => {
    // Given: Webhook secret configured
    // When: Retries occur
    // Then: Each attempt has valid signature
    // Verify: Signature remains consistent
  });

  // Test 1.7: Timeout handling
  test('should handle request timeouts', async () => {
    // Given: Webhook doesn't respond
    // When: Timeout occurs
    // Then: Retry triggered
    // Verify: AbortController used correctly
  });

  // Test 1.8: Jitter in retry delays
  test('should apply jitter to retry delays', async () => {
    // Given: Multiple retry scenarios
    // When: Calculating delays
    // Then: Delays vary within ±20%
    // Verify: Prevents thundering herd
  });
});
```

#### Test Suite: DLQ Replay Service

```javascript
describe('DLQ Replay Service', () => {
  // Test 2.1: List queued events
  test('should list DLQ entries with pagination', async () => {
    // Given: DLQ contains multiple entries
    // When: Querying with limit/offset
    // Then: Correct entries returned
    // Verify: Pagination works correctly
  });

  // Test 2.2: Replay successful
  test('should replay events successfully', async () => {
    // Given: DLQ contains pending entries
    // When: Replay initiated
    // Then: Events delivered, status updated
    // Verify: Webhook receives events
  });

  // Test 2.3: Replay with failures
  test('should handle replay failures', async () => {
    // Given: Webhook still failing
    // When: Replay attempted
    // Then: Status marked as failed
    // Verify: Error details captured
  });

  // Test 2.4: Dry run mode
  test('should support dry run mode', async () => {
    // Given: Dry run enabled
    // When: Replay initiated
    // Then: No actual delivery, status unchanged
    // Verify: Simulation only
  });

  // Test 2.5: Cleanup old entries
  test('should cleanup old DLQ entries', async () => {
    // Given: Entries older than 30 days
    // When: Cleanup executed
    // Then: Old entries deleted
    // Verify: Recent entries preserved
  });

  // Test 2.6: Statistics calculation
  test('should calculate DLQ statistics', async () => {
    // Given: Various DLQ entries
    // When: Stats requested
    // Then: Accurate counts returned
    // Verify: All status types counted
  });
});
```

### 2. Integration Tests

#### Test Suite: End-to-End Webhook Delivery

```javascript
describe('E2E Webhook Delivery', () => {
  // Test 3.1: Normal operation flow
  test('should handle normal audit flow', async () => {
    // Given: System configured with webhook
    // When: User performs login
    // Then: Audit event delivered to webhook
    // Verify: Complete flow works
  });

  // Test 3.2: Failure recovery flow
  test('should recover from webhook outage', async () => {
    // Given: Webhook initially down
    // When: Events generated, then webhook recovers
    // Then: Events stored in DLQ, can be replayed
    // Verify: No events lost
  });

  // Test 3.3: Concurrent deliveries
  test('should handle concurrent event batches', async () => {
    // Given: Multiple simultaneous events
    // When: Batches processed in parallel
    // Then: All delivered correctly
    // Verify: No race conditions
  });

  // Test 3.4: Worker restart resilience
  test('should handle worker restarts', async () => {
    // Given: Events in flight
    // When: Worker restarts
    // Then: Events not lost
    // Verify: ExecutionContext.waitUntil works
  });
});
```

### 3. Load Tests

#### Test Suite: Performance Under Load

```javascript
describe('Load Testing', () => {
  // Test 4.1: High volume normal operation
  test('should handle 1000 events/minute', async () => {
    // Given: High event rate
    // When: Running for 5 minutes
    // Then: All events delivered
    // Metrics: Latency P50/P95/P99, CPU, Memory
  });

  // Test 4.2: High volume with failures
  test('should handle load with 10% failures', async () => {
    // Given: High event rate, intermittent failures
    // When: Running for 5 minutes
    // Then: 99%+ delivery success
    // Metrics: Retry rate, DLQ depth
  });

  // Test 4.3: Burst traffic
  test('should handle burst of 500 events', async () => {
    // Given: Sudden spike
    // When: 500 events in 1 second
    // Then: System remains stable
    // Metrics: Queue depth, memory spike
  });

  // Test 4.4: Sustained outage
  test('should handle 5-minute webhook outage', async () => {
    // Given: Continuous event flow
    // When: Webhook down for 5 minutes
    // Then: All events preserved in DLQ
    // Metrics: DLQ growth rate
  });
});
```

### 4. Security Tests

#### Test Suite: Security Validation

```javascript
describe('Security Tests', () => {
  // Test 5.1: HMAC validation
  test('should reject invalid signatures', async () => {
    // Given: Webhook expects signatures
    // When: Invalid signature sent
    // Then: Webhook rejects, retry occurs
    // Verify: Security maintained
  });

  // Test 5.2: DLQ access control
  test('should restrict DLQ replay to admins', async () => {
    // Given: Non-admin user
    // When: Attempting replay
    // Then: Access denied
    // Verify: Authorization enforced
  });

  // Test 5.3: Sensitive data handling
  test('should not log sensitive data', async () => {
    // Given: Events with PII
    // When: Failures occur
    // Then: Logs sanitized
    // Verify: No PII in logs
  });
});
```

### 5. Failure Mode Tests

#### Test Suite: Edge Cases and Failure Modes

```javascript
describe('Failure Mode Tests', () => {
  // Test 6.1: Network partition
  test('should handle network partitions', async () => {
    // Given: Network connectivity lost
    // When: Events generated
    // Then: Graceful degradation
    // Verify: No crashes
  });

  // Test 6.2: DLQ storage failure
  test('should handle DLQ write failures', async () => {
    // Given: D1 database unavailable
    // When: Webhook delivery fails
    // Then: Fallback to logging
    // Verify: Critical error logged
  });

  // Test 6.3: Malformed events
  test('should handle malformed events', async () => {
    // Given: Invalid event data
    // When: Processing attempted
    // Then: Error handled gracefully
    // Verify: System remains stable
  });

  // Test 6.4: Circular retry loop
  test('should prevent infinite retry loops', async () => {
    // Given: Persistent failures
    // When: Max retries reached
    // Then: Loop terminated
    // Verify: Resource exhaustion prevented
  });
});
```

## Test Execution Plan

### Phase 1: Unit Tests (Day 1)
```bash
# Run unit tests
npm test -- audit-emitter.test.ts
npm test -- dlq-replay.test.ts

# Coverage report
npm test -- --coverage
```

### Phase 2: Integration Tests (Day 2)
```bash
# Start test environment
npm run test:env:start

# Run integration tests
npm test -- integration/webhook-delivery.test.ts

# Stop test environment
npm run test:env:stop
```

### Phase 3: Load Tests (Day 3)
```bash
# Setup load test environment
npm run loadtest:setup

# Run load tests
npm run loadtest:normal
npm run loadtest:failures
npm run loadtest:burst
npm run loadtest:outage

# Generate report
npm run loadtest:report
```

### Phase 4: Security Tests (Day 4)
```bash
# Run security tests
npm test -- security/webhook-security.test.ts

# Penetration testing
npm run security:pentest
```

## Test Data

### Sample Audit Events
```javascript
const testEvents = [
  {
    timestamp: '2025-01-12T10:00:00Z',
    eventType: 'auth.login.success',
    severity: 'info',
    userId: 'test-user-1',
    ipAddress: '192.168.1.1',
    userAgent: 'Mozilla/5.0',
    requestId: 'req-123',
    metadata: { method: 'password' },
    success: true,
  },
  {
    timestamp: '2025-01-12T10:01:00Z',
    eventType: 'auth.login.failed',
    severity: 'warning',
    userId: 'test-user-2',
    ipAddress: '192.168.1.2',
    userAgent: 'Mozilla/5.0',
    requestId: 'req-124',
    metadata: { reason: 'invalid_password' },
    success: false,
    errorMessage: 'Invalid credentials',
  },
  // ... more test events
];
```

## Success Criteria

### Functional Requirements
- [ ] All retry attempts execute with correct delays
- [ ] DLQ storage works for failed deliveries
- [ ] Manual replay successfully redelivers events
- [ ] HMAC signatures maintained throughout retries
- [ ] Cleanup removes old entries correctly

### Performance Requirements
- [ ] P95 latency < 1s for successful deliveries
- [ ] P99 latency < 5s with retries
- [ ] Memory usage < 100MB under load
- [ ] CPU usage < 50% at 1000 events/min
- [ ] Zero event loss during outages

### Security Requirements
- [ ] All webhook calls include valid HMAC
- [ ] DLQ access restricted to admins
- [ ] No sensitive data in logs
- [ ] Rate limiting prevents DLQ flooding

## Test Reports

### Test Summary Report Template
```markdown
## Test Execution Summary

**Date**: 2025-01-12
**Version**: 1.0.0
**Environment**: Staging

### Results Overview
- Total Tests: 50
- Passed: 48
- Failed: 2
- Skipped: 0
- Coverage: 95%

### Failed Tests
1. Test 4.3 - Burst traffic handling
   - Issue: Memory spike exceeded limit
   - Resolution: Increase batch timeout

2. Test 6.2 - DLQ write failure handling
   - Issue: Fallback logging not triggered
   - Resolution: Fix error handling logic

### Performance Metrics
- Average latency: 250ms
- P95 latency: 850ms
- Success rate: 99.8%
- DLQ write rate: 0.2%

### Recommendations
1. Increase default batch timeout to 10s
2. Add memory limit monitoring
3. Implement circuit breaker for phase 2
```

## Monitoring During Tests

```javascript
// Metrics to monitor during test execution
const testMetrics = {
  // Real-time metrics
  activeConnections: gauge(),
  requestsPerSecond: meter(),
  errorRate: meter(),

  // Latency tracking
  deliveryLatency: histogram(),
  retryLatency: histogram(),
  dlqWriteLatency: histogram(),

  // Resource usage
  cpuUsage: gauge(),
  memoryUsage: gauge(),
  dlqDepth: gauge(),

  // Business metrics
  eventsDelivered: counter(),
  eventsLost: counter(),
  retriesExecuted: counter(),
};
```

## Rollback Plan

If critical issues discovered:

1. **Immediate Rollback**
   ```bash
   # Disable retry logic
   export WEBHOOK_RETRY_ENABLED=false

   # Revert code deployment
   wrangler rollback --env production
   ```

2. **Data Recovery**
   ```sql
   -- Export DLQ data before rollback
   SELECT * FROM webhook_dlq
   INTO OUTFILE '/backup/dlq_backup.csv';
   ```

3. **Communication**
   - Notify stakeholders
   - Document issues found
   - Plan fixes for next iteration

## Sign-off Criteria

- [ ] All test suites pass
- [ ] Performance within acceptable limits
- [ ] Security requirements met
- [ ] Documentation updated
- [ ] Rollback plan tested
- [ ] Stakeholder approval obtained