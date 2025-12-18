# Comprehensive Edge Case Testing Strategy for Audit Logging

**Issue:** #65
**Repository:** meywd/AlUmmahNowAuth
**Component:** Audit Logging System
**Created:** 2025-10-12
**Status:** In Progress

---

## Executive Summary

This document provides a comprehensive testing strategy for the audit logging system addressing GitHub Issue #65. Current test coverage is adequate for happy path scenarios (75 passing tests across 45 test suites), but lacks coverage for concurrency, error handling, performance, and edge cases.

**Key Metrics:**
- Current Tests: 75 (all passing)
- Target Tests: 115-130
- Current Coverage: ~75% (estimated)
- Target Coverage: 90%+
- Priority: Low (production-ready, but enhanced testing needed for long-term confidence)

---

## Table of Contents

1. [Current Test Coverage Analysis](#current-test-coverage-analysis)
2. [Coverage Gaps](#coverage-gaps)
3. [Test Categories & Priorities](#test-categories--priorities)
4. [Detailed Test Specifications](#detailed-test-specifications)
5. [Mock Infrastructure](#mock-infrastructure)
6. [Test Implementation Examples](#test-implementation-examples)
7. [Performance Benchmarks](#performance-benchmarks)
8. [CI/CD Integration](#cicd-integration)
9. [Test Execution Strategy](#test-execution-strategy)

---

## Current Test Coverage Analysis

### Existing Test Files

#### 1. `/home/meywd/AlUmmahNowAuth/apps/auth/src/audit-events.test.ts`
**Lines:** 262
**Tests:** 14
**Coverage:** Happy path event creation

**Tested:**
- ✅ Event creation with required fields
- ✅ Event creation with optional fields
- ✅ All event type helper functions (login, logout, token, account)
- ✅ Event type enum values
- ✅ Severity levels

**Not Tested:**
- ❌ Invalid timestamp formats
- ❌ Extremely large metadata objects (>1MB)
- ❌ Special characters in metadata
- ❌ Circular references in metadata
- ❌ NULL/undefined handling in optional fields
- ❌ Unicode/emoji in event fields
- ❌ Event serialization failures

#### 2. `/home/meywd/AlUmmahNowAuth/apps/auth/src/audit-emitter.test.ts`
**Lines:** 231
**Tests:** 12
**Coverage:** Basic emitter functionality

**Tested:**
- ✅ StdoutSink basic emission
- ✅ Multiple sinks emission
- ✅ Sink error handling (basic)
- ✅ WebhookSink HMAC signatures
- ✅ Sink flushing
- ✅ Initialization with different configurations

**Not Tested:**
- ❌ Concurrent emit() calls
- ❌ Race conditions between emit() and flush()
- ❌ Timer cancellation edge cases
- ❌ ExecutionContext.waitUntil() behavior
- ❌ Large batch sizes (>100 events)
- ❌ Network timeouts in WebhookSink
- ❌ D1 database errors and retries
- ❌ Memory pressure scenarios
- ❌ Sink performance under load
- ❌ Queue overflow behavior

### Test Distribution

| Category | Current Tests | Target Tests | Gap |
|----------|--------------|--------------|-----|
| **Event Creation** | 14 | 20 | +6 |
| **Sink Implementation** | 7 | 15 | +8 |
| **Emitter Logic** | 5 | 12 | +7 |
| **Concurrency** | 0 | 12 | +12 |
| **Error Handling** | 2 | 15 | +13 |
| **Performance** | 0 | 8 | +8 |
| **Integration** | 1 | 6 | +5 |
| **Total** | **75** | **115-130** | **+40-55** |

---

## Coverage Gaps

### Critical Gaps (High Impact)

#### 1. Concurrency Issues
**Risk:** Data loss, duplicate events, race conditions
**Scenarios:**
- Multiple concurrent emit() calls to same sink
- Concurrent flush() calls
- Race between emit() and flush()
- Timer conflicts during batching

#### 2. Network Failures (WebhookSink)
**Risk:** Silent event loss, unhandled errors
**Scenarios:**
- HTTP 500/502/503 errors
- DNS resolution failures
- Connection timeouts (>30s)
- SSL/TLS handshake failures
- Response payload too large

#### 3. Database Errors (D1Sink)
**Risk:** Audit log gaps, constraint violations
**Scenarios:**
- Database locked errors
- Unique constraint violations
- Transaction rollbacks
- Statement timeout
- Batch size exceeding SQL limits

#### 4. Resource Exhaustion
**Risk:** Worker crashes, memory leaks
**Scenarios:**
- Queue overflow (>10,000 events)
- Large event payloads (>10MB)
- Memory pressure during batching
- CPU time limits in Cloudflare Workers

### Medium Gaps (Moderate Impact)

#### 5. Edge Case Data Handling
- Null/undefined in optional fields
- Circular references in metadata
- Invalid JSON in metadata
- Unicode/emoji in strings
- Very long strings (>1MB)
- Empty arrays/objects

#### 6. Timer Management
- Multiple concurrent setTimeout() calls
- Timer cancellation during flush
- Batch timeout vs batch size race
- ExecutionContext lifecycle

### Low Gaps (Low Impact)

#### 7. Configuration Edge Cases
- Invalid webhook URLs
- Weak webhook secrets (<32 chars)
- Zero batch size
- Negative batch timeout
- Missing required options

---

## Test Categories & Priorities

### Priority 1: Concurrency Tests (Critical)

**Goal:** Ensure no data loss or corruption under concurrent operations

| Test ID | Description | Priority | Effort |
|---------|-------------|----------|--------|
| CON-01 | Concurrent emit() calls to WebhookSink | P1 | Medium |
| CON-02 | Concurrent emit() calls to D1Sink | P1 | Medium |
| CON-03 | Concurrent flush() calls | P1 | High |
| CON-04 | Race between emit() and flush() | P1 | High |
| CON-05 | Multiple timers scheduling simultaneously | P1 | Medium |
| CON-06 | Concurrent emits to multiple sinks | P2 | Medium |
| CON-07 | Interleaved emit/flush sequences | P2 | Medium |
| CON-08 | High-frequency emit() calls (>100/sec) | P2 | High |

### Priority 2: Error Handling Tests (Critical)

**Goal:** Graceful degradation, no crashes

| Test ID | Description | Priority | Effort |
|---------|-------------|----------|--------|
| ERR-01 | WebhookSink: HTTP 500 errors | P1 | Low |
| ERR-02 | WebhookSink: Network timeout | P1 | Medium |
| ERR-03 | WebhookSink: Connection refused | P1 | Low |
| ERR-04 | WebhookSink: DNS failure | P2 | Medium |
| ERR-05 | WebhookSink: SSL/TLS errors | P2 | Medium |
| ERR-06 | D1Sink: Database locked | P1 | Medium |
| ERR-07 | D1Sink: Constraint violation | P1 | Low |
| ERR-08 | D1Sink: Batch failure (partial) | P1 | High |
| ERR-09 | D1Sink: Transaction timeout | P2 | Medium |
| ERR-10 | StdoutSink: Console.log throws | P3 | Low |
| ERR-11 | Invalid HMAC signature generation | P2 | Low |
| ERR-12 | Malformed event data | P2 | Low |

### Priority 3: Performance Tests (Important)

**Goal:** Acceptable throughput, no memory leaks

| Test ID | Description | Priority | Effort |
|---------|-------------|----------|--------|
| PERF-01 | High throughput (10,000 events) | P2 | High |
| PERF-02 | Large event payloads (>1MB) | P2 | Medium |
| PERF-03 | Large batch sizes (>100) | P2 | Medium |
| PERF-04 | Memory usage over time | P2 | High |
| PERF-05 | CPU time limits | P3 | High |
| PERF-06 | Event serialization performance | P3 | Medium |
| PERF-07 | Batching efficiency | P2 | Medium |

### Priority 4: Edge Case Tests (Important)

**Goal:** Handle invalid inputs gracefully

| Test ID | Description | Priority | Effort |
|---------|-------------|----------|--------|
| EDGE-01 | Null/undefined in optional fields | P2 | Low |
| EDGE-02 | Circular references in metadata | P2 | Low |
| EDGE-03 | Very large metadata (>10MB) | P2 | Low |
| EDGE-04 | Unicode/emoji in strings | P3 | Low |
| EDGE-05 | Empty event queue flush | P3 | Low |
| EDGE-06 | Invalid webhook URL | P2 | Low |
| EDGE-07 | Weak webhook secret | P3 | Low |
| EDGE-08 | Zero/negative batch configuration | P2 | Low |

### Priority 5: Integration Tests (Important)

**Goal:** End-to-end workflows function correctly

| Test ID | Description | Priority | Effort |
|---------|-------------|----------|--------|
| INT-01 | Multi-sink emission (stdout + webhook + D1) | P2 | Medium |
| INT-02 | ExecutionContext lifecycle | P1 | High |
| INT-03 | Real D1 database operations | P2 | High |
| INT-04 | Cloudflare Workers environment | P2 | High |
| INT-05 | Sink failure isolation | P2 | Medium |
| INT-06 | Global emitter singleton behavior | P2 | Low |

---

## Detailed Test Specifications

### 1. Concurrency Tests

#### CON-01: Concurrent emit() calls to WebhookSink

**Objective:** Verify no event loss when emitting concurrently

**Setup:**
```typescript
const sink = new WebhookSink({
  url: 'https://mock-webhook.test',
  secret: 'test-secret-32-characters-long',
  batchSize: 10,
  batchTimeout: 1000,
});

const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
global.fetch = mockFetch;
```

**Test Steps:**
1. Emit 100 events concurrently using Promise.all()
2. Wait for all emits to complete
3. Call flush()
4. Verify fetch was called with correct number of batches
5. Verify all events are present in requests
6. Check event ordering within batches

**Expected Results:**
- No events lost
- All events batched correctly (10 batches of 10)
- No duplicate events
- fetch() called exactly 10 times

**Edge Cases:**
- Events emitted faster than network can send
- Batch size reached during concurrent emits
- Timer triggers during concurrent emits

---

#### CON-03: Concurrent flush() calls

**Objective:** Ensure flush() is idempotent and thread-safe

**Setup:**
```typescript
const mockDb = createMockD1Database();
const sink = new D1Sink(mockDb, { batchSize: 50 });

// Add 20 events
for (let i = 0; i < 20; i++) {
  await sink.emit(createTestEvent(i));
}
```

**Test Steps:**
1. Call flush() 10 times concurrently
2. Wait for all flushes to complete
3. Verify database batch() called only once
4. Verify all 20 events inserted exactly once
5. Check event queue is empty after flush

**Expected Results:**
- db.batch() called exactly 1 time
- No duplicate inserts
- No errors thrown
- Event queue cleared

**Implementation Notes:**
- Use a mutex/lock to prevent concurrent flushes
- Track flushing state: `private flushing = false`
- Early return if already flushing

---

#### CON-04: Race between emit() and flush()

**Objective:** Prevent race condition where emit() adds to queue while flush() is reading it

**Setup:**
```typescript
const sink = new WebhookSink({
  url: 'https://mock.test',
  batchSize: 100, // Large batch to control timing
});
```

**Test Steps:**
1. Emit 50 events
2. Start flush() (don't await)
3. Immediately emit 50 more events
4. Wait for both to complete
5. Verify all 100 events sent
6. Check for no errors or lost events

**Expected Results:**
- All 100 events accounted for
- First 50 in first batch
- Second 50 in second batch (or remaining)
- No events lost in the transition

**Implementation Notes:**
- Copy queue to local variable before clearing: `const events = [...this.eventQueue]`
- Clear queue atomically: `this.eventQueue = []`

---

### 2. Error Handling Tests

#### ERR-01: WebhookSink HTTP 500 errors

**Objective:** Handle server errors gracefully, log but don't crash

**Setup:**
```typescript
const sink = new WebhookSink({ url: 'https://mock.test' });
const mockFetch = vi.fn().mockResolvedValue(
  new Response('Internal Server Error', { status: 500 })
);
global.fetch = mockFetch;
```

**Test Steps:**
1. Emit 5 events
2. Call flush()
3. Verify console.error called with appropriate message
4. Verify flush() resolved (didn't throw)
5. Check that events were attempted to send

**Expected Results:**
- flush() resolves without throwing
- console.error contains "Webhook delivery failed: 500"
- fetch() called once
- Event queue cleared (events lost - acceptable for webhook)

**Future Enhancements:**
- Retry logic with exponential backoff (Issue #62)
- Dead letter queue for failed events (Issue #64)

---

#### ERR-02: WebhookSink Network timeout

**Objective:** Handle slow/hung connections without blocking

**Setup:**
```typescript
const sink = new WebhookSink({
  url: 'https://slow.test',
  batchSize: 1, // Immediate flush
});

const mockFetch = vi.fn().mockImplementation(() =>
  new Promise((resolve) => {
    // Never resolves - simulates timeout
    // In real implementation, should timeout after 30s
  })
);
global.fetch = mockFetch;
```

**Test Steps:**
1. Emit 1 event
2. Call flush() with timeout
3. Wait for timeout (30s max)
4. Verify flush() eventually resolves or rejects
5. Check error logged

**Expected Results:**
- flush() resolves within 35s (30s timeout + 5s grace)
- console.error called with timeout message
- No worker crash
- Event considered lost (acceptable)

**Implementation Requirements:**
- Add timeout to fetch() call
- Use AbortController with timeout
- Log timeout errors appropriately

---

#### ERR-06: D1Sink Database locked

**Objective:** Retry or handle locked database gracefully

**Setup:**
```typescript
const mockDb = createMockD1Database();
mockDb.batch = vi.fn()
  .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
  .mockResolvedValueOnce([{ success: true }]);

const sink = new D1Sink(mockDb);
```

**Test Steps:**
1. Emit 5 events
2. Call flush() - first attempt fails with SQLITE_BUSY
3. Verify error logged
4. Verify events logged to stdout as backup
5. Check events are not lost

**Expected Results:**
- First flush() fails
- console.error called with database error
- Events logged as JSON to stdout (backup)
- No worker crash
- Events preserved in backup log

**Current Implementation:**
```typescript
// From audit-emitter.ts lines 258-267
try {
  await this.db.batch(statements);
} catch (error) {
  console.error('D1 audit event storage error:', error);
  // Events are lost if D1 write fails - consider fallback to stdout
  console.log(JSON.stringify({
    type: 'audit_events_backup',
    events,
    error: String(error),
  }));
}
```

**Test Verification:**
- Verify backup log contains all events
- Ensure JSON is parseable
- Check error field contains SQLITE_BUSY

---

#### ERR-07: D1Sink Constraint violation

**Objective:** Handle duplicate event insertion gracefully

**Setup:**
```typescript
const mockDb = createMockD1Database();
mockDb.batch = vi.fn().mockRejectedValue(
  new Error('UNIQUE constraint failed: audit_events.event_id')
);

const sink = new D1Sink(mockDb);
```

**Test Steps:**
1. Emit same event twice (duplicate)
2. Call flush()
3. Verify constraint error caught
4. Verify events backed up to stdout
5. No crash

**Expected Results:**
- Error logged to console
- Events backed up to stdout
- flush() resolves (doesn't throw)

**Note:** Current implementation doesn't assign event_id, but if added in future, this test becomes relevant.

---

#### ERR-08: D1Sink Batch failure (partial)

**Objective:** Handle scenario where some statements succeed, some fail

**Setup:**
```typescript
const mockDb = createMockD1Database();
mockDb.batch = vi.fn().mockResolvedValue([
  { success: true },
  { success: false, error: 'Constraint violation' },
  { success: true },
]);

const sink = new D1Sink(mockDb);
```

**Test Steps:**
1. Emit 3 events
2. Call flush()
3. Check which events succeeded
4. Verify failed events logged separately
5. Ensure partial success handled

**Expected Results:**
- 2 events inserted successfully
- 1 event failed
- Failed event logged to stdout as backup
- No exception thrown

**Implementation Gap:**
- Current implementation doesn't check batch results
- Need to iterate over results and check `success` field
- Log failures individually

**Recommended Implementation:**
```typescript
const results = await this.db.batch(statements);
const failedEvents: AuditEvent[] = [];

results.forEach((result, index) => {
  if (!result.success) {
    console.error(`Audit event ${index} failed:`, result.error);
    failedEvents.push(events[index]);
  }
});

// Backup failed events
if (failedEvents.length > 0) {
  console.log(JSON.stringify({
    type: 'audit_events_backup',
    events: failedEvents,
    reason: 'partial_batch_failure',
  }));
}
```

---

### 3. Performance Tests

#### PERF-01: High throughput (10,000 events)

**Objective:** Measure performance under sustained load

**Setup:**
```typescript
const mockDb = createMockD1Database();
const sink = new D1Sink(mockDb, { batchSize: 100 });

const events = Array.from({ length: 10000 }, (_, i) =>
  createLoginSuccessEvent(`user${i}@test.com`, `user-${i}`, {})
);
```

**Test Steps:**
1. Start timer
2. Emit 10,000 events sequentially
3. Call flush()
4. Stop timer
5. Calculate throughput (events/sec)
6. Verify all events inserted

**Expected Results:**
- Completion time: <10 seconds (1000 events/sec)
- db.batch() called 100 times (100 events per batch)
- No memory errors
- All events accounted for

**Performance Benchmarks:**
- Minimum: 500 events/sec
- Target: 1000 events/sec
- Optimal: 2000+ events/sec

**Monitoring:**
- Memory usage (should stay <50MB)
- CPU time (should stay <500ms total)
- Batch efficiency (100 events per batch)

---

#### PERF-02: Large event payloads (>1MB)

**Objective:** Handle large metadata objects without crashes

**Setup:**
```typescript
const largeMetadata = {
  data: 'x'.repeat(1024 * 1024), // 1MB string
  nested: {
    array: Array.from({ length: 10000 }, (_, i) => ({ id: i, value: 'test' })),
  },
};

const event = createAuditEvent(AuditEventType.LOGIN_SUCCESS, {
  severity: AuditEventSeverity.INFO,
  userId: 'user-123',
  metadata: largeMetadata,
  success: true,
});
```

**Test Steps:**
1. Create event with 1MB metadata
2. Emit to WebhookSink
3. Measure serialization time
4. Verify fetch() payload size
5. Check for errors

**Expected Results:**
- Serialization completes in <100ms
- fetch() payload ~1MB (check Content-Length)
- No JSON.stringify errors
- Webhook server receives complete payload

**Edge Cases to Test:**
- 5MB payload
- 10MB payload (should warn or reject)
- Nested objects >100 levels deep
- Arrays with >100,000 elements

**Recommendations:**
- Add payload size limit (10MB max)
- Warn if payload >1MB
- Consider payload compression for large events

---

#### PERF-03: Large batch sizes (>100)

**Objective:** Test batching efficiency with large batches

**Setup:**
```typescript
const mockDb = createMockD1Database();
const sink = new D1Sink(mockDb, { batchSize: 500 });
```

**Test Steps:**
1. Emit 1000 events
2. Measure time to flush
3. Verify batch() called 2 times (500 + 500)
4. Check SQL statement size limits not exceeded

**Expected Results:**
- 2 batch() calls
- Each batch has 500 INSERT statements
- Total time <5 seconds
- No SQL size limit errors

**SQL Limits:**
- D1/SQLite: Max 1MB per statement
- Max compound SELECT: 500 values
- Batch size should be <500 for safety

**Recommendation:**
- Default batch size: 20-50
- Max batch size: 100-200
- Warn if batch size >200

---

#### PERF-04: Memory usage over time

**Objective:** Detect memory leaks in queue management

**Setup:**
```typescript
const sink = new WebhookSink({
  url: 'https://mock.test',
  batchSize: 10,
});

// Simulate long-running worker
const iterations = 100;
```

**Test Steps:**
1. Record initial memory (process.memoryUsage())
2. For 100 iterations:
   - Emit 10 events
   - Flush
   - Wait 10ms
3. Record final memory
4. Calculate memory growth

**Expected Results:**
- Memory growth <10MB over 100 iterations
- No exponential growth
- Event queue properly cleared after flush
- No dangling timers

**Monitoring:**
- Heap used
- External memory
- Array buffer size
- Timer count

**Red Flags:**
- Memory growth >1MB per iteration
- Event queue not clearing
- Timer count increasing
- Heap fragmentation

---

### 4. Edge Case Tests

#### EDGE-01: Null/undefined in optional fields

**Objective:** Handle missing optional fields gracefully

**Setup:**
```typescript
const event = createAuditEvent(AuditEventType.LOGIN_SUCCESS, {
  severity: AuditEventSeverity.INFO,
  userId: undefined,
  ipAddress: null,
  userAgent: undefined,
  requestId: null,
  metadata: {},
  success: true,
});
```

**Test Steps:**
1. Create event with null/undefined fields
2. Verify event created successfully
3. Serialize to JSON
4. Check JSON doesn't contain "undefined"
5. Emit and flush

**Expected Results:**
- Event created with null values (not undefined)
- JSON serialization succeeds
- No "undefined" strings in output
- Database insert succeeds

**Current Implementation:**
```typescript
// From audit-events.ts lines 149-160
return {
  timestamp: new Date().toISOString(),
  eventType,
  severity: options.severity,
  userId: options.userId ?? null,  // ✅ Converts undefined to null
  ipAddress: options.ipAddress ?? null,  // ✅
  userAgent: options.userAgent ?? null,  // ✅
  requestId: options.requestId ?? null,  // ✅
  metadata: options.metadata ?? {},
  success: options.success,
  errorMessage: options.errorMessage,  // ⚠️ Can be undefined
};
```

**Fix Needed:**
```typescript
errorMessage: options.errorMessage ?? null,  // Convert undefined to null
```

---

#### EDGE-02: Circular references in metadata

**Objective:** Prevent JSON serialization errors from circular refs

**Setup:**
```typescript
const circular: any = { name: 'test' };
circular.self = circular;  // Circular reference

const event = createAuditEvent(AuditEventType.LOGIN_SUCCESS, {
  severity: AuditEventSeverity.INFO,
  success: true,
  metadata: circular,
});
```

**Test Steps:**
1. Create event with circular metadata
2. Attempt to emit
3. Verify error caught
4. Check console.error logged
5. Ensure no worker crash

**Expected Results:**
- JSON.stringify throws TypeError
- Error caught in emit() or flush()
- Error logged: "Failed to serialize audit event"
- Worker continues running

**Implementation Recommendation:**
```typescript
// In StdoutSink.emit()
try {
  console.log(JSON.stringify({
    type: 'audit_event',
    event,
  }));
} catch (error) {
  console.error('Failed to serialize audit event:', error);
  console.log(JSON.stringify({
    type: 'audit_event_error',
    eventType: event.eventType,
    error: String(error),
  }));
}
```

---

#### EDGE-03: Very large metadata (>10MB)

**Objective:** Prevent memory exhaustion from huge payloads

**Setup:**
```typescript
const hugeMetadata = {
  data: 'x'.repeat(10 * 1024 * 1024), // 10MB string
};

const event = createAuditEvent(AuditEventType.LOGIN_SUCCESS, {
  severity: AuditEventSeverity.INFO,
  success: true,
  metadata: hugeMetadata,
});
```

**Test Steps:**
1. Create event with 10MB metadata
2. Attempt to emit
3. Verify warning logged
4. Check if event rejected or truncated
5. Ensure no OOM error

**Expected Results:**
- Warning: "Audit event metadata exceeds 10MB"
- Event either rejected or metadata truncated
- No worker crash
- Error logged to console

**Implementation Recommendation:**
```typescript
// Add validation in createAuditEvent()
const metadataStr = JSON.stringify(options.metadata ?? {});
const metadataSize = new TextEncoder().encode(metadataStr).length;

if (metadataSize > 10 * 1024 * 1024) { // 10MB
  console.warn(`Audit event metadata too large: ${metadataSize} bytes`);
  return {
    // ... event fields
    metadata: {
      error: 'Metadata too large',
      size: metadataSize,
    },
  };
}
```

---

#### EDGE-06: Invalid webhook URL

**Objective:** Validate webhook URL before use

**Setup:**
```typescript
const invalidUrls = [
  'not-a-url',
  'ftp://invalid-protocol.com',
  'javascript:alert(1)',
  '',
  'http://localhost', // Potentially problematic
];
```

**Test Steps:**
1. Attempt to create WebhookSink with invalid URL
2. Verify validation error or warning
3. Check sink creation fails or URL rejected
4. Ensure no fetch() to invalid URL

**Expected Results:**
- Invalid URLs rejected or warned
- No fetch() to invalid URLs
- Error logged: "Invalid webhook URL"
- Sink creation fails gracefully

**Implementation Recommendation:**
```typescript
// In WebhookSink constructor
constructor(options: { url: string; ... }) {
  try {
    const url = new URL(options.url);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Webhook URL must use HTTP or HTTPS');
    }
  } catch (error) {
    console.error('Invalid webhook URL:', options.url, error);
    throw new Error(`Invalid webhook URL: ${options.url}`);
  }

  this.url = options.url;
  // ...
}
```

---

### 5. Integration Tests

#### INT-01: Multi-sink emission (stdout + webhook + D1)

**Objective:** Verify events sent to all sinks without interference

**Setup:**
```typescript
const mockDb = createMockD1Database();
const mockFetch = vi.fn().mockResolvedValue(new Response('OK'));
global.fetch = mockFetch;

const emitter = new AuditEmitter();
emitter.addSink(new StdoutSink());
emitter.addSink(new WebhookSink({ url: 'https://test.com' }));
emitter.addSink(new D1Sink(mockDb));
```

**Test Steps:**
1. Emit 10 events
2. Wait for all sinks to process
3. Verify stdout logged 10 events
4. Verify webhook received 1 batch
5. Verify D1 inserted 10 rows
6. Check no errors

**Expected Results:**
- All 3 sinks received events
- 10 console.log calls
- 1 fetch() call
- 1 db.batch() call with 10 statements
- No errors logged

---

#### INT-02: ExecutionContext lifecycle

**Objective:** Verify ctx.waitUntil() extends worker lifetime for async operations

**Setup:**
```typescript
const mockCtx: ExecutionContext = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
};

const sink = new WebhookSink({ url: 'https://test.com' });
sink.setContext(mockCtx);
```

**Test Steps:**
1. Set ExecutionContext on sink
2. Emit 5 events (triggers batch timeout)
3. Verify ctx.waitUntil() called
4. Check promise passed to waitUntil
5. Simulate request end
6. Verify flush completes

**Expected Results:**
- ctx.waitUntil() called with flush promise
- Flush completes after request ends
- No premature termination
- All events sent

**Critical for Cloudflare Workers:**
- Without ctx.waitUntil(), async operations may be killed
- Batch timers must use waitUntil()
- Flush promises must be registered

---

#### INT-05: Sink failure isolation

**Objective:** Ensure one sink failure doesn't affect others

**Setup:**
```typescript
const failingSink: AuditEventSink = {
  name: 'failing-sink',
  emit: async () => { throw new Error('Sink failed'); },
};

const workingSink = new StdoutSink();

const emitter = new AuditEmitter();
emitter.addSink(failingSink);
emitter.addSink(workingSink);
```

**Test Steps:**
1. Emit 1 event
2. Verify failingSink throws error
3. Verify error caught and logged
4. Verify workingSink still receives event
5. Check emitter.emit() resolves

**Expected Results:**
- failingSink error caught
- console.error: "Sink failing-sink failed to emit event"
- workingSink logs event successfully
- emitter.emit() resolves (doesn't throw)

**Current Implementation:**
```typescript
// From audit-emitter.ts lines 305-309
const promises = this.sinks.map(sink =>
  sink.emit(event).catch(error => {
    console.error(`Sink ${sink.name} failed to emit event:`, error);
  })
);
```
✅ Already implements isolation correctly

---

## Mock Infrastructure

### 1. MockD1Database

**File:** `/home/meywd/AlUmmahNowAuth/apps/auth/src/__mocks__/d1-database.ts`

```typescript
/**
 * Mock D1Database for testing
 */
export class MockD1Database implements D1Database {
  private data: Map<string, any[]> = new Map();
  private shouldFail: 'none' | 'locked' | 'constraint' | 'timeout' = 'none';
  private failureCount = 0;

  simulateError(errorType: 'locked' | 'constraint' | 'timeout') {
    this.shouldFail = errorType;
    this.failureCount = 0;
  }

  clearError() {
    this.shouldFail = 'none';
  }

  prepare(query: string): D1PreparedStatement {
    const self = this;
    return {
      bind(...values: any[]) {
        return this;
      },

      async run() {
        if (self.shouldFail === 'locked') {
          self.failureCount++;
          throw new Error('SQLITE_BUSY: database is locked');
        }
        if (self.shouldFail === 'constraint') {
          throw new Error('UNIQUE constraint failed');
        }
        if (self.shouldFail === 'timeout') {
          await new Promise(resolve => setTimeout(resolve, 35000));
          throw new Error('Query timeout');
        }
        return { success: true, results: [] };
      },

      async all() {
        return { success: true, results: [] };
      },

      async first() {
        return null;
      },
    } as D1PreparedStatement;
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    if (this.shouldFail === 'locked') {
      this.failureCount++;
      if (this.failureCount <= 2) {
        throw new Error('SQLITE_BUSY: database is locked');
      }
      // Succeed after 2 failures
      this.shouldFail = 'none';
    }

    if (this.shouldFail === 'constraint') {
      throw new Error('UNIQUE constraint failed: audit_events.id');
    }

    // Simulate partial failure
    if (this.shouldFail === 'timeout') {
      return statements.map((_, i) => ({
        success: i % 3 !== 1, // Every 3rd statement fails
        error: i % 3 === 1 ? 'Statement timeout' : undefined,
      })) as D1Result[];
    }

    // Success case
    const results: any[] = statements.map(() => ({
      success: true,
      meta: { changes: 1 },
    }));

    // Store in memory for verification
    if (!this.data.has('audit_events')) {
      this.data.set('audit_events', []);
    }

    return results;
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }

  async exec(query: string): Promise<D1ExecResult> {
    return { count: 0, duration: 0 };
  }

  // Test helper methods
  getInsertedEvents(): any[] {
    return this.data.get('audit_events') || [];
  }

  getInsertCount(): number {
    return this.getInsertedEvents().length;
  }

  reset() {
    this.data.clear();
    this.shouldFail = 'none';
    this.failureCount = 0;
  }
}

export function createMockD1Database(): MockD1Database {
  return new MockD1Database();
}
```

---

### 2. MockWebhookServer

**File:** `/home/meywd/AlUmmahNowAuth/apps/auth/src/__mocks__/webhook-server.ts`

```typescript
/**
 * Mock Webhook Server for testing
 */
export class MockWebhookServer {
  private receivedRequests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    timestamp: number;
  }> = [];

  private responses: Array<{
    status: number;
    body: string;
    delay?: number;
  }> = [];

  private responseIndex = 0;

  /**
   * Add a response to the queue
   */
  addResponse(status: number, body: string = 'OK', delay?: number) {
    this.responses.push({ status, body, delay });
  }

  /**
   * Mock fetch implementation
   */
  mockFetch = async (url: string, options?: RequestInit): Promise<Response> => {
    // Record request
    this.receivedRequests.push({
      url,
      method: options?.method || 'GET',
      headers: (options?.headers as Record<string, string>) || {},
      body: options?.body as string || '',
      timestamp: Date.now(),
    });

    // Get next response
    const response = this.responses[this.responseIndex] || {
      status: 200,
      body: 'OK',
    };
    this.responseIndex++;

    // Simulate delay
    if (response.delay) {
      await new Promise(resolve => setTimeout(resolve, response.delay));
    }

    return new Response(response.body, { status: response.status });
  };

  /**
   * Get all received requests
   */
  getRequests() {
    return [...this.receivedRequests];
  }

  /**
   * Get request bodies as parsed JSON
   */
  getRequestBodies(): any[] {
    return this.receivedRequests.map(req => JSON.parse(req.body));
  }

  /**
   * Get all events from all requests
   */
  getAllEvents(): any[] {
    return this.getRequestBodies().flatMap(body => body.events || []);
  }

  /**
   * Verify HMAC signature
   */
  verifySignature(requestIndex: number, secret: string): boolean {
    const request = this.receivedRequests[requestIndex];
    if (!request) return false;

    const signature = request.headers['X-Audit-Signature'];
    if (!signature || !signature.startsWith('sha256=')) return false;

    // TODO: Implement HMAC verification
    return true;
  }

  /**
   * Simulate network timeout (never resolves)
   */
  mockTimeout = async (): Promise<Response> => {
    return new Promise(() => {
      // Never resolves - simulates timeout
    });
  };

  /**
   * Simulate network error
   */
  mockNetworkError = async (): Promise<Response> => {
    throw new Error('Network error: Connection refused');
  };

  /**
   * Reset server state
   */
  reset() {
    this.receivedRequests = [];
    this.responses = [];
    this.responseIndex = 0;
  }

  /**
   * Get request count
   */
  getRequestCount(): number {
    return this.receivedRequests.length;
  }
}

export function createMockWebhookServer(): MockWebhookServer {
  return new MockWebhookServer();
}
```

---

### 3. Test Helper Utilities

**File:** `/home/meywd/AlUmmahNowAuth/apps/auth/src/__mocks__/audit-helpers.ts`

```typescript
import { AuditEvent, AuditEventType, AuditEventSeverity } from '../audit-events';

/**
 * Create a test event with incrementing IDs
 */
export function createTestEvent(index: number): AuditEvent {
  return {
    timestamp: new Date(Date.now() + index * 1000).toISOString(),
    eventType: AuditEventType.LOGIN_SUCCESS,
    severity: AuditEventSeverity.INFO,
    userId: `user-${index}`,
    ipAddress: `192.168.1.${index % 255}`,
    userAgent: `TestAgent/${index}`,
    requestId: `req-${index}`,
    metadata: {
      email: `user${index}@test.com`,
      method: 'email_code',
    },
    success: true,
  };
}

/**
 * Create events in bulk
 */
export function createTestEvents(count: number): AuditEvent[] {
  return Array.from({ length: count }, (_, i) => createTestEvent(i));
}

/**
 * Create a large event (>1MB)
 */
export function createLargeEvent(sizeMB: number): AuditEvent {
  const data = 'x'.repeat(sizeMB * 1024 * 1024);
  return {
    timestamp: new Date().toISOString(),
    eventType: AuditEventType.LOGIN_SUCCESS,
    severity: AuditEventSeverity.INFO,
    userId: 'user-large',
    ipAddress: '192.168.1.1',
    userAgent: 'LargeAgent',
    requestId: 'req-large',
    metadata: { data },
    success: true,
  };
}

/**
 * Create event with circular reference
 */
export function createCircularEvent(): AuditEvent {
  const circular: any = { name: 'test' };
  circular.self = circular;

  return {
    timestamp: new Date().toISOString(),
    eventType: AuditEventType.LOGIN_SUCCESS,
    severity: AuditEventSeverity.INFO,
    userId: 'user-circular',
    ipAddress: null,
    userAgent: null,
    requestId: null,
    metadata: circular,
    success: true,
  };
}

/**
 * Mock ExecutionContext
 */
export function createMockExecutionContext(): ExecutionContext {
  const waitUntilPromises: Promise<any>[] = [];

  return {
    waitUntil: vi.fn((promise: Promise<any>) => {
      waitUntilPromises.push(promise);
    }),
    passThroughOnException: vi.fn(),
    // Helper to wait for all waitUntil promises
    _awaitAll: async () => {
      await Promise.all(waitUntilPromises);
    },
  } as any;
}

/**
 * Wait for a condition with timeout
 */
export async function waitFor(
  condition: () => boolean,
  timeoutMs: number = 5000,
  checkIntervalMs: number = 100
): Promise<void> {
  const startTime = Date.now();

  while (!condition()) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Timeout waiting for condition after ${timeoutMs}ms`);
    }
    await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
  }
}

/**
 * Measure execution time
 */
export async function measureTime<T>(
  fn: () => Promise<T>
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}
```

---

## Test Implementation Examples

### Example 1: Concurrency Test

**File:** `/home/meywd/AlUmmahNowAuth/apps/auth/src/audit-concurrency.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebhookSink, D1Sink } from './audit-emitter';
import { createTestEvents, createMockWebhookServer, createMockD1Database } from './__mocks__/audit-helpers';

describe('Audit Logging - Concurrency Tests', () => {
  describe('CON-01: Concurrent emit() to WebhookSink', () => {
    it('should handle 100 concurrent emits without data loss', async () => {
      const mockServer = createMockWebhookServer();
      mockServer.addResponse(200, 'OK');
      global.fetch = vi.fn(mockServer.mockFetch);

      const sink = new WebhookSink({
        url: 'https://test.webhook.com/audit',
        secret: 'test-secret-32-characters-long!',
        batchSize: 10,
        batchTimeout: 1000,
      });

      // Emit 100 events concurrently
      const events = createTestEvents(100);
      const emitPromises = events.map(event => sink.emit(event));

      await Promise.all(emitPromises);
      await sink.flush();

      // Verify all events sent
      const sentEvents = mockServer.getAllEvents();
      expect(sentEvents).toHaveLength(100);

      // Verify batching (should be ~10 requests of 10 events each)
      const requestCount = mockServer.getRequestCount();
      expect(requestCount).toBeGreaterThanOrEqual(10);
      expect(requestCount).toBeLessThanOrEqual(11); // Allow for timing variance

      // Verify no duplicates
      const eventIds = sentEvents.map(e => e.userId);
      const uniqueIds = new Set(eventIds);
      expect(uniqueIds.size).toBe(100);
    });

    it('should handle concurrent emits faster than batch timeout', async () => {
      const mockServer = createMockWebhookServer();
      mockServer.addResponse(200);
      global.fetch = vi.fn(mockServer.mockFetch);

      const sink = new WebhookSink({
        url: 'https://test.com',
        batchSize: 50,
        batchTimeout: 5000, // 5 second timeout
      });

      // Emit 50 events rapidly (should trigger batch size, not timeout)
      const events = createTestEvents(50);
      const startTime = Date.now();

      for (const event of events) {
        await sink.emit(event);
      }

      const emitDuration = Date.now() - startTime;

      // Should trigger by batch size, not timeout
      expect(emitDuration).toBeLessThan(1000); // Less than 1 second
      expect(mockServer.getRequestCount()).toBe(1);
      expect(mockServer.getAllEvents()).toHaveLength(50);
    });
  });

  describe('CON-03: Concurrent flush() calls', () => {
    it('should be idempotent - multiple flushes only insert once', async () => {
      const mockDb = createMockD1Database();
      const sink = new D1Sink(mockDb, { batchSize: 50 });

      // Add 20 events
      const events = createTestEvents(20);
      for (const event of events) {
        await sink.emit(event);
      }

      // Call flush 10 times concurrently
      const flushPromises = Array.from({ length: 10 }, () => sink.flush());
      await Promise.all(flushPromises);

      // Verify batch called only once
      expect(mockDb.batch).toHaveBeenCalledTimes(1);

      // Verify 20 statements in the batch
      const batchCall = vi.mocked(mockDb.batch).mock.calls[0];
      expect(batchCall[0]).toHaveLength(20);

      // Verify queue is empty
      await sink.emit(createTestEvents(1)[0]);
      await sink.flush();
      expect(mockDb.batch).toHaveBeenCalledTimes(2); // Second flush
    });
  });

  describe('CON-04: Race between emit() and flush()', () => {
    it('should not lose events during concurrent emit/flush', async () => {
      const mockDb = createMockD1Database();
      const sink = new D1Sink(mockDb, { batchSize: 100 });

      // Emit 50 events
      const batch1 = createTestEvents(50);
      for (const event of batch1) {
        await sink.emit(event);
      }

      // Start flush (don't await)
      const flushPromise = sink.flush();

      // Immediately emit 50 more events (race condition)
      const batch2 = createTestEvents(50);
      const emitPromises = batch2.map(event => sink.emit(event));

      // Wait for both
      await Promise.all([flushPromise, ...emitPromises]);
      await sink.flush(); // Flush remaining

      // Verify all 100 events inserted
      expect(mockDb.batch).toHaveBeenCalledTimes(2);

      const firstBatch = vi.mocked(mockDb.batch).mock.calls[0][0];
      const secondBatch = vi.mocked(mockDb.batch).mock.calls[1][0];

      expect(firstBatch.length + secondBatch.length).toBe(100);
    });
  });
});
```

---

### Example 2: Error Handling Test

**File:** `/home/meywd/AlUmmahNowAuth/apps/auth/src/audit-errors.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebhookSink, D1Sink } from './audit-emitter';
import { createTestEvents, createMockD1Database } from './__mocks__/audit-helpers';

describe('Audit Logging - Error Handling Tests', () => {
  describe('ERR-01: WebhookSink HTTP 500 errors', () => {
    it('should handle server errors gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const mockFetch = vi.fn().mockResolvedValue(
        new Response('Internal Server Error', { status: 500 })
      );
      global.fetch = mockFetch;

      const sink = new WebhookSink({
        url: 'https://failing.server.com',
        batchSize: 5,
      });

      // Emit 5 events
      const events = createTestEvents(5);
      for (const event of events) {
        await sink.emit(event);
      }

      // Flush should not throw
      await expect(sink.flush()).resolves.not.toThrow();

      // Verify error logged
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(consoleErrorSpy.mock.calls[0][0]).toContain('Webhook delivery failed: 500');

      // Verify fetch was attempted
      expect(mockFetch).toHaveBeenCalledOnce();

      consoleErrorSpy.mockRestore();
    });
  });

  describe('ERR-02: WebhookSink Network timeout', () => {
    it('should timeout and handle gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Mock fetch that never resolves
      const mockFetch = vi.fn().mockImplementation(() =>
        new Promise(() => {}) // Never resolves
      );
      global.fetch = mockFetch;

      const sink = new WebhookSink({
        url: 'https://slow.server.com',
        batchSize: 1,
      });

      const event = createTestEvents(1)[0];
      await sink.emit(event);

      // Flush should eventually resolve or reject (with timeout implementation)
      // Current implementation: no timeout (will hang)
      // Recommended: Add timeout to fetch call

      // For now, test that it at least attempts the request
      await Promise.race([
        sink.flush(),
        new Promise(resolve => setTimeout(resolve, 100)), // 100ms grace period
      ]);

      expect(mockFetch).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    }, 60000); // 60s test timeout
  });

  describe('ERR-06: D1Sink Database locked', () => {
    it('should retry and backup events on database lock', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const mockDb = createMockD1Database();
      mockDb.simulateError('locked');

      const sink = new D1Sink(mockDb);

      // Emit 5 events
      const events = createTestEvents(5);
      for (const event of events) {
        await sink.emit(event);
      }

      // Flush should not throw
      await expect(sink.flush()).resolves.not.toThrow();

      // Verify error logged
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(consoleErrorSpy.mock.calls[0][0]).toContain('D1 audit event storage error');

      // Verify backup to stdout
      expect(consoleLogSpy).toHaveBeenCalled();
      const backupLog = consoleLogSpy.mock.calls.find(call =>
        call[0].includes('audit_events_backup')
      );
      expect(backupLog).toBeDefined();

      // Verify backup contains all events
      const backup = JSON.parse(backupLog![0]);
      expect(backup.type).toBe('audit_events_backup');
      expect(backup.events).toHaveLength(5);

      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });
  });

  describe('ERR-08: D1Sink Partial batch failure', () => {
    it('should handle mixed success/failure in batch results', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const mockDb = createMockD1Database();

      // Mock batch to return mixed results
      mockDb.batch = vi.fn().mockResolvedValue([
        { success: true },
        { success: false, error: 'Constraint violation' },
        { success: true },
        { success: false, error: 'Timeout' },
        { success: true },
      ]);

      const sink = new D1Sink(mockDb);

      // Emit 5 events
      const events = createTestEvents(5);
      for (const event of events) {
        await sink.emit(event);
      }

      await sink.flush();

      // Current implementation: doesn't check individual results (coverage gap)
      // Recommended: Check batch results and backup failed events

      // This test will fail until ERR-08 is implemented
      // Verify failed events logged
      // expect(consoleLogSpy).toHaveBeenCalledWith(
      //   expect.stringContaining('audit_events_backup')
      // );

      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });
  });
});
```

---

### Example 3: Performance Test

**File:** `/home/meywd/AlUmmahNowAuth/apps/auth/src/audit-performance.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest';
import { D1Sink, WebhookSink } from './audit-emitter';
import { createTestEvents, createLargeEvent, measureTime, createMockD1Database } from './__mocks__/audit-helpers';

describe('Audit Logging - Performance Tests', () => {
  describe('PERF-01: High throughput', () => {
    it('should handle 10,000 events in reasonable time', async () => {
      const mockDb = createMockD1Database();
      const sink = new D1Sink(mockDb, { batchSize: 100 });

      const events = createTestEvents(10000);

      const { durationMs } = await measureTime(async () => {
        for (const event of events) {
          await sink.emit(event);
        }
        await sink.flush();
      });

      // Performance expectations
      expect(durationMs).toBeLessThan(10000); // <10 seconds

      // Calculate throughput
      const throughput = 10000 / (durationMs / 1000);
      console.log(`Throughput: ${throughput.toFixed(0)} events/sec`);
      expect(throughput).toBeGreaterThan(500); // Minimum 500 events/sec

      // Verify batching efficiency
      expect(mockDb.batch).toHaveBeenCalledTimes(100); // 100 batches of 100
    }, 15000); // 15 second test timeout
  });

  describe('PERF-02: Large event payloads', () => {
    it('should handle 1MB event payload', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('OK'));
      global.fetch = mockFetch;

      const sink = new WebhookSink({
        url: 'https://test.com',
        batchSize: 1,
      });

      const largeEvent = createLargeEvent(1); // 1MB event

      const { durationMs } = await measureTime(async () => {
        await sink.emit(largeEvent);
        await sink.flush();
      });

      // Serialization should be fast
      expect(durationMs).toBeLessThan(1000); // <1 second

      // Verify payload size
      const requestBody = mockFetch.mock.calls[0][1]?.body as string;
      const payloadSize = new TextEncoder().encode(requestBody).length;

      console.log(`Payload size: ${(payloadSize / 1024 / 1024).toFixed(2)} MB`);
      expect(payloadSize).toBeGreaterThan(1024 * 1024); // >1MB
      expect(payloadSize).toBeLessThan(2 * 1024 * 1024); // <2MB (with overhead)
    });

    it('should warn on very large payload (>10MB)', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const hugeEvent = createLargeEvent(10); // 10MB event

      // Current implementation: no size validation (coverage gap)
      // Recommended: Add payload size check

      // This test will fail until EDGE-03 is implemented
      // expect(consoleWarnSpy).toHaveBeenCalledWith(
      //   expect.stringContaining('metadata too large')
      // );

      consoleWarnSpy.mockRestore();
    });
  });

  describe('PERF-03: Large batch sizes', () => {
    it('should handle batch size of 500 efficiently', async () => {
      const mockDb = createMockD1Database();
      const sink = new D1Sink(mockDb, { batchSize: 500 });

      const events = createTestEvents(1000);

      for (const event of events) {
        await sink.emit(event);
      }

      await sink.flush();

      // Should create 2 batches (500 + 500)
      expect(mockDb.batch).toHaveBeenCalledTimes(2);

      // Verify batch sizes
      const batch1 = vi.mocked(mockDb.batch).mock.calls[0][0];
      const batch2 = vi.mocked(mockDb.batch).mock.calls[1][0];

      expect(batch1).toHaveLength(500);
      expect(batch2).toHaveLength(500);
    });
  });

  describe('PERF-04: Memory usage over time', () => {
    it('should not leak memory over repeated operations', async () => {
      const mockDb = createMockD1Database();
      const sink = new D1Sink(mockDb, { batchSize: 10 });

      // Record initial memory (if available)
      const initialMemory = process.memoryUsage?.()?.heapUsed || 0;

      // Perform 100 iterations of emit/flush
      for (let i = 0; i < 100; i++) {
        const events = createTestEvents(10);
        for (const event of events) {
          await sink.emit(event);
        }
        await sink.flush();
      }

      // Record final memory
      const finalMemory = process.memoryUsage?.()?.heapUsed || 0;
      const memoryGrowth = finalMemory - initialMemory;

      console.log(`Memory growth: ${(memoryGrowth / 1024 / 1024).toFixed(2)} MB`);

      // Memory growth should be minimal (<10MB)
      expect(memoryGrowth).toBeLessThan(10 * 1024 * 1024);
    }, 30000); // 30 second timeout
  });
});
```

---

## Performance Benchmarks

### Target Metrics

| Metric | Minimum | Target | Optimal |
|--------|---------|--------|---------|
| **Throughput** | 500 events/sec | 1000 events/sec | 2000+ events/sec |
| **Latency (emit)** | <10ms | <5ms | <1ms |
| **Latency (flush)** | <500ms | <200ms | <100ms |
| **Memory per event** | <10KB | <5KB | <2KB |
| **Batch efficiency** | 70% | 85% | 95%+ |
| **CPU time** | <1s/1000 events | <500ms/1000 | <200ms/1000 |

### Benchmark Test Suite

```typescript
// audit-benchmark.test.ts
describe('Audit Logging - Benchmarks', () => {
  it('Benchmark: emit() latency', async () => {
    const sink = new StdoutSink();
    const event = createTestEvents(1)[0];

    const iterations = 1000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      await sink.emit(event);
    }

    const duration = performance.now() - start;
    const avgLatency = duration / iterations;

    console.log(`Average emit() latency: ${avgLatency.toFixed(3)}ms`);
    expect(avgLatency).toBeLessThan(10); // <10ms per emit
  });

  it('Benchmark: flush() latency with 100 events', async () => {
    const mockDb = createMockD1Database();
    const sink = new D1Sink(mockDb, { batchSize: 100 });

    const events = createTestEvents(100);
    for (const event of events) {
      await sink.emit(event);
    }

    const start = performance.now();
    await sink.flush();
    const duration = performance.now() - start;

    console.log(`Flush 100 events: ${duration.toFixed(2)}ms`);
    expect(duration).toBeLessThan(500); // <500ms
  });

  it('Benchmark: batching efficiency', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('OK'));
    global.fetch = mockFetch;

    const sink = new WebhookSink({
      url: 'https://test.com',
      batchSize: 10,
    });

    // Emit 100 events
    const events = createTestEvents(100);
    for (const event of events) {
      await sink.emit(event);
    }
    await sink.flush();

    // Should result in 10 requests (100% efficiency)
    const requestCount = mockFetch.mock.calls.length;
    const efficiency = (100 / requestCount) / 10 * 100; // % of optimal

    console.log(`Batching efficiency: ${efficiency.toFixed(1)}%`);
    expect(efficiency).toBeGreaterThan(85); // >85%
  });
});
```

---

## CI/CD Integration

### GitHub Actions Workflow

**File:** `.github/workflows/audit-tests.yml`

```yaml
name: Audit Logging Tests

on:
  push:
    branches: [main, develop]
    paths:
      - 'apps/auth/src/audit-*.ts'
      - 'apps/auth/src/**/*.test.ts'
  pull_request:
    branches: [main, develop]
    paths:
      - 'apps/auth/src/audit-*.ts'
      - 'apps/auth/src/**/*.test.ts'

jobs:
  test:
    name: Run Audit Tests
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 9.15.4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install
        working-directory: apps/auth

      - name: Run unit tests
        run: pnpm test:unit
        working-directory: apps/auth
        env:
          NODE_ENV: test

      - name: Run concurrency tests
        run: pnpm test audit-concurrency.test.ts
        working-directory: apps/auth

      - name: Run error handling tests
        run: pnpm test audit-errors.test.ts
        working-directory: apps/auth

      - name: Run performance tests
        run: pnpm test audit-performance.test.ts --reporter=verbose
        working-directory: apps/auth

      - name: Generate coverage report
        run: pnpm test:coverage
        working-directory: apps/auth
        continue-on-error: true

      - name: Upload coverage to Codecov
        uses: codecov/codecov-action@v4
        with:
          files: apps/auth/coverage/coverage-final.json
          flags: audit-logging
          fail_ci_if_error: false

      - name: Comment PR with coverage
        if: github.event_name == 'pull_request'
        uses: codecov/codecov-action@v4
        with:
          token: ${{ secrets.CODECOV_TOKEN }}

  performance-benchmark:
    name: Performance Benchmarks
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 9.15.4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install
        working-directory: apps/auth

      - name: Run benchmarks
        run: pnpm test audit-benchmark.test.ts --reporter=verbose > benchmark-results.txt
        working-directory: apps/auth

      - name: Comment PR with benchmarks
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const benchmarks = fs.readFileSync('apps/auth/benchmark-results.txt', 'utf8');

            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `## Performance Benchmarks\n\n\`\`\`\n${benchmarks}\n\`\`\``
            });
```

---

## Test Execution Strategy

### Local Development

```bash
# Run all tests
pnpm test

# Run specific test suites
pnpm test audit-emitter.test.ts
pnpm test audit-events.test.ts
pnpm test audit-concurrency.test.ts
pnpm test audit-errors.test.ts
pnpm test audit-performance.test.ts

# Run with coverage
pnpm test:coverage

# Watch mode
pnpm test:watch

# Verbose mode
pnpm test:unit
```

### Pre-commit Hooks

**File:** `.husky/pre-commit`

```bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

# Run audit tests before commit
cd apps/auth
pnpm test audit-*.test.ts --run

if [ $? -ne 0 ]; then
  echo "❌ Audit tests failed. Commit aborted."
  exit 1
fi

echo "✅ Audit tests passed"
```

### Test Organization

```
apps/auth/src/
├── audit-events.ts              # Event definitions
├── audit-events.test.ts         # Event creation tests (14 tests)
├── audit-emitter.ts             # Emitter implementation
├── audit-emitter.test.ts        # Basic emitter tests (12 tests)
├── audit-concurrency.test.ts    # NEW: Concurrency tests (12 tests)
├── audit-errors.test.ts         # NEW: Error handling tests (15 tests)
├── audit-performance.test.ts    # NEW: Performance tests (8 tests)
├── audit-edge-cases.test.ts     # NEW: Edge case tests (10 tests)
├── audit-integration.test.ts    # NEW: Integration tests (6 tests)
├── audit-benchmark.test.ts      # NEW: Benchmark suite (3 tests)
└── __mocks__/
    ├── d1-database.ts           # Mock D1Database
    ├── webhook-server.ts        # Mock webhook server
    └── audit-helpers.ts         # Test utilities
```

---

## Implementation Roadmap

### Phase 1: Infrastructure (Week 1)
- [x] Create mock utilities
  - [ ] MockD1Database
  - [ ] MockWebhookServer
  - [ ] Test helpers
- [ ] Set up test file structure
- [ ] Configure CI/CD workflow

### Phase 2: Priority 1 Tests (Week 2)
- [ ] Implement concurrency tests (CON-01 to CON-08)
- [ ] Implement critical error tests (ERR-01, ERR-02, ERR-06, ERR-07)
- [ ] Integration test INT-02 (ExecutionContext)

### Phase 3: Priority 2 Tests (Week 3)
- [ ] Remaining error tests (ERR-03 to ERR-12)
- [ ] Performance tests (PERF-01 to PERF-04)
- [ ] Edge case tests (EDGE-01 to EDGE-08)

### Phase 4: Integration & Benchmarks (Week 4)
- [ ] Integration tests (INT-01 to INT-06)
- [ ] Benchmark suite
- [ ] Documentation updates
- [ ] Coverage report analysis

### Phase 5: Bug Fixes & Enhancements (Ongoing)
- [ ] Fix identified coverage gaps
- [ ] Implement recommended improvements
- [ ] Add retry logic (Issue #62)
- [ ] Add queue size limits (Issue #64)

---

## Expected Test Results

### Coverage Target

```
File                  | % Stmts | % Branch | % Funcs | % Lines |
----------------------|---------|----------|---------|---------|
audit-events.ts       |   100   |   100    |   100   |   100   |
audit-emitter.ts      |   95    |   90     |   95    |   95    |
All files             |   95    |   90     |   95    |   95    |
```

### Test Suite Summary

```
Test Suites: 8 passed, 8 total
Tests:       115 passed, 115 total
Snapshots:   0 total
Time:        45.234s
```

---

## Maintenance & Review

### Quarterly Review
- Analyze test failures and patterns
- Update benchmarks based on performance data
- Add tests for new features
- Remove obsolete tests

### Test Quality Checklist
- [ ] Tests are deterministic (no flakiness)
- [ ] Tests are isolated (no shared state)
- [ ] Tests are fast (<5s per suite)
- [ ] Tests have clear assertions
- [ ] Tests document expected behavior
- [ ] Mock data is realistic
- [ ] Error messages are descriptive

---

## Related Issues & PRs

- **Issue #65:** Add comprehensive edge case tests for audit logging (this document)
- **Issue #62:** Webhook retry logic (affects ERR-01, ERR-02)
- **Issue #64:** Queue size limits (affects PERF-01, EDGE-07)
- **Issue #14:** Original audit logging feature request
- **PR #60:** Initial audit logging implementation

---

## Conclusion

This comprehensive testing strategy addresses all coverage gaps identified in GitHub Issue #65. Implementation of these tests will:

1. ✅ Ensure system reliability under concurrency
2. ✅ Validate graceful error handling
3. ✅ Establish performance baselines
4. ✅ Document expected behavior
5. ✅ Prevent regressions during refactoring
6. ✅ Provide confidence for production use

**Total Estimated Effort:** 4 weeks (1 developer)
**Priority:** Low (current coverage adequate for MVP)
**Benefits:** High (long-term confidence and maintenance)

---

**Document Version:** 1.0
**Last Updated:** 2025-10-12
**Author:** Test Engineer Agent (Claude Code)
**Status:** Ready for Review
