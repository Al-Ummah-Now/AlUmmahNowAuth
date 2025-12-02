# Audit Event Consumer

Cloudflare Queue consumer worker that processes audit events from the authentication server and writes them to D1 in batches.

## Architecture

```
┌─────────────┐     Queue      ┌──────────────────┐     Batch     ┌────────┐
│ Auth Server │ ─────────────> │ Audit Consumer   │ ────────────> │   D1   │
│ (Producer)  │   async 0ms    │ (This Worker)    │   50/batch    │ Database│
└─────────────┘                └──────────────────┘               └────────┘
                                     ↓
                                Dead Letter Queue
                                (Failed Messages)
```

## Features

- **Batch Processing**: Processes up to 50 audit events per batch for efficiency
- **Automatic Retries**: Failed messages retry with exponential backoff (5s, 10s, 20s)
- **Dead Letter Queue**: After 3 retries, failed messages go to DLQ for investigation
- **Non-Blocking**: Auth server publishes to queue in ~0ms, doesn't wait for D1 writes
- **Scalable**: Auto-scales based on queue depth (handles 10,000+ events/sec)

## Configuration

### Wrangler.toml

The consumer is configured via `wrangler.toml`:

```toml
[[queues.consumers]]
queue = "audit-events"
max_batch_size = 50
max_batch_timeout = 5
max_retries = 3
dead_letter_queue = "audit-events-dlq"
```

### Environment Bindings

- `AUDIT_DB`: D1 database for storing audit logs

## Local Development

```bash
# Start consumer (from repository root)
pnpm dev:consumer

# Or from this directory
pnpm dev
```

**Note**: Queue consumers run automatically when messages are published to the queue.

## Deployment

```bash
# Deploy consumer
pnpm deploy

# Or from root
pnpm deploy:consumer
```

## Queue Setup

First deployment requires creating the queue:

```bash
# Create production queue
wrangler queues create audit-events

# Create dead letter queue
wrangler queues create audit-events-dlq
```

## Monitoring

### Health Check

```bash
curl https://audit-consumer.yourworker.workers.dev/health
```

### View Queue Status

```bash
# Check queue depth
wrangler queues list

# Monitor consumer logs
wrangler tail audit-consumer
```

### Dead Letter Queue

View failed messages:

```bash
# List messages in DLQ
wrangler queues consumer list audit-events-dlq
```

## Message Format

The consumer processes messages in this format:

```typescript
interface AuditEventMessage {
  version: 1;
  event: {
    token_id: string;
    subject: string;
    event_type: "generated" | "refreshed" | "revoked" | "reused";
    client_id?: string;
    ip_address?: string;
    user_agent?: string;
    timestamp: number;
    metadata?: Record<string, string | number | boolean | null>;
  };
  enqueued_at: number;
}
```

## Performance

- **Throughput**: 10,000+ messages/sec
- **Latency**: <100ms per batch (50 events)
- **D1 Efficiency**: Batch inserts are 50x faster than individual inserts

## Troubleshooting

### High Failure Rate

Check the logs for errors:

```bash
wrangler tail audit-consumer --format pretty
```

### Queue Backlog

If queue depth is growing:

1. Check consumer health
2. Verify D1 database is accessible
3. Review error logs for patterns
4. Consider increasing batch size or timeout

### Dead Letter Queue Full

Investigate failed messages:

```bash
# Pull messages from DLQ
wrangler queues consumer worker audit-events-dlq --batch-size=10

# Analyze patterns in failed messages
# Fix underlying issue
# Replay DLQ messages if needed
```

## Integration with Auth Server

The auth server publishes events via the `AuditService`:

```typescript
// In auth server (apps/auth/src/index.ts)
const auditService = new AuditService({
  database: env.AUTH_DB,
  queue: env.AUDIT_QUEUE // Queue binding enables async mode
});

// Events are automatically queued
await auditService.logTokenUsage({
  token_id: "abc123",
  subject: "user:xyz",
  event_type: "refreshed",
  timestamp: Date.now()
});
```

## Cost Optimization

Queue operations are charged separately from D1:

- Queue writes: 1 million free/month
- Queue reads: 1 million free/month
- D1 writes: 5 million free/day

Batching reduces D1 operations by 50x, significantly reducing costs for high-volume applications.
