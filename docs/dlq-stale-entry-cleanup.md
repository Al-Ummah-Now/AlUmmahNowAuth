# DLQ Stale Replaying Entries Cleanup

## Problem

When the DLQ replay process marks entries as `'replaying'` and then encounters a crash, timeout, or unexpected failure before completing, those entries become stuck in the `'replaying'` status. Since the replay query only fetches entries with `'pending'` status, these stale entries are never retried automatically.

## Solution

A new cleanup method `resetStaleReplayingEntries()` has been added to the `DLQReplayService` class to identify and reset stale `'replaying'` entries back to `'pending'` status.

## Implementation

### Service Method

```typescript
/**
 * Reset stale 'replaying' entries back to 'pending' status
 *
 * This method identifies DLQ entries that have been stuck in 'replaying' status
 * for longer than the specified timeout. This can happen when a replay process
 * crashes, times out, or fails before marking entries as completed/failed.
 *
 * @param options.staleTimeout - Timeout in minutes after which a 'replaying' entry is considered stale (default: 30 minutes)
 * @returns Object containing the count of reset entries
 */
async resetStaleReplayingEntries(options: {
  staleTimeout?: number;  // Timeout in minutes (default: 30)
} = {}): Promise<{ reset: number }>
```

**Location**: `apps/auth/src/dlq-replay.ts:256-290`

### Admin API Endpoint

**Endpoint**: `POST /admin/dlq/reset-stale`

**Authentication**: Requires admin role

**Request Body**:
```json
{
  "staleTimeout": 30  // Optional, timeout in minutes (default: 30, max: 1440)
}
```

**Response**:
```json
{
  "success": true,
  "reset": 3  // Number of entries reset to pending
}
```

**Location**: `apps/auth/src/admin-dlq-routes.ts:276-319`

## Usage

### Via API

Reset stale entries using default timeout (30 minutes):

```bash
curl -X POST \
  -H "Authorization: Bearer <admin-session-token>" \
  -H "Content-Type: application/json" \
  https://your-worker.workers.dev/admin/dlq/reset-stale \
  -d '{}'
```

Reset stale entries with custom timeout (60 minutes):

```bash
curl -X POST \
  -H "Authorization: Bearer <admin-session-token>" \
  -H "Content-Type: application/json" \
  https://your-worker.workers.dev/admin/dlq/reset-stale \
  -d '{"staleTimeout": 60}'
```

### Programmatic Usage

```typescript
import { DLQReplayService } from './dlq-replay';

const replayService = new DLQReplayService(env.AUTH_DB);

// Reset stale entries with default 30-minute timeout
const result = await replayService.resetStaleReplayingEntries();
console.log(`Reset ${result.reset} stale entries`);

// Reset stale entries with custom 15-minute timeout
const result2 = await replayService.resetStaleReplayingEntries({
  staleTimeout: 15
});
console.log(`Reset ${result2.reset} stale entries`);
```

## Best Practices

### Recommended Timeout Values

- **Development**: 10-15 minutes - Faster iteration for testing
- **Production**: 30-60 minutes - Balance between responsiveness and avoiding false positives

### Automation Strategies

#### Option 1: Scheduled Cron Job

Add a cron trigger to your `wrangler.toml`:

```toml
[triggers]
crons = ["*/30 * * * *"]  # Run every 30 minutes
```

Then in your worker:

```typescript
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const replayService = new DLQReplayService(env.AUTH_DB);
    const result = await replayService.resetStaleReplayingEntries({
      staleTimeout: 30
    });
    console.log(`[CRON] Reset ${result.reset} stale replaying entries`);
  }
}
```

#### Option 2: Before Each Replay

Call the cleanup method before starting a manual replay:

```typescript
// First, reset any stale entries
await replayService.resetStaleReplayingEntries();

// Then, replay failed events
const replayResult = await replayService.replayFailedEvents({
  batchSize: 10,
  maxAge: 24
});
```

#### Option 3: Periodic Admin Task

Set up a scheduled task in your admin panel or monitoring system to call the API endpoint periodically.

## Monitoring

### Key Metrics

Monitor the following to detect issues:

1. **Stale Entry Count**: Number of entries reset per cleanup run
   - Normal: 0-2 entries
   - Warning: 3-10 entries
   - Alert: >10 entries (indicates systemic replay issues)

2. **Replaying Status Duration**: How long entries stay in `'replaying'` status
   - Normal: <5 minutes
   - Warning: 5-30 minutes
   - Alert: >30 minutes

### Logging

The cleanup method logs when stale entries are found:

```
Reset 3 stale 'replaying' entries back to 'pending'
```

Monitor these logs to identify patterns:
- Frequent resets may indicate timeout issues
- Large batch resets may indicate worker crashes

## Testing

Comprehensive test coverage is provided in `apps/auth/src/dlq-replay.test.ts:294-392`.

Run tests:
```bash
cd apps/auth
npx vitest run src/dlq-replay.test.ts
```

### Test Coverage

- ✅ Reset stale replaying entries to pending
- ✅ Use default timeout of 30 minutes
- ✅ Handle no stale entries
- ✅ Accept custom timeout values
- ✅ Only reset entries older than timeout

## Troubleshooting

### Issue: High number of stale entries

**Symptoms**: Cleanup consistently resets many entries (>10)

**Possible Causes**:
1. Worker timeout too short for replay operations
2. Network issues causing replay hangs
3. Webhook endpoints experiencing timeouts

**Solutions**:
- Increase worker timeout limits
- Reduce batch size in replay operations
- Investigate webhook endpoint health
- Consider implementing circuit breaker pattern

### Issue: Entries still stuck after cleanup

**Symptoms**: Cleanup runs but entries remain in `'replaying'` status

**Possible Causes**:
1. Timeout value too large
2. Entry timestamp is newer than expected

**Solutions**:
- Reduce staleTimeout value
- Check entry timestamps in database
- Manually update entries if needed:
  ```sql
  UPDATE webhook_dlq
  SET status = 'pending'
  WHERE status = 'replaying';
  ```

### Issue: False positives (resetting active replays)

**Symptoms**: Entries being reset while legitimately processing

**Possible Causes**:
1. Timeout value too small
2. Slow webhook endpoints

**Solutions**:
- Increase staleTimeout value (e.g., to 60 minutes)
- Optimize webhook processing
- Run cleanup less frequently

## Security Considerations

1. **Admin-Only Access**: The reset endpoint requires admin authentication
2. **Rate Limiting**: Subject to the same rate limits as other admin DLQ endpoints (10 requests per hour per admin)
3. **Audit Trail**: All reset operations are logged for audit purposes
4. **Input Validation**: Timeout values are validated (1-1440 minutes)

## Related Issues

- Issue #2: Implement user management system (context for admin functionality)
- The stale entry problem was identified during webhook retry/DLQ implementation

## API Reference

### Request Schema

```typescript
const resetStaleSchema = v.object({
  staleTimeout: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(1440))), // Max 24 hours
});
```

### Response Schema

```typescript
{
  success: boolean;
  reset: number;  // Count of reset entries
}
```

### Error Responses

**401 Unauthorized**
```json
"Unauthorized"
```

**400 Bad Request**
```json
{
  "error": "Invalid request",
  "details": { /* validation errors */ }
}
```

**500 Internal Server Error**
```json
{
  "error": "Internal server error",
  "message": "..." // Only in development mode
}
```

## Future Enhancements

1. **Automatic Recovery**: Implement automatic stale entry detection and reset in the replay workflow
2. **Health Checks**: Add status checks before marking entries as replaying
3. **Distributed Locks**: Prevent concurrent replay operations on the same entries
4. **Metrics Dashboard**: Visualize stale entry patterns over time
5. **Alert Integration**: Send notifications when stale entry count exceeds threshold
