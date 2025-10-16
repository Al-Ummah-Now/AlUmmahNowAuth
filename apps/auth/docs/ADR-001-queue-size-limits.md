# ADR-001: Queue Size Limits for Audit Event Sinks

## Status
Proposed

## Context
The audit logging system in AlUmmahNowAuth uses batched sinks (WebhookSink and D1Sink) to efficiently deliver audit events to external systems. These sinks maintain in-memory queues that batch events before flushing them to their destinations.

**Problem**: If webhook endpoints are down or D1 is unavailable for extended periods, the event queues could grow unbounded, potentially causing:
- Memory exhaustion (Cloudflare Workers have 128MB limit)
- Worker crashes
- Loss of all queued events
- Degraded authentication service performance

**Current State**:
- No queue size limits
- Events accumulate indefinitely during outages
- No visibility into queue health
- No recovery mechanism for dropped events

## Decision

We will implement queue size limits with a FIFO (First In, First Out) drop strategy when queues reach capacity. This includes:

1. **Hard Queue Limits**: Default 1,000 events per sink (configurable)
2. **Drop Strategy**: Drop oldest events when queue is full
3. **Comprehensive Metrics**: Track drops, utilization, high water marks
4. **Progressive Warnings**: Log at 80% (warn) and 90% (critical) capacity
5. **Fallback Logging**: Log dropped events to stdout for potential recovery
6. **Smart Requeue**: Attempt to requeue on flush failures with overflow protection

### Why FIFO Drop Strategy?

After evaluating multiple approaches:

| Strategy | Complexity | Performance | Predictability | Chosen |
|----------|------------|-------------|----------------|--------|
| Drop Oldest (FIFO) | Simple | O(n) shift | High | ✅ |
| Drop by Severity | Complex | O(n) search | Low | ❌ |
| Ring Buffer | Moderate | O(1) | High | ❌ |
| Circuit Breaker | Simple | O(1) | Medium | ❌ |

FIFO was selected for its simplicity and predictability, essential qualities for a security-critical audit system.

## Consequences

### Positive
- **Memory Protection**: Hard limits prevent unbounded growth (max ~1MB per sink at 1,000 events)
- **Service Resilience**: Authentication service remains operational during audit system issues
- **Visibility**: Comprehensive metrics enable proactive monitoring
- **Recovery Options**: Dropped events logged to stdout can be recovered from logs
- **Gradual Degradation**: Progressive warnings allow intervention before data loss
- **Configuration Flexibility**: Limits can be tuned per environment

### Negative
- **Data Loss**: Older audit events will be lost during sustained outages
- **Compliance Risk**: May lose audit trail continuity required for compliance
- **Performance Impact**: O(n) array shift operation (mitigated by small queue sizes)
- **Operational Overhead**: Requires monitoring and tuning

### Mitigations
- Set conservative limits (1,000 events = ~1MB memory)
- Log all dropped events to stdout for recovery
- Monitor queue metrics and alert on drops
- Consider implementing persistent overflow storage (future enhancement)

## Alternatives Considered

### 1. No Limits (Current State)
- **Rejected**: Unbounded growth risks worker crashes and total data loss

### 2. Drop by Severity
- **Rejected**: Complex priority logic, may lose all info-level events, harder to debug

### 3. Circuit Breaker Pattern
- **Rejected**: Complete data loss during breaks, requires complex state management

### 4. Persistent Queue (KV/R2)
- **Rejected**: Added complexity and latency, better as future enhancement

### 5. Backpressure Propagation
- **Rejected**: Could impact authentication flows, unacceptable for security service

## Implementation Notes

### Configuration Recommendations

```typescript
// Development
{
  maxQueueSize: 10000,  // Large for debugging
  batchSize: 1,         // Immediate flush
}

// Production
{
  maxQueueSize: 1000,   // Conservative
  batchSize: 50,        // Optimize throughput
}

// High-Volume
{
  maxQueueSize: 2000,   // Larger buffer
  batchSize: 100,       // Maximum batching
}
```

### Memory Analysis

| Queue Size | Memory Usage | % of 128MB Limit |
|------------|--------------|------------------|
| 1,000      | ~1MB         | 0.78%           |
| 5,000      | ~5MB         | 3.91%           |
| 10,000     | ~10MB        | 7.81%           |

### Monitoring Queries

```sql
-- Find dropped events
SELECT * FROM logs
WHERE message LIKE '%queue overflow%'
ORDER BY timestamp DESC;

-- Aggregate drops by hour
SELECT
  DATE_TRUNC('hour', timestamp) as hour,
  COUNT(*) as drop_events
FROM logs
WHERE message LIKE '%queue overflow%'
GROUP BY 1;
```

### Migration Plan

1. **Phase 1**: Deploy with high limits (100,000)
2. **Phase 2**: Monitor and reduce to 10,000
3. **Phase 3**: Optimize to 1,000 based on metrics

### Key Metrics to Track

- `queueUtilization`: Current usage percentage
- `droppedEvents`: Total events dropped
- `highWaterMark`: Maximum queue size reached
- `oldestEventAge`: Age of oldest queued event

## Related

- Issue #64: Add queue size limits to prevent memory leaks
- PR #60: Initial audit logging implementation
- Issue #62: Webhook retry logic

## References

- [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Queue Theory and Little's Law](https://en.wikipedia.org/wiki/Little%27s_law)
- [Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html)