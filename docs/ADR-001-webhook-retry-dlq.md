# ADR-001: Webhook Retry Logic with Dead Letter Queue

## Status
**Proposed**

## Context

The current audit event webhook implementation in `apps/auth/src/audit-emitter.ts` lacks retry logic for failed deliveries. When webhook endpoints are temporarily unavailable or return transient errors, audit events are silently dropped after a single attempt. This poses compliance and security risks as critical security events may be lost.

### Current Issues:
1. **No retry mechanism**: Single attempt, then drop
2. **Silent failures**: Events lost without recovery option
3. **No persistence**: Failed events aren't stored for later analysis
4. **Limited observability**: Difficult to track delivery failures

## Decision

Implement a robust webhook delivery system with:
1. **Exponential backoff retry mechanism** for transient failures
2. **Dead Letter Queue (DLQ)** using D1 database for persistent storage
3. **Manual replay capability** for operational recovery
4. **Enhanced logging** for monitoring and debugging

### Architecture Overview

```
┌─────────────────┐
│  Audit Event    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  WebhookSink    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     Success
│  fetchWithRetry │ ─────────────► External Webhook
└────────┬────────┘
         │
         │ Failed after retries
         ▼
┌─────────────────┐
│   DLQ Storage   │
│  (D1 Database)  │
└─────────────────┘
         │
         ▼
┌─────────────────┐
│  Manual Replay  │
│   (Optional)    │
└─────────────────┘
```

## Implementation Details

### 1. Retry Strategy

**Configuration:**
- Max retries: 3 attempts
- Backoff delays: 1s, 2s, 4s
- Max delay cap: 5s
- Total timeout: ~7s worst case

**Retry Conditions:**
- Network errors (connection failures)
- Server errors (5xx responses)
- Timeouts

**No-Retry Conditions:**
- Client errors (4xx responses) - These are permanent failures
- Authentication failures (401, 403)

### 2. Dead Letter Queue Schema

```sql
CREATE TABLE webhook_dlq (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  events TEXT NOT NULL,          -- JSON array of AuditEvent objects
  webhook_url TEXT NOT NULL,     -- Target webhook URL
  error TEXT,                     -- Last error message
  timestamp TEXT NOT NULL,        -- ISO8601 timestamp of failure
  retry_count INTEGER DEFAULT 0, -- Number of retries attempted
  status TEXT DEFAULT 'pending',  -- pending, replaying, completed, failed
  replayed_at TEXT,               -- When manual replay occurred
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_webhook_dlq_timestamp ON webhook_dlq(timestamp);
CREATE INDEX idx_webhook_dlq_status ON webhook_dlq(status);
CREATE INDEX idx_webhook_dlq_created_at ON webhook_dlq(created_at);
```

### 3. Enhanced WebhookSink Class

Key changes:
- Add `fetchWithRetry()` method for retry logic
- Inject D1Database for DLQ storage
- Add metrics tracking for monitoring
- Implement circuit breaker pattern (future enhancement)

### 4. Manual Replay Mechanism

```typescript
interface DLQReplayOptions {
  batchSize?: number;      // Default: 10
  maxAge?: number;         // Max age in hours, default: 24
  filterStatus?: string;   // Filter by status
}

class DLQReplayService {
  async replayFailedEvents(options: DLQReplayOptions): Promise<ReplayResult>
  async getQueuedEvents(limit: number): Promise<DLQEntry[]>
  async markAsReplayed(ids: number[]): Promise<void>
}
```

## Consequences

### Positive
- **Improved reliability**: Transient failures handled automatically
- **Event durability**: Failed events preserved in DLQ
- **Operational visibility**: Clear tracking of delivery failures
- **Compliance**: Audit trail integrity maintained
- **Recovery capability**: Manual replay for extended outages
- **Performance**: Non-blocking async retries with ExecutionContext

### Negative
- **Increased latency**: Up to 7s delay for failed deliveries
  - *Mitigation*: Use ExecutionContext.waitUntil() for background processing
- **Storage overhead**: DLQ entries consume D1 storage
  - *Mitigation*: Implement TTL-based cleanup (30 days retention)
- **Complexity**: More code to maintain and test
  - *Mitigation*: Comprehensive unit tests and documentation

## Alternatives Considered

### 1. Cloudflare Queues
**Pros:**
- Built-in retry logic
- Automatic backpressure
- Native integration

**Cons:**
- Additional service dependency
- Separate billing
- Migration complexity

**Decision:** Deferred for future consideration. Current D1-based solution is sufficient for initial requirements.

### 2. In-Memory Retry Queue
**Pros:**
- Simple implementation
- Fast access

**Cons:**
- Events lost on worker restart
- No persistence
- Limited capacity

**Decision:** Rejected due to lack of durability.

### 3. External Queue Service (SQS/RabbitMQ)
**Pros:**
- Feature-rich
- Battle-tested

**Cons:**
- External dependency
- Network latency
- Complexity

**Decision:** Rejected as over-engineering for current needs.

## Implementation Notes

### Phase 1: Core Retry Logic (Priority: High)
1. Implement `fetchWithRetry()` method
2. Add exponential backoff calculation
3. Handle different error types appropriately
4. Add comprehensive logging

### Phase 2: Dead Letter Queue (Priority: High)
1. Create migration for DLQ table
2. Update WebhookSink constructor to accept D1Database
3. Implement DLQ storage on final failure
4. Add metrics collection

### Phase 3: Manual Replay (Priority: Medium)
1. Create DLQReplayService class
2. Add admin API endpoints for replay
3. Implement batch processing
4. Add UI in admin dashboard

### Phase 4: Monitoring & Alerting (Priority: Low)
1. Add metrics endpoints
2. Create dashboard for DLQ monitoring
3. Set up alerts for high failure rates
4. Implement circuit breaker pattern

## Security Considerations

1. **DLQ Data Encryption**: Sensitive event data stored encrypted at rest (D1 handles this)
2. **Access Control**: DLQ replay requires admin privileges
3. **Rate Limiting**: Prevent DLQ flooding through rate limits
4. **Data Retention**: Automatic cleanup after 30 days
5. **Webhook Secrets**: Maintain HMAC signature validation during retries

## Testing Strategy

### Unit Tests
- Retry logic with various failure scenarios
- Exponential backoff calculation
- DLQ storage and retrieval
- Error type discrimination (4xx vs 5xx)

### Integration Tests
- End-to-end webhook delivery with mock server
- DLQ persistence and replay
- Concurrent event handling
- ExecutionContext integration

### Load Tests
- High volume event generation
- Webhook endpoint failures under load
- DLQ capacity testing
- Replay performance

## Monitoring & Observability

### Metrics to Track
- Webhook delivery success rate
- Average retry count per event
- DLQ queue depth
- Replay success rate
- P95 delivery latency

### Logging
- Every retry attempt with delay
- Final failures with full context
- DLQ operations
- Replay operations

## Migration Plan

1. **Deploy DLQ table migration** (0010_create_webhook_dlq_table.sql)
2. **Update WebhookSink** with retry logic (backward compatible)
3. **Enable DLQ storage** via environment configuration
4. **Deploy manual replay service** (optional initially)
5. **Monitor and tune** retry parameters based on production data

## References

- [Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html)
- [Cloudflare Workers ExecutionContext](https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/#lifecycle-methods)
- [D1 Database Documentation](https://developers.cloudflare.com/d1/)

## Decision Date
2025-01-12

## Review Date
2025-04-12 (3 months)