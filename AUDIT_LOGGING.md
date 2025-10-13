# Audit Logging & Events

Comprehensive audit logging system for tracking security-relevant events in the Al Ummah Now Authentication Server.

## Overview

The audit logging system emits structured events for all authentication, authorization, and account management actions. Events can be sent to multiple destinations (stdout, webhook endpoints, D1 database) for analysis, compliance, and security monitoring.

## Features

- **Structured Events**: JSON-formatted events with consistent schema
- **Multiple Sinks**: Output to stdout, webhook endpoints, or D1 database
- **Automatic Batching**: Efficient batch processing for webhook and database sinks
- **HMAC Signatures**: Webhook requests include HMAC-SHA256 signatures for verification
- **Non-Blocking**: Events are emitted asynchronously without blocking requests
- **Type-Safe**: Full TypeScript support with validated event schemas

## Event Types

### Authentication Events

#### `auth.login.success`
User successfully authenticated with the server.

**Metadata:**
- `email`: User's email address
- `method`: Authentication method (`email_code`, `oauth`, `password`)
- `clientId`: OAuth client ID (optional)

**Example:**
```json
{
  "timestamp": "2025-01-15T10:30:00.000Z",
  "eventType": "auth.login.success",
  "severity": "info",
  "userId": "550e8400-e29b-41d4-a716-446655440000",
  "ipAddress": "192.168.1.1",
  "userAgent": "Mozilla/5.0...",
  "requestId": "req-123",
  "metadata": {
    "email": "user@example.com",
    "method": "email_code",
    "clientId": "profile"
  },
  "success": true
}
```

#### `auth.login.failed`
Failed login attempt.

**Metadata:**
- `email`: Attempted email address
- `method`: Authentication method attempted
- `failureReason`: Why the login failed

**Example:**
```json
{
  "timestamp": "2025-01-15T10:31:00.000Z",
  "eventType": "auth.login.failed",
  "severity": "warning",
  "userId": null,
  "ipAddress": "192.168.1.1",
  "metadata": {
    "email": "user@example.com",
    "method": "email_code",
    "failureReason": "Invalid verification code"
  },
  "success": false,
  "errorMessage": "Invalid verification code"
}
```

#### `auth.logout`
User logged out or session was terminated.

**Example:**
```json
{
  "timestamp": "2025-01-15T11:00:00.000Z",
  "eventType": "auth.logout",
  "severity": "info",
  "userId": "550e8400-e29b-41d4-a716-446655440000",
  "ipAddress": "192.168.1.1",
  "metadata": {},
  "success": true
}
```

### Token Events

#### `auth.token.issued`
OAuth token issued to client.

**Metadata:**
- `tokenType`: Type of token (`access` or `refresh`)
- `clientId`: OAuth client ID
- `grantType`: OAuth grant type used
- `expiresIn`: Token expiration time in seconds

#### `auth.token.refresh`
Access token refreshed using refresh token.

**Metadata:**
- `tokenType`: Always `refresh`
- `clientId`: OAuth client ID
- `grantType`: Always `refresh_token`
- `expiresIn`: New token expiration time

#### `auth.token.revoke`
Token explicitly revoked before expiration.

**Metadata:**
- `tokenType`: Type of revoked token
- `clientId`: OAuth client ID

### Account Events

#### `auth.account.created`
New user account created.

**Metadata:**
- `email`: User's email address
- `role`: Assigned role (`user` or `admin`)
- `initiatedBy`: User ID of admin who created account (if applicable)

**Example:**
```json
{
  "timestamp": "2025-01-15T10:30:01.000Z",
  "eventType": "auth.account.created",
  "severity": "info",
  "userId": "550e8400-e29b-41d4-a716-446655440000",
  "metadata": {
    "email": "newuser@example.com",
    "role": "user"
  },
  "success": true
}
```

#### `auth.account.updated`
User account details modified.

**Metadata:**
- `email`: User's email address
- `changedFields`: Array of field names that were modified
- `initiatedBy`: User ID of admin who made changes (if applicable)

#### `auth.account.deleted`
User account permanently deleted.

### Authorization Events

#### `auth.authorization.granted`
User authorized an OAuth client application.

**Metadata:**
- `clientId`: OAuth client ID
- `redirectUri`: Redirect URI used
- `scopes`: Requested permission scopes

#### `auth.authorization.denied`
User denied authorization to an OAuth client.

**Metadata:**
- `clientId`: OAuth client ID
- `denialReason`: Why authorization was denied

### Security Events

#### `security.rate_limit.exceeded`
Request blocked due to rate limiting.

**Metadata:**
- `endpoint`: Which endpoint was rate limited
- `limit`: Maximum number of requests allowed
- `window`: Time window in seconds
- `retryAfter`: Seconds until rate limit resets

**Example:**
```json
{
  "timestamp": "2025-01-15T10:32:00.000Z",
  "eventType": "security.rate_limit.exceeded",
  "severity": "warning",
  "userId": null,
  "ipAddress": "192.168.1.1",
  "metadata": {
    "endpoint": "/sendCode",
    "limit": 5,
    "window": 300,
    "retryAfter": 240
  },
  "success": false,
  "errorMessage": "Rate limit exceeded for /sendCode"
}
```

#### `security.suspicious_activity`
Potentially malicious activity detected.

## Event Schema

All audit events follow this schema:

```typescript
interface AuditEvent {
  // ISO 8601 timestamp when the event occurred
  timestamp: string;

  // Type of audit event (e.g., "auth.login.success")
  eventType: AuditEventType;

  // Severity level: "info", "warning", "error", or "critical"
  severity: AuditEventSeverity;

  // User ID associated with the event (null for unauthenticated events)
  userId: string | null;

  // IP address of the client
  ipAddress: string | null;

  // User agent string
  userAgent: string | null;

  // Unique request ID for tracing
  requestId: string | null;

  // Event-specific metadata
  metadata: Record<string, any>;

  // Whether the action was successful
  success: boolean;

  // Error message if action failed
  errorMessage?: string;
}
```

## Configuration

### Environment Variables

Configure audit event sinks using environment variables:

```bash
# Enable stdout logging (default: true)
# Events are output as JSON to stdout

# Webhook URL (optional)
AUDIT_WEBHOOK_URL=https://your-siem.example.com/events

# Webhook secret for HMAC signature (optional but recommended)
AUDIT_WEBHOOK_SECRET=your-secret-key

# D1 database is automatically used if AUTH_DB is configured
```

### Webhook Sink

Events are sent to the webhook URL in batches:

**Default Settings:**
- Batch size: 10 events
- Batch timeout: 5 seconds
- Request format: `POST` with JSON body
- HMAC signature in `X-Audit-Signature` header

**Request Format:**
```json
POST /events HTTP/1.1
Host: your-siem.example.com
Content-Type: application/json
X-Audit-Signature: sha256=abc123...
User-Agent: AlUmmahNow-Auth/1.0

{
  "events": [
    {
      "timestamp": "2025-01-15T10:30:00.000Z",
      "eventType": "auth.login.success",
      ...
    },
    ...
  ]
}
```

**Verifying Webhook Signatures:**

```javascript
const crypto = require('crypto');

function verifySignature(body, signature, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body);
  const expected = 'sha256=' + hmac.digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

// In your webhook handler:
app.post('/events', (req, res) => {
  const signature = req.headers['x-audit-signature'];
  const body = JSON.stringify(req.body);

  if (!verifySignature(body, signature, process.env.WEBHOOK_SECRET)) {
    return res.status(401).send('Invalid signature');
  }

  // Process events
  const { events } = req.body;
  events.forEach(event => {
    console.log('Audit event:', event);
  });

  res.status(200).send('OK');
});
```

### D1 Database Sink

Events are stored in the `audit_events` table:

**Schema:**
```sql
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  user_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  success INTEGER NOT NULL,
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**Querying Events:**

```sql
-- Get recent failed login attempts
SELECT * FROM audit_events
WHERE event_type = 'auth.login.failed'
ORDER BY timestamp DESC
LIMIT 100;

-- Get all events for a specific user
SELECT * FROM audit_events
WHERE user_id = '550e8400-e29b-41d4-a716-446655440000'
ORDER BY timestamp DESC;

-- Get critical events from the last 24 hours
SELECT * FROM audit_events
WHERE severity = 'critical'
  AND timestamp >= datetime('now', '-1 day')
ORDER BY timestamp DESC;

-- Count failed logins by IP address
SELECT ip_address, COUNT(*) as failed_attempts
FROM audit_events
WHERE event_type = 'auth.login.failed'
  AND timestamp >= datetime('now', '-1 hour')
GROUP BY ip_address
ORDER BY failed_attempts DESC;
```

## Usage

### Emitting Custom Events

```typescript
import { getAuditEmitter } from './audit-emitter';
import { createAuditEvent, AuditEventType, AuditEventSeverity } from './audit-events';

// Get the global emitter
const emitter = getAuditEmitter();

// Create a custom event
const event = createAuditEvent(AuditEventType.AUTHORIZATION_GRANTED, {
  severity: AuditEventSeverity.INFO,
  userId: 'user-123',
  ipAddress: '192.168.1.1',
  userAgent: 'Mozilla/5.0',
  requestId: 'req-456',
  metadata: {
    clientId: 'mobile-app',
    redirectUri: 'https://app.example.com/callback',
    scopes: ['profile', 'email'],
  },
  success: true,
});

// Emit the event (non-blocking)
await emitter.emit(event);
```

### Using Helper Functions

```typescript
import {
  createLoginSuccessEvent,
  createLoginFailedEvent,
  createLogoutEvent,
  createRateLimitExceededEvent,
} from './audit-events';
import { getAuditEmitter } from './audit-emitter';

// Login success
const loginEvent = createLoginSuccessEvent('user@example.com', 'user-123', {
  ipAddress: '192.168.1.1',
  userAgent: 'Mozilla/5.0',
  requestId: 'req-789',
  clientId: 'profile',
});
await getAuditEmitter().emit(loginEvent);

// Login failed
const failedEvent = createLoginFailedEvent('user@example.com', 'Invalid code', {
  ipAddress: '192.168.1.1',
});
await getAuditEmitter().emit(failedEvent);

// Rate limit exceeded
const rateLimitEvent = createRateLimitExceededEvent('/login', 5, 300, 240, {
  ipAddress: '192.168.1.1',
});
await getAuditEmitter().emit(rateLimitEvent);
```

## Integration Examples

### Example 1: Basic Event Consumer (Node.js)

```javascript
// Simple webhook consumer that logs events
const express = require('express');
const app = express();

app.use(express.json());

app.post('/audit-events', (req, res) => {
  const { events } = req.body;

  events.forEach(event => {
    // Log high-severity events
    if (event.severity === 'error' || event.severity === 'critical') {
      console.error('Critical event:', event);

      // Alert security team
      if (event.eventType === 'auth.login.failed') {
        checkForBruteForce(event.ipAddress);
      }
    }
  });

  res.status(200).send('OK');
});

function checkForBruteForce(ipAddress) {
  // Implement brute force detection logic
  // e.g., count failed attempts from same IP
}

app.listen(3000, () => {
  console.log('Audit consumer running on port 3000');
});
```

### Example 2: Splunk Integration

```javascript
const SplunkLogger = require('splunk-logging').Logger;

const splunk = new SplunkLogger({
  token: process.env.SPLUNK_HEC_TOKEN,
  url: process.env.SPLUNK_HEC_URL,
});

app.post('/audit-events', (req, res) => {
  const { events } = req.body;

  events.forEach(event => {
    splunk.send({
      message: event,
      severity: event.severity,
      source: 'al-ummah-now-auth',
      sourcetype: 'audit:event',
    });
  });

  res.status(200).send('OK');
});
```

### Example 3: Elasticsearch Integration

```javascript
const { Client } = require('@elastic/elasticsearch');
const client = new Client({ node: 'http://localhost:9200' });

app.post('/audit-events', async (req, res) => {
  const { events } = req.body;

  const body = events.flatMap(event => [
    { index: { _index: 'audit-events' } },
    event,
  ]);

  await client.bulk({ body });

  res.status(200).send('OK');
});
```

## Security Considerations

1. **Webhook Authentication**: Always use HMAC signatures to verify webhook requests
2. **PII Data**: Events may contain personally identifiable information (email, IP addresses)
3. **Retention**: Implement appropriate retention policies for audit logs
4. **Access Control**: Restrict access to audit logs to authorized personnel only
5. **Encryption**: Use HTTPS for webhook endpoints and encrypt database at rest

## Performance

- **Stdout**: Minimal overhead, events logged synchronously
- **Webhook**: Batched requests reduce HTTP overhead (default: 10 events per batch)
- **D1 Database**: Batched inserts for efficient writes (default: 20 events per batch)
- **Non-Blocking**: All emissions use `ctx.waitUntil()` to avoid blocking responses

## Troubleshooting

### Events Not Appearing

1. Check that audit emitter is initialized in `index.ts`
2. Verify environment variables are set correctly
3. Check webhook endpoint is reachable and returning 200 OK
4. Verify D1 database migration has been applied

### Webhook Failures

1. Check webhook URL is correct and accessible
2. Verify HMAC signature is being validated correctly
3. Check webhook endpoint can handle batch requests
4. Monitor Cloudflare Workers logs for delivery errors

### Database Errors

1. Verify `audit_events` table exists (run migrations)
2. Check D1 database bindings are configured correctly
3. Monitor for D1 rate limits or quota issues

## Testing

Run audit event tests:

```bash
# Run all tests
pnpm run test

# Run only audit tests
pnpm run test audit-events.test.ts audit-emitter.test.ts
```

## Migration

Apply the audit events database migration:

```bash
# Local development
npx wrangler d1 migrations apply al-ummah-now-d1 --local

# Production
npx wrangler d1 migrations apply al-ummah-now-d1 --remote
```

## Further Reading

- [OpenAuth.js Documentation](https://github.com/openauthjs/openauth)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [D1 Database Documentation](https://developers.cloudflare.com/d1/)
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
