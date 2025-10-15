# Queue Monitoring and Alerting Guide

## Overview

This guide provides operational procedures for monitoring and responding to queue-related issues in the audit logging system.

## Key Metrics

### Critical Metrics

| Metric | Threshold | Severity | Action Required |
|--------|-----------|----------|-----------------|
| Queue Utilization | >95% | CRITICAL | Immediate intervention |
| Queue Utilization | >80% | WARNING | Investigation needed |
| Dropped Events | >0/min | WARNING | Review configuration |
| Dropped Events | >10/min | CRITICAL | Urgent review |
| Oldest Event Age | >5 min | WARNING | Check flush status |
| Oldest Event Age | >15 min | CRITICAL | Service degraded |

### Health Indicators

```javascript
// Healthy Queue
{
  queueUtilization: 15,        // Well below limit
  droppedEvents: 0,            // No drops
  oldestEventAge: 2000,        // 2 seconds
  highWaterMark: 150           // Peak usage reasonable
}

// Unhealthy Queue
{
  queueUtilization: 92,        // Near capacity
  droppedEvents: 1523,         // Significant drops
  oldestEventAge: 900000,      // 15 minutes old
  highWaterMark: 999           // Hit limit
}
```

## Monitoring Dashboard

### Cloudflare Analytics Queries

#### Real-time Queue Status
```sql
SELECT
  timestamp,
  JSON_EXTRACT(message, '$.queueUtilization') as utilization,
  JSON_EXTRACT(message, '$.currentSize') as size,
  JSON_EXTRACT(message, '$.maxSize') as max_size
FROM logs
WHERE message LIKE '%Queue metrics%'
  AND timestamp > DATETIME('now', '-1 hour')
ORDER BY timestamp DESC
LIMIT 100;
```

#### Dropped Events Timeline
```sql
SELECT
  DATE_TRUNC('minute', timestamp) as minute,
  COUNT(*) as drops_per_minute,
  AVG(CAST(JSON_EXTRACT(message, '$.droppedCount') AS INT)) as avg_dropped
FROM logs
WHERE message LIKE '%queue overflow%'
  AND timestamp > DATETIME('now', '-24 hours')
GROUP BY DATE_TRUNC('minute', timestamp)
ORDER BY minute DESC;
```

#### Queue Health by Sink
```sql
SELECT
  JSON_EXTRACT(message, '$.sink') as sink_name,
  COUNT(*) as overflow_events,
  SUM(CAST(JSON_EXTRACT(message, '$.droppedCount') AS INT)) as total_dropped,
  MAX(CAST(JSON_EXTRACT(message, '$.queueSize') AS INT)) as max_queue_size
FROM logs
WHERE message LIKE '%queue overflow%'
  AND timestamp > DATETIME('now', '-7 days')
GROUP BY JSON_EXTRACT(message, '$.sink')
ORDER BY total_dropped DESC;
```

#### Critical Events Lost
```sql
SELECT
  timestamp,
  JSON_EXTRACT(message, '$.event.eventType') as event_type,
  JSON_EXTRACT(message, '$.event.severity') as severity,
  JSON_EXTRACT(message, '$.event.userId') as user_id
FROM logs
WHERE message LIKE '%audit_event_dropped%'
  AND JSON_EXTRACT(message, '$.event.severity') IN ('critical', 'error')
  AND timestamp > DATETIME('now', '-24 hours')
ORDER BY timestamp DESC;
```

## Alert Configuration

### Grafana Alert Rules

```yaml
groups:
  - name: audit_queue_alerts
    interval: 30s
    rules:
      - alert: AuditQueueCritical
        expr: audit_queue_utilization > 95
        for: 1m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: "Audit queue at {{ $value }}% capacity"
          description: "{{ $labels.sink }} queue is critically full. Immediate action required."
          runbook_url: "https://docs.example.com/runbooks/audit-queue-full"

      - alert: AuditQueueWarning
        expr: audit_queue_utilization > 80
        for: 5m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "Audit queue filling up ({{ $value }}%)"
          description: "{{ $labels.sink }} queue is at {{ $value }}% capacity"

      - alert: AuditEventsDropping
        expr: rate(audit_events_dropped[5m]) > 0
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "Audit events being dropped"
          description: "{{ $value }} events/minute dropped from {{ $labels.sink }}"

      - alert: AuditQueueStale
        expr: audit_queue_oldest_event_age > 300000  # 5 minutes
        for: 2m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "Audit queue not flushing"
          description: "Oldest event in {{ $labels.sink }} is {{ $value }}ms old"
```

### PagerDuty Integration

```javascript
// webhook-handler.js
export async function handleQueueAlert(event) {
  const { queueUtilization, droppedEvents, sink } = event;

  if (queueUtilization > 95) {
    await sendPagerDutyAlert({
      routing_key: process.env.PAGERDUTY_ROUTING_KEY,
      event_action: 'trigger',
      dedup_key: `audit-queue-${sink}`,
      payload: {
        summary: `CRITICAL: Audit queue at ${queueUtilization}% for ${sink}`,
        severity: 'critical',
        source: 'auth-service',
        custom_details: {
          queue_utilization: queueUtilization,
          dropped_events: droppedEvents,
          sink_name: sink,
        }
      }
    });
  }
}
```

## Incident Response Playbook

### Scenario 1: Queue at 80% Capacity

**Symptoms:**
- Warning logs showing "queue at 80% capacity"
- No dropped events yet
- Service operating normally

**Actions:**
1. Check webhook endpoint status
2. Verify D1 database connectivity
3. Review recent traffic patterns
4. Consider increasing batch size temporarily
5. Monitor for next 15 minutes

**Commands:**
```bash
# Check webhook status
curl -I https://audit-webhook.example.com/health

# Check D1 status
wrangler d1 execute AUTH_DB --command "SELECT 1"

# Review traffic
wrangler tail --format json | grep "audit_event"
```

### Scenario 2: Events Being Dropped

**Symptoms:**
- Events being dropped (>0/min)
- Queue at or near capacity
- Critical audit events potentially lost

**Immediate Actions:**
1. **Increase queue size** (hotfix):
   ```javascript
   // Emergency config change
   maxQueueSize: 5000  // Increase from 1000
   ```

2. **Check sink availability**:
   ```bash
   # Test webhook
   curl -X POST https://audit-webhook.example.com/test \
     -H "Content-Type: application/json" \
     -d '{"test": true}'

   # Check D1
   wrangler d1 list AUTH_DB
   ```

3. **Recover dropped events** (if critical):
   ```sql
   -- Extract dropped events from logs
   SELECT
     JSON_EXTRACT(message, '$.event') as dropped_event
   FROM logs
   WHERE message LIKE '%audit_event_dropped%'
     AND timestamp > DATETIME('now', '-1 hour');
   ```

### Scenario 3: Complete Queue Blockage

**Symptoms:**
- Queue at 100% capacity
- Continuous event drops
- Oldest event age increasing
- No successful flushes

**Emergency Response:**
1. **Bypass failing sink** (immediate):
   ```javascript
   // Disable problematic sink
   if (WEBHOOK_ENABLED && !webhookHealthy) {
     console.error('Disabling unhealthy webhook sink');
     WEBHOOK_ENABLED = false;
   }
   ```

2. **Manual flush attempt**:
   ```javascript
   // Force flush with error handling
   try {
     await webhookSink.flush();
   } catch (error) {
     console.error('Manual flush failed:', error);
     // Write to backup location
     await writeToR2Backup(webhookSink.eventQueue);
   }
   ```

3. **Switch to fallback sink**:
   ```javascript
   // Temporary stdout-only mode
   const emitter = new AuditEmitter();
   emitter.addSink(new StdoutSink());
   // Remove webhook/D1 temporarily
   ```

## Preventive Measures

### Daily Checks
- [ ] Review queue utilization trends
- [ ] Check for any dropped events
- [ ] Verify sink endpoint health
- [ ] Review batch performance metrics

### Weekly Reviews
- [ ] Analyze traffic patterns
- [ ] Tune queue size limits
- [ ] Review dropped event types
- [ ] Update alerting thresholds

### Monthly Optimization
- [ ] Load test with expected traffic
- [ ] Review and adjust batch sizes
- [ ] Update monitoring queries
- [ ] Document any incidents

## Performance Tuning

### Batch Size Optimization

```javascript
// Low traffic (< 100 events/min)
{
  batchSize: 10,
  batchTimeout: 5000,
  maxQueueSize: 500
}

// Medium traffic (100-1000 events/min)
{
  batchSize: 50,
  batchTimeout: 3000,
  maxQueueSize: 1000
}

// High traffic (> 1000 events/min)
{
  batchSize: 100,
  batchTimeout: 2000,
  maxQueueSize: 2000
}
```

### Queue Size Recommendations

| Environment | Traffic | Max Queue Size | Rationale |
|-------------|---------|----------------|-----------|
| Development | Low | 10,000 | Debug flexibility |
| Staging | Medium | 5,000 | Test production limits |
| Production | High | 1,000 | Conservative memory |
| High-Volume | Very High | 2,000 | Balance risk/buffer |

## Recovery Procedures

### Recovering Dropped Events

1. **Extract from logs**:
```bash
wrangler tail --format json | \
  grep "audit_event_dropped" | \
  jq -r '.event' > dropped_events.jsonl
```

2. **Replay to sink**:
```javascript
const fs = require('fs');
const readline = require('readline');

async function replayDroppedEvents() {
  const fileStream = fs.createReadStream('dropped_events.jsonl');
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    const event = JSON.parse(line);
    await auditEmitter.emit(event);
    await sleep(100); // Rate limit
  }
}
```

### Creating Backup Sink

```javascript
class R2BackupSink implements AuditEventSink {
  name = 'r2-backup';

  constructor(private r2: R2Bucket) {}

  async emit(event: AuditEvent): Promise<void> {
    const key = `audit-backup/${event.timestamp}-${event.requestId}.json`;
    await this.r2.put(key, JSON.stringify(event));
  }

  async flush(): Promise<void> {
    // No-op for R2
  }
}

// Use as overflow protection
if (primarySink.getMetrics().queueUtilization > 90) {
  emitter.addSink(new R2BackupSink(env.BACKUP_BUCKET));
}
```

## Troubleshooting Guide

### Common Issues

#### Issue: "Queue full" but low traffic
**Cause**: Sink not flushing properly
**Solution**: Check sink connectivity, review flush timer

#### Issue: Drops during traffic spikes
**Cause**: Queue size too small for burst traffic
**Solution**: Increase maxQueueSize or reduce batchTimeout

#### Issue: Old events in queue
**Cause**: Batch size too large for traffic rate
**Solution**: Reduce batchSize to flush more frequently

#### Issue: Memory warnings
**Cause**: Queue size too large
**Solution**: Reduce maxQueueSize, increase batch frequency

## Contact and Escalation

### Escalation Path
1. **L1**: Platform on-call engineer
2. **L2**: Senior platform engineer
3. **L3**: Platform architect
4. **L4**: CTO/Security team

### Key Contacts
- Platform Team: platform@example.com
- Security Team: security@example.com
- On-Call: Use PagerDuty

### Runbook Updates
This guide should be reviewed and updated:
- After any queue-related incident
- When configuration changes
- Quarterly as part of DR review