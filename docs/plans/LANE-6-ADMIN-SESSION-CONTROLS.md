# Lane 6: Admin Session Controls & UI

## Overview
Implement administrative controls for session management including viewing user sessions, force logout capabilities, session termination, and a comprehensive admin UI for session monitoring.

## Priority: P1 (High)
**Dependencies**: Lane 1 (Browser Sessions), Lane 3 (Session Management APIs)
**Blocks**: None

---

## Current State Analysis

### What Exists:
- Basic user management in admin dashboard
- Token revocation endpoint
- Audit logging for session events
- User listing with basic info

### What's Missing:
- Admin view of user sessions
- Force logout single user
- Force logout all users
- Terminate specific session
- Session monitoring dashboard
- Security alerts for suspicious sessions
- Bulk session operations

---

## Admin Session APIs

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/users/:userId/sessions` | GET | List all sessions for a user |
| `/admin/users/:userId/sessions/:sessionId` | DELETE | Terminate specific session |
| `/admin/users/:userId/sessions` | DELETE | Terminate all user sessions |
| `/admin/users/:userId/force-logout` | POST | Force logout everywhere + revoke tokens |
| `/admin/sessions` | GET | List all active sessions (with filters) |
| `/admin/sessions/stats` | GET | Session statistics |
| `/admin/sessions/suspicious` | GET | Suspicious session activity |

---

## Route Implementation

### File: apps/auth/src/routes/admin/sessions.ts

```typescript
import { Hono } from 'hono';
import { BrowserSessionService } from '../../services/browser-session.service';
import { AccountSessionService } from '../../services/account-session.service';
import { TokenService } from '../../services/token.service';
import { requireAdmin, requirePermission } from '../../middleware/admin-auth';
import { emitAuditEvent } from '../../services/audit';
import type { Env } from '../../types/env';

const adminSessionsRoute = new Hono<{ Bindings: Env }>();

// All routes require admin access
adminSessionsRoute.use('*', requireAdmin);

/**
 * GET /admin/users/:userId/sessions
 * List all sessions for a specific user
 */
adminSessionsRoute.get('/users/:userId/sessions', requirePermission('users:read'), async (c) => {
  const userId = c.req.param('userId');
  const tenantId = c.get('tenantId');

  // Verify user exists and belongs to tenant
  const user = await c.env.AUTH_DB.prepare(`
    SELECT id, email FROM user WHERE id = ? AND tenant_id = ?
  `).bind(userId, tenantId).first();

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  // Get all account sessions for user
  const sessions = await c.env.AUTH_DB.prepare(`
    SELECT
      a.id as session_id,
      a.authenticated_at,
      a.auth_method,
      a.last_used,
      a.is_active,
      a.expires_at,
      b.id as browser_session_id,
      b.device_type,
      b.device_name,
      b.ip_address,
      b.user_agent,
      b.created_at as browser_created_at,
      b.last_activity
    FROM account_sessions a
    JOIN browser_sessions b ON a.browser_session_id = b.id
    WHERE a.user_id = ?
    AND a.is_revoked = 0
    AND b.is_revoked = 0
    AND a.expires_at > datetime('now')
    ORDER BY a.last_used DESC
  `).bind(userId).all();

  return c.json({
    userId,
    email: user.email,
    sessions: sessions.results.map(s => ({
      id: s.session_id,
      browserSessionId: s.browser_session_id,
      authenticatedAt: s.authenticated_at,
      authMethod: s.auth_method,
      lastUsed: s.last_used,
      isActive: Boolean(s.is_active),
      expiresAt: s.expires_at,
      device: {
        type: s.device_type,
        name: s.device_name,
        ipAddress: s.ip_address,
        userAgent: s.user_agent,
      },
      browserCreatedAt: s.browser_created_at,
      lastActivity: s.last_activity,
    })),
    totalSessions: sessions.results.length,
  });
});

/**
 * DELETE /admin/users/:userId/sessions/:sessionId
 * Terminate a specific session for a user
 */
adminSessionsRoute.delete('/users/:userId/sessions/:sessionId', requirePermission('users:manage'), async (c) => {
  const userId = c.req.param('userId');
  const sessionId = c.req.param('sessionId');
  const adminUser = c.get('activeAccount');

  // Verify session belongs to user
  const session = await c.env.AUTH_DB.prepare(`
    SELECT a.id, a.browser_session_id, b.device_name
    FROM account_sessions a
    JOIN browser_sessions b ON a.browser_session_id = b.id
    WHERE a.id = ? AND a.user_id = ?
  `).bind(sessionId, userId).first();

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  // Revoke the account session
  await c.env.AUTH_DB.prepare(`
    UPDATE account_sessions SET is_revoked = 1 WHERE id = ?
  `).bind(sessionId).run();

  // Revoke associated tokens
  const tokenService = new TokenService(c.env.AUTH_DB, c.env.ISSUER, () => getActiveSigningKey(c.env));
  await tokenService.revokeSessionTokens(sessionId);

  // Emit audit event
  await emitAuditEvent(c.env, {
    type: 'admin.session_terminated',
    userId: adminUser?.userId || 'system',
    severity: 'warning',
    metadata: {
      targetUserId: userId,
      sessionId: sessionId,
      deviceName: session.device_name,
      action: 'terminate_single',
    },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({
    success: true,
    message: `Session ${sessionId} terminated`,
  });
});

/**
 * DELETE /admin/users/:userId/sessions
 * Terminate all sessions for a user
 */
adminSessionsRoute.delete('/users/:userId/sessions', requirePermission('users:manage'), async (c) => {
  const userId = c.req.param('userId');
  const adminUser = c.get('activeAccount');

  // Get count of sessions before deletion
  const countResult = await c.env.AUTH_DB.prepare(`
    SELECT COUNT(*) as count FROM account_sessions
    WHERE user_id = ? AND is_revoked = 0
  `).bind(userId).first<{ count: number }>();

  // Revoke all account sessions
  await c.env.AUTH_DB.prepare(`
    UPDATE account_sessions SET is_revoked = 1 WHERE user_id = ?
  `).bind(userId).run();

  // Revoke all tokens
  const tokenService = new TokenService(c.env.AUTH_DB, c.env.ISSUER, () => getActiveSigningKey(c.env));
  await tokenService.revokeUserTokens(userId);

  // Emit audit event
  await emitAuditEvent(c.env, {
    type: 'admin.sessions_terminated_all',
    userId: adminUser?.userId || 'system',
    severity: 'warning',
    metadata: {
      targetUserId: userId,
      sessionsTerminated: countResult?.count || 0,
      action: 'terminate_all',
    },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({
    success: true,
    sessionsTerminated: countResult?.count || 0,
  });
});

/**
 * POST /admin/users/:userId/force-logout
 * Force logout user everywhere - terminates all sessions and revokes all tokens
 */
adminSessionsRoute.post('/users/:userId/force-logout', requirePermission('users:manage'), async (c) => {
  const userId = c.req.param('userId');
  const adminUser = c.get('activeAccount');
  const { reason } = await c.req.json<{ reason?: string }>().catch(() => ({}));

  // Get user info
  const user = await c.env.AUTH_DB.prepare(`
    SELECT id, email FROM user WHERE id = ?
  `).bind(userId).first();

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  // Revoke all browser sessions (cascades to account sessions)
  const browserSessions = await c.env.AUTH_DB.prepare(`
    SELECT DISTINCT b.id
    FROM browser_sessions b
    JOIN account_sessions a ON b.id = a.browser_session_id
    WHERE a.user_id = ? AND b.is_revoked = 0
  `).bind(userId).all();

  for (const bs of browserSessions.results) {
    await c.env.AUTH_DB.prepare(`
      UPDATE browser_sessions SET is_revoked = 1 WHERE id = ?
    `).bind(bs.id).run();
  }

  // Revoke all account sessions
  const accountSessionsResult = await c.env.AUTH_DB.prepare(`
    UPDATE account_sessions SET is_revoked = 1 WHERE user_id = ?
  `).bind(userId).run();

  // Revoke all refresh tokens
  const refreshResult = await c.env.AUTH_DB.prepare(`
    UPDATE refresh_tokens SET is_revoked = 1, revoked_at = datetime('now')
    WHERE user_id = ?
  `).bind(userId).run();

  // Emit critical audit event
  await emitAuditEvent(c.env, {
    type: 'admin.force_logout',
    userId: adminUser?.userId || 'system',
    severity: 'critical',
    metadata: {
      targetUserId: userId,
      targetEmail: user.email,
      reason: reason || 'Admin initiated',
      browserSessionsRevoked: browserSessions.results.length,
      accountSessionsRevoked: accountSessionsResult.meta.changes || 0,
      refreshTokensRevoked: refreshResult.meta.changes || 0,
    },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({
    success: true,
    message: `User ${user.email} has been logged out from all devices`,
    stats: {
      browserSessionsRevoked: browserSessions.results.length,
      accountSessionsRevoked: accountSessionsResult.meta.changes || 0,
      refreshTokensRevoked: refreshResult.meta.changes || 0,
    },
  });
});

/**
 * GET /admin/sessions
 * List all active sessions with filtering
 */
adminSessionsRoute.get('/', requirePermission('users:read'), async (c) => {
  const tenantId = c.get('tenantId');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  const deviceType = c.req.query('device_type');
  const ipAddress = c.req.query('ip_address');
  const userId = c.req.query('user_id');

  let whereConditions = ['b.tenant_id = ?', 'a.is_revoked = 0', 'b.is_revoked = 0'];
  let bindings: any[] = [tenantId];

  if (deviceType) {
    whereConditions.push('b.device_type = ?');
    bindings.push(deviceType);
  }

  if (ipAddress) {
    whereConditions.push('b.ip_address = ?');
    bindings.push(ipAddress);
  }

  if (userId) {
    whereConditions.push('a.user_id = ?');
    bindings.push(userId);
  }

  const whereClause = whereConditions.join(' AND ');

  // Get total count
  const countResult = await c.env.AUTH_DB.prepare(`
    SELECT COUNT(*) as count
    FROM account_sessions a
    JOIN browser_sessions b ON a.browser_session_id = b.id
    WHERE ${whereClause}
  `).bind(...bindings).first<{ count: number }>();

  // Get sessions
  const sessions = await c.env.AUTH_DB.prepare(`
    SELECT
      a.id as session_id,
      a.user_id,
      u.email,
      a.authenticated_at,
      a.last_used,
      a.is_active,
      b.device_type,
      b.device_name,
      b.ip_address,
      b.last_activity
    FROM account_sessions a
    JOIN browser_sessions b ON a.browser_session_id = b.id
    JOIN user u ON a.user_id = u.id
    WHERE ${whereClause}
    ORDER BY a.last_used DESC
    LIMIT ? OFFSET ?
  `).bind(...bindings, limit, offset).all();

  return c.json({
    sessions: sessions.results.map(s => ({
      id: s.session_id,
      userId: s.user_id,
      email: s.email,
      authenticatedAt: s.authenticated_at,
      lastUsed: s.last_used,
      isActive: Boolean(s.is_active),
      device: {
        type: s.device_type,
        name: s.device_name,
        ipAddress: s.ip_address,
      },
      lastActivity: s.last_activity,
    })),
    total: countResult?.count || 0,
    limit,
    offset,
  });
});

/**
 * GET /admin/sessions/stats
 * Get session statistics
 */
adminSessionsRoute.get('/stats', requirePermission('analytics:read'), async (c) => {
  const tenantId = c.get('tenantId');

  const [totalSessions, activeSessions, deviceBreakdown, recentLogins] = await Promise.all([
    // Total active sessions
    c.env.AUTH_DB.prepare(`
      SELECT COUNT(*) as count
      FROM account_sessions a
      JOIN browser_sessions b ON a.browser_session_id = b.id
      WHERE b.tenant_id = ? AND a.is_revoked = 0 AND b.is_revoked = 0
    `).bind(tenantId).first<{ count: number }>(),

    // Currently active (used in last hour)
    c.env.AUTH_DB.prepare(`
      SELECT COUNT(*) as count
      FROM account_sessions a
      WHERE a.is_revoked = 0
      AND a.last_used > datetime('now', '-1 hour')
    `).first<{ count: number }>(),

    // Device type breakdown
    c.env.AUTH_DB.prepare(`
      SELECT b.device_type, COUNT(*) as count
      FROM account_sessions a
      JOIN browser_sessions b ON a.browser_session_id = b.id
      WHERE b.tenant_id = ? AND a.is_revoked = 0 AND b.is_revoked = 0
      GROUP BY b.device_type
    `).bind(tenantId).all(),

    // Logins in last 24 hours
    c.env.AUTH_DB.prepare(`
      SELECT COUNT(*) as count
      FROM account_sessions a
      JOIN browser_sessions b ON a.browser_session_id = b.id
      WHERE b.tenant_id = ?
      AND a.authenticated_at > datetime('now', '-24 hours')
    `).bind(tenantId).first<{ count: number }>(),
  ]);

  return c.json({
    totalSessions: totalSessions?.count || 0,
    activeSessions: activeSessions?.count || 0,
    loginsLast24h: recentLogins?.count || 0,
    deviceBreakdown: deviceBreakdown.results.reduce((acc, row) => {
      acc[row.device_type as string] = row.count as number;
      return acc;
    }, {} as Record<string, number>),
  });
});

/**
 * GET /admin/sessions/suspicious
 * Get suspicious session activity
 */
adminSessionsRoute.get('/suspicious', requirePermission('audit:read'), async (c) => {
  const tenantId = c.get('tenantId');

  // Find suspicious patterns:
  // 1. Multiple IPs for same user in short time
  // 2. Unusual login times
  // 3. Failed login attempts followed by success

  const multipleIPs = await c.env.AUTH_DB.prepare(`
    SELECT
      a.user_id,
      u.email,
      COUNT(DISTINCT b.ip_address) as ip_count,
      GROUP_CONCAT(DISTINCT b.ip_address) as ip_addresses
    FROM account_sessions a
    JOIN browser_sessions b ON a.browser_session_id = b.id
    JOIN user u ON a.user_id = u.id
    WHERE b.tenant_id = ?
    AND a.authenticated_at > datetime('now', '-24 hours')
    GROUP BY a.user_id
    HAVING ip_count > 3
    ORDER BY ip_count DESC
    LIMIT 20
  `).bind(tenantId).all();

  const failedThenSuccess = await c.env.AUTH_DB.prepare(`
    SELECT
      ae.user_id,
      u.email,
      COUNT(*) as failed_attempts,
      MAX(ae.created_at) as last_failure
    FROM audit_events ae
    JOIN user u ON ae.user_id = u.id
    WHERE ae.tenant_id = ?
    AND ae.type = 'login_failed'
    AND ae.created_at > datetime('now', '-1 hour')
    AND EXISTS (
      SELECT 1 FROM audit_events ae2
      WHERE ae2.user_id = ae.user_id
      AND ae2.type = 'login_success'
      AND ae2.created_at > ae.created_at
    )
    GROUP BY ae.user_id
    HAVING failed_attempts >= 3
    ORDER BY failed_attempts DESC
    LIMIT 20
  `).bind(tenantId).all();

  return c.json({
    multipleIPsInShortTime: multipleIPs.results.map(r => ({
      userId: r.user_id,
      email: r.email,
      ipCount: r.ip_count,
      ipAddresses: (r.ip_addresses as string).split(','),
    })),
    failedThenSuccessfulLogins: failedThenSuccess.results.map(r => ({
      userId: r.user_id,
      email: r.email,
      failedAttempts: r.failed_attempts,
      lastFailure: r.last_failure,
    })),
  });
});

export default adminSessionsRoute;
```

---

## Admin Dashboard UI

### File: apps/admin/app/routes/users.$id.sessions.tsx

```tsx
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from '@react-router/cloudflare';
import { useLoaderData, useFetcher, useParams } from 'react-router';
import { useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';
import { Button } from '~/components/ui/button';
import { Badge } from '~/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '~/components/ui/alert-dialog';
import { Laptop, Smartphone, Tablet, Globe, Clock, MapPin, LogOut, AlertTriangle } from 'lucide-react';

interface Session {
  id: string;
  browserSessionId: string;
  authenticatedAt: string;
  authMethod: string;
  lastUsed: string;
  isActive: boolean;
  expiresAt: string;
  device: {
    type: string;
    name: string;
    ipAddress: string;
    userAgent: string;
  };
  lastActivity: string;
}

interface LoaderData {
  userId: string;
  email: string;
  sessions: Session[];
  totalSessions: number;
}

export async function loader({ params, context }: LoaderFunctionArgs) {
  const { id } = params;
  const { AUTH_API_URL, AUTH_TOKEN } = context.cloudflare.env;

  const response = await fetch(`${AUTH_API_URL}/admin/users/${id}/sessions`, {
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Response('Failed to load sessions', { status: response.status });
  }

  return json(await response.json());
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  const { id } = params;
  const { AUTH_API_URL, AUTH_TOKEN } = context.cloudflare.env;
  const formData = await request.formData();
  const action = formData.get('action');
  const sessionId = formData.get('sessionId');

  let endpoint: string;
  let method: string;

  switch (action) {
    case 'terminate-session':
      endpoint = `/admin/users/${id}/sessions/${sessionId}`;
      method = 'DELETE';
      break;
    case 'terminate-all':
      endpoint = `/admin/users/${id}/sessions`;
      method = 'DELETE';
      break;
    case 'force-logout':
      endpoint = `/admin/users/${id}/force-logout`;
      method = 'POST';
      break;
    default:
      return json({ error: 'Invalid action' }, { status: 400 });
  }

  const response = await fetch(`${AUTH_API_URL}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: method === 'POST' ? JSON.stringify({ reason: 'Admin action' }) : undefined,
  });

  if (!response.ok) {
    return json({ error: 'Action failed' }, { status: response.status });
  }

  return json({ success: true });
}

function DeviceIcon({ type }: { type: string }) {
  switch (type) {
    case 'mobile':
      return <Smartphone className="h-5 w-5" />;
    case 'tablet':
      return <Tablet className="h-5 w-5" />;
    case 'desktop':
      return <Laptop className="h-5 w-5" />;
    default:
      return <Globe className="h-5 w-5" />;
  }
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleString();
}

function formatRelativeTime(dateString: string) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

export default function UserSessions() {
  const data = useLoaderData<LoaderData>();
  const fetcher = useFetcher();
  const [selectedSession, setSelectedSession] = useState<string | null>(null);

  const isLoading = fetcher.state !== 'idle';

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">User Sessions</h1>
          <p className="text-muted-foreground">{data.email}</p>
        </div>
        <div className="flex gap-2">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" className="text-orange-600">
                <LogOut className="h-4 w-4 mr-2" />
                Terminate All
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Terminate All Sessions?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will log out {data.email} from all devices. They will need to sign in again.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <fetcher.Form method="post">
                  <input type="hidden" name="action" value="terminate-all" />
                  <AlertDialogAction type="submit" disabled={isLoading}>
                    Terminate All
                  </AlertDialogAction>
                </fetcher.Form>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive">
                <AlertTriangle className="h-4 w-4 mr-2" />
                Force Logout
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Force Logout User?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will immediately terminate all sessions AND revoke all tokens for {data.email}.
                  This is a critical security action and will be logged.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <fetcher.Form method="post">
                  <input type="hidden" name="action" value="force-logout" />
                  <AlertDialogAction type="submit" className="bg-destructive" disabled={isLoading}>
                    Force Logout
                  </AlertDialogAction>
                </fetcher.Form>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <div className="grid gap-4">
        {data.sessions.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              No active sessions
            </CardContent>
          </Card>
        ) : (
          data.sessions.map((session) => (
            <Card key={session.id} className={session.isActive ? 'border-green-500' : ''}>
              <CardHeader className="pb-2">
                <div className="flex justify-between items-start">
                  <div className="flex items-center gap-3">
                    <DeviceIcon type={session.device.type} />
                    <div>
                      <CardTitle className="text-base flex items-center gap-2">
                        {session.device.name}
                        {session.isActive && (
                          <Badge variant="default" className="bg-green-500">Active</Badge>
                        )}
                      </CardTitle>
                      <CardDescription>{session.device.userAgent}</CardDescription>
                    </div>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => setSelectedSession(session.id)}
                      >
                        <LogOut className="h-4 w-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Terminate Session?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will log out the user from this device ({session.device.name}).
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <fetcher.Form method="post">
                          <input type="hidden" name="action" value="terminate-session" />
                          <input type="hidden" name="sessionId" value={session.id} />
                          <AlertDialogAction type="submit" disabled={isLoading}>
                            Terminate
                          </AlertDialogAction>
                        </fetcher.Form>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <MapPin className="h-4 w-4" />
                    <span>{session.device.ipAddress}</span>
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Clock className="h-4 w-4" />
                    <span>Last active: {formatRelativeTime(session.lastUsed)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Authenticated: </span>
                    {formatDate(session.authenticatedAt)}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Expires: </span>
                    {formatDate(session.expiresAt)}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Session Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-3xl font-bold">{data.totalSessions}</div>
              <div className="text-muted-foreground">Total Sessions</div>
            </div>
            <div>
              <div className="text-3xl font-bold">
                {data.sessions.filter(s => s.device.type === 'mobile').length}
              </div>
              <div className="text-muted-foreground">Mobile</div>
            </div>
            <div>
              <div className="text-3xl font-bold">
                {data.sessions.filter(s => s.device.type === 'desktop').length}
              </div>
              <div className="text-muted-foreground">Desktop</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

### File: apps/admin/app/routes/sessions._index.tsx

```tsx
import { json, type LoaderFunctionArgs } from '@react-router/cloudflare';
import { useLoaderData, useSearchParams, Link } from 'react-router';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Users, Monitor, Smartphone, Activity, AlertTriangle } from 'lucide-react';

export async function loader({ request, context }: LoaderFunctionArgs) {
  const { AUTH_API_URL, AUTH_TOKEN } = context.cloudflare.env;
  const url = new URL(request.url);

  const [sessionsRes, statsRes, suspiciousRes] = await Promise.all([
    fetch(`${AUTH_API_URL}/admin/sessions?${url.searchParams}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    }),
    fetch(`${AUTH_API_URL}/admin/sessions/stats`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    }),
    fetch(`${AUTH_API_URL}/admin/sessions/suspicious`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    }),
  ]);

  return json({
    sessions: await sessionsRes.json(),
    stats: await statsRes.json(),
    suspicious: await suspiciousRes.json(),
  });
}

export default function SessionsDashboard() {
  const { sessions, stats, suspicious } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const hasSuspiciousActivity =
    suspicious.multipleIPsInShortTime.length > 0 ||
    suspicious.failedThenSuccessfulLogins.length > 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Session Management</h1>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Sessions</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalSessions}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Active Now</CardTitle>
            <Activity className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.activeSessions}</div>
            <p className="text-xs text-muted-foreground">In last hour</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Logins (24h)</CardTitle>
            <Monitor className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.loginsLast24h}</div>
          </CardContent>
        </Card>

        <Card className={hasSuspiciousActivity ? 'border-orange-500' : ''}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Suspicious</CardTitle>
            <AlertTriangle className={`h-4 w-4 ${hasSuspiciousActivity ? 'text-orange-500' : 'text-muted-foreground'}`} />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {suspicious.multipleIPsInShortTime.length + suspicious.failedThenSuccessfulLogins.length}
            </div>
            <p className="text-xs text-muted-foreground">Needs review</p>
          </CardContent>
        </Card>
      </div>

      {/* Device Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>Sessions by Device</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-8">
            {Object.entries(stats.deviceBreakdown).map(([device, count]) => (
              <div key={device} className="flex items-center gap-2">
                {device === 'mobile' && <Smartphone className="h-5 w-5" />}
                {device === 'desktop' && <Monitor className="h-5 w-5" />}
                <span className="capitalize">{device}:</span>
                <Badge variant="secondary">{count}</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Suspicious Activity Alert */}
      {hasSuspiciousActivity && (
        <Card className="border-orange-500 bg-orange-50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-orange-700">
              <AlertTriangle className="h-5 w-5" />
              Suspicious Activity Detected
            </CardTitle>
          </CardHeader>
          <CardContent>
            {suspicious.multipleIPsInShortTime.length > 0 && (
              <div className="mb-4">
                <h4 className="font-medium mb-2">Multiple IPs in short time:</h4>
                <ul className="list-disc list-inside">
                  {suspicious.multipleIPsInShortTime.map((item: any) => (
                    <li key={item.userId}>
                      <Link to={`/users/${item.userId}/sessions`} className="text-blue-600 hover:underline">
                        {item.email}
                      </Link>
                      {' '}- {item.ipCount} different IPs
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {suspicious.failedThenSuccessfulLogins.length > 0 && (
              <div>
                <h4 className="font-medium mb-2">Failed attempts before success:</h4>
                <ul className="list-disc list-inside">
                  {suspicious.failedThenSuccessfulLogins.map((item: any) => (
                    <li key={item.userId}>
                      <Link to={`/users/${item.userId}/sessions`} className="text-blue-600 hover:underline">
                        {item.email}
                      </Link>
                      {' '}- {item.failedAttempts} failed attempts
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Sessions Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Sessions</CardTitle>
          <div className="flex gap-4">
            <Select
              value={searchParams.get('device_type') || ''}
              onValueChange={(value) => {
                const params = new URLSearchParams(searchParams);
                if (value) params.set('device_type', value);
                else params.delete('device_type');
                setSearchParams(params);
              }}
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="Device type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">All devices</SelectItem>
                <SelectItem value="desktop">Desktop</SelectItem>
                <SelectItem value="mobile">Mobile</SelectItem>
                <SelectItem value="tablet">Tablet</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="Filter by IP..."
              className="w-[200px]"
              onChange={(e) => {
                const params = new URLSearchParams(searchParams);
                if (e.target.value) params.set('ip_address', e.target.value);
                else params.delete('ip_address');
                setSearchParams(params);
              }}
            />
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Device</TableHead>
                <TableHead>IP Address</TableHead>
                <TableHead>Last Active</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.sessions.map((session: any) => (
                <TableRow key={session.id}>
                  <TableCell>
                    <Link to={`/users/${session.userId}`} className="text-blue-600 hover:underline">
                      {session.email}
                    </Link>
                  </TableCell>
                  <TableCell>{session.device.name}</TableCell>
                  <TableCell className="font-mono text-sm">{session.device.ipAddress}</TableCell>
                  <TableCell>{new Date(session.lastUsed).toLocaleString()}</TableCell>
                  <TableCell>
                    {session.isActive ? (
                      <Badge variant="default" className="bg-green-500">Active</Badge>
                    ) : (
                      <Badge variant="secondary">Idle</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Link to={`/users/${session.userId}/sessions`}>
                      <Button variant="ghost" size="sm">Manage</Button>
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
```

---

## Testing Requirements

### Unit Tests

#### File: apps/auth/src/routes/admin/__tests__/sessions.test.ts

```typescript
describe('Admin Session Routes', () => {
  describe('GET /admin/users/:userId/sessions', () => {
    it('should return all sessions for user with device details', async () => {
      // Setup: User with 3 sessions on different devices
      // Acceptance: Response contains 3 sessions with device type, name, IP
    });

    it('should return 404 for unknown user', async () => {
      // Acceptance: { error: 'User not found' }, status 404
    });

    it('should filter by tenant (only show tenant user)', async () => {
      // Setup: Admin from tenant A, user in tenant B
      // Acceptance: 404 (user not found in tenant context)
    });

    it('should require admin authentication', async () => {
      // Acceptance: 401/403 without admin role
    });

    it('should require users:read permission', async () => {
      // Setup: Admin without users:read permission
      // Acceptance: 403 Forbidden
    });

    it('should not include revoked sessions', async () => {
      // Setup: 3 sessions, 1 revoked
      // Acceptance: Returns 2 sessions
    });

    it('should not include expired sessions', async () => {
      // Setup: 3 sessions, 1 expired
      // Acceptance: Returns 2 sessions
    });

    it('should order by lastUsed descending', async () => {
      // Acceptance: Most recently used session first
    });

    it('should include browserSessionId for cross-reference', async () => {
      // Acceptance: Each session has browserSessionId
    });

    it('should include authMethod (email, google, mfa)', async () => {
      // Acceptance: authMethod field present
    });
  });

  describe('DELETE /admin/users/:userId/sessions/:sessionId', () => {
    it('should terminate specific session', async () => {
      // Acceptance: account_sessions.is_revoked = 1
    });

    it('should revoke all tokens for that session', async () => {
      // CRITICAL TEST
      // Setup: Session has 3 app_tokens, 1 refresh_token
      // Acceptance: All 4 tokens have is_revoked = 1
    });

    it('should return 404 for session not belonging to user', async () => {
      // Setup: Session belongs to different user
      // Acceptance: { error: 'Session not found' }, status 404
    });

    it('should log audit event with warning severity', async () => {
      // Acceptance: Audit event type = 'admin.session_terminated'
      //            severity = 'warning'
    });

    it('should include device info in audit metadata', async () => {
      // Acceptance: metadata.deviceName present
    });

    it('should require users:manage permission', async () => {
      // Setup: Admin with only users:read (not manage)
      // Acceptance: 403 Forbidden
    });

    it('should work for admin terminating own session', async () => {
      // Note: Different from user self-revoke restriction
      // Acceptance: Session terminated successfully
    });
  });

  describe('DELETE /admin/users/:userId/sessions', () => {
    it('should terminate all user sessions', async () => {
      // Setup: User with 5 sessions
      // Acceptance: All 5 have is_revoked = 1
    });

    it('should revoke all tokens for all sessions', async () => {
      // CRITICAL TEST
      // Setup: User has 3 sessions, 10 tokens total
      // Acceptance: All 10 tokens revoked
    });

    it('should return count of terminated sessions', async () => {
      // Acceptance: { success: true, sessionsTerminated: 5 }
    });

    it('should log audit event', async () => {
      // Acceptance: Audit type = 'admin.sessions_terminated_all'
    });

    it('should include sessions count in audit metadata', async () => {
      // Acceptance: metadata.sessionsTerminated = N
    });

    it('should succeed with 0 sessions (idempotent)', async () => {
      // Setup: User with no active sessions
      // Acceptance: { success: true, sessionsTerminated: 0 }
    });
  });

  describe('POST /admin/users/:userId/force-logout', () => {
    it('should revoke all browser sessions containing user', async () => {
      // Setup: User in 3 browser sessions
      // Acceptance: All 3 browser_sessions.is_revoked = 1
    });

    it('should revoke all account sessions for user', async () => {
      // Acceptance: All account_sessions for user have is_revoked = 1
    });

    it('should revoke all refresh tokens for user', async () => {
      // CRITICAL TEST
      // Setup: User has 5 refresh tokens across sessions
      // Acceptance: All 5 have is_revoked = 1
    });

    it('should return 404 for unknown user', async () => {
      // Acceptance: { error: 'User not found' }, status 404
    });

    it('should log critical severity audit event', async () => {
      // Acceptance: Audit type = 'admin.force_logout'
      //            severity = 'critical'
    });

    it('should include reason in audit metadata', async () => {
      // Setup: Request body { reason: 'Security concern' }
      // Acceptance: metadata.reason = 'Security concern'
    });

    it('should default reason to "Admin initiated"', async () => {
      // Setup: No reason in request body
      // Acceptance: metadata.reason = 'Admin initiated'
    });

    it('should return stats of revoked items', async () => {
      // Acceptance: {
      //   browserSessionsRevoked: N,
      //   accountSessionsRevoked: N,
      //   refreshTokensRevoked: N
      // }
    });

    it('should not affect other users in shared browser sessions', async () => {
      // Setup: Browser with User A (target) and User B
      // Test: Force logout User A
      // Acceptance: User B's account session in that browser unaffected
      // Note: Browser session is revoked, so User B will need to re-auth
    });

    it('should require users:manage permission', async () => {
      // Acceptance: 403 without permission
    });
  });

  describe('GET /admin/sessions', () => {
    it('should return all sessions with pagination', async () => {
      // Acceptance: Response has sessions array, total, limit, offset
    });

    it('should filter by device_type', async () => {
      // Setup: ?device_type=mobile
      // Acceptance: Only mobile sessions returned
    });

    it('should filter by ip_address', async () => {
      // Setup: ?ip_address=192.168.1.1
      // Acceptance: Only sessions from that IP
    });

    it('should filter by user_id', async () => {
      // Setup: ?user_id=user123
      // Acceptance: Only sessions for that user
    });

    it('should combine multiple filters', async () => {
      // Setup: ?device_type=desktop&ip_address=10.0.0.1
      // Acceptance: Sessions matching both criteria
    });

    it('should respect pagination limit', async () => {
      // Setup: 100 sessions, ?limit=10
      // Acceptance: Returns 10 sessions
    });

    it('should respect pagination offset', async () => {
      // Setup: ?limit=10&offset=20
      // Acceptance: Returns sessions 21-30
    });

    it('should include user email in each session', async () => {
      // Acceptance: Each session has email field
    });

    it('should filter by tenant', async () => {
      // Acceptance: Only sessions from admin's tenant
    });
  });

  describe('GET /admin/sessions/stats', () => {
    it('should return total sessions count', async () => {
      // Acceptance: { totalSessions: N }
    });

    it('should return active sessions (last hour)', async () => {
      // Acceptance: { activeSessions: N }
    });

    it('should return logins in last 24 hours', async () => {
      // Acceptance: { loginsLast24h: N }
    });

    it('should return device breakdown', async () => {
      // Acceptance: { deviceBreakdown: { desktop: N, mobile: N, tablet: N } }
    });

    it('should filter by tenant', async () => {
      // Acceptance: Stats only for admin's tenant
    });

    it('should require analytics:read permission', async () => {
      // Acceptance: 403 without permission
    });
  });

  describe('GET /admin/sessions/suspicious', () => {
    it('should detect users with multiple IPs in 24 hours', async () => {
      // Setup: User logged in from 5 different IPs
      // Acceptance: User in multipleIPsInShortTime array
    });

    it('should only flag users with >3 IPs', async () => {
      // Setup: User with 3 IPs (threshold)
      // Acceptance: User NOT in suspicious list
    });

    it('should detect failed then successful login pattern', async () => {
      // Setup: User with 5 failed logins, then success
      // Acceptance: User in failedThenSuccessfulLogins array
    });

    it('should only flag >=3 failed attempts', async () => {
      // Setup: User with 2 failed, then success
      // Acceptance: User NOT in suspicious list
    });

    it('should include failed attempt count', async () => {
      // Acceptance: { failedAttempts: 5, lastFailure: timestamp }
    });

    it('should return IP addresses list', async () => {
      // Acceptance: { ipAddresses: ['1.1.1.1', '2.2.2.2', ...] }
    });

    it('should limit results to 20 per category', async () => {
      // Acceptance: Max 20 in each array
    });

    it('should require audit:read permission', async () => {
      // Acceptance: 403 without permission
    });

    it('should filter by tenant', async () => {
      // Acceptance: Only suspicious activity for admin's tenant
    });
  });
});
```

### Token Revocation in Admin Operations Tests

```typescript
describe('Admin Token Revocation', () => {
  /**
   * These tests verify that ALL admin session operations properly revoke tokens
   */

  describe('Single Session Termination', () => {
    it('should revoke all app_tokens for terminated session', async () => {
      // Setup: Session with 3 app_tokens for different clients
      const tokens = await createAppTokens(sessionId, ['client-a', 'client-b', 'client-c']);

      // Act: Admin terminates session
      await adminRequest.delete(`/admin/users/${userId}/sessions/${sessionId}`);

      // Assert: All tokens revoked
      for (const token of tokens) {
        const dbToken = await getAppToken(token.id);
        expect(dbToken.is_revoked).toBe(true);
      }
    });

    it('should revoke refresh tokens for terminated session', async () => {
      // Setup
      const refreshToken = await createRefreshToken(sessionId);

      // Act
      await adminRequest.delete(`/admin/users/${userId}/sessions/${sessionId}`);

      // Assert
      const dbToken = await getRefreshToken(refreshToken.id);
      expect(dbToken.is_revoked).toBe(true);
    });
  });

  describe('All Sessions Termination', () => {
    it('should revoke tokens across all user sessions', async () => {
      // Setup: User has 3 sessions with various tokens
      const sessions = await createUserSessions(userId, 3);
      const allTokens = await createTokensForSessions(sessions);

      // Act
      await adminRequest.delete(`/admin/users/${userId}/sessions`);

      // Assert: All tokens revoked
      for (const token of allTokens) {
        const dbToken = await getToken(token.id);
        expect(dbToken.is_revoked).toBe(true);
      }
    });
  });

  describe('Force Logout', () => {
    it('should revoke ALL refresh tokens for user', async () => {
      // Setup: User has tokens across multiple sessions
      const refreshTokens = await createUserRefreshTokens(userId, 10);

      // Act
      await adminRequest.post(`/admin/users/${userId}/force-logout`);

      // Assert: All revoked
      for (const rt of refreshTokens) {
        const dbToken = await getRefreshToken(rt.id);
        expect(dbToken.is_revoked).toBe(true);
        expect(dbToken.revoked_at).toBeDefined();
      }
    });

    it('should make user tokens fail introspection immediately', async () => {
      // Setup
      const { accessToken } = await loginAs(userId);

      // Act
      await adminRequest.post(`/admin/users/${userId}/force-logout`);

      // Assert
      const introspection = await request.post('/token/introspect', {
        data: { token: accessToken },
      });
      expect((await introspection.json()).active).toBe(false);
    });

    it('should make user refresh tokens fail immediately', async () => {
      // Setup
      const { refreshToken } = await loginAs(userId);

      // Act
      await adminRequest.post(`/admin/users/${userId}/force-logout`);

      // Assert
      const refreshResponse = await request.post('/token', {
        data: { grant_type: 'refresh_token', refresh_token: refreshToken },
      });
      expect(refreshResponse.ok()).toBe(false);
    });
  });
});
```

### Permission & Authorization Tests

```typescript
describe('Admin Permission Checks', () => {
  describe('Role Requirements', () => {
    it('should reject non-admin users', async () => {
      // Setup: Regular user token
      // Test all endpoints
      // Acceptance: 403 Forbidden for all
    });

    it('should accept admin role users', async () => {
      // Setup: User with admin role
      // Acceptance: Endpoints accessible
    });

    it('should accept super_admin role', async () => {
      // Acceptance: Full access
    });
  });

  describe('Permission Requirements', () => {
    const endpoints = [
      { path: '/admin/users/:id/sessions', method: 'GET', permission: 'users:read' },
      { path: '/admin/users/:id/sessions/:sid', method: 'DELETE', permission: 'users:manage' },
      { path: '/admin/users/:id/sessions', method: 'DELETE', permission: 'users:manage' },
      { path: '/admin/users/:id/force-logout', method: 'POST', permission: 'users:manage' },
      { path: '/admin/sessions', method: 'GET', permission: 'users:read' },
      { path: '/admin/sessions/stats', method: 'GET', permission: 'analytics:read' },
      { path: '/admin/sessions/suspicious', method: 'GET', permission: 'audit:read' },
    ];

    endpoints.forEach(({ path, method, permission }) => {
      it(`${method} ${path} requires ${permission}`, async () => {
        // Setup: Admin WITHOUT the required permission
        // Acceptance: 403 Forbidden
      });
    });
  });

  describe('Tenant Isolation', () => {
    it('should not allow viewing sessions for users in other tenants', async () => {
      // Setup: Admin in tenant A, user in tenant B
      // Acceptance: 404 User not found
    });

    it('should not allow terminating sessions in other tenants', async () => {
      // Acceptance: 404 or 403
    });

    it('should filter session list by admin tenant', async () => {
      // Setup: Sessions in tenant A and B
      // Test: Admin from tenant A calls /admin/sessions
      // Acceptance: Only tenant A sessions returned
    });
  });
});
```

### Admin UI Component Tests

```typescript
describe('Admin Sessions UI', () => {
  describe('User Sessions Page', () => {
    it('should display all user sessions', async () => {
      // Acceptance: List shows all sessions with device icons
    });

    it('should show device type icons correctly', async () => {
      // Acceptance: Mobile = Smartphone icon, Desktop = Laptop icon
    });

    it('should highlight active session with green border', async () => {
      // Acceptance: Active session card has green border
    });

    it('should show terminate button for each session', async () => {
      // Acceptance: Each session has terminate button
    });

    it('should show confirmation dialog before terminate', async () => {
      // Acceptance: AlertDialog appears with session details
    });

    it('should disable buttons during loading', async () => {
      // Acceptance: Buttons disabled while fetcher.state !== idle
    });

    it('should show Force Logout button with destructive styling', async () => {
      // Acceptance: Red/destructive button variant
    });

    it('should show critical warning in force logout dialog', async () => {
      // Acceptance: Dialog mentions "critical security action"
    });

    it('should show session summary stats', async () => {
      // Acceptance: Total, Mobile, Desktop counts displayed
    });
  });

  describe('Sessions Dashboard', () => {
    it('should display stats cards', async () => {
      // Acceptance: Total Sessions, Active Now, Logins 24h, Suspicious
    });

    it('should highlight suspicious activity count', async () => {
      // Acceptance: Orange border when suspicious > 0
    });

    it('should show device breakdown chart', async () => {
      // Acceptance: Desktop, Mobile, Tablet counts with badges
    });

    it('should show suspicious activity alert when detected', async () => {
      // Acceptance: Orange alert card with details
    });

    it('should link suspicious users to their sessions page', async () => {
      // Acceptance: Email is clickable link to /users/:id/sessions
    });

    it('should allow filtering by device type', async () => {
      // Acceptance: Select dropdown filters table
    });

    it('should allow filtering by IP address', async () => {
      // Acceptance: Input field filters table
    });

    it('should show manage button linking to user sessions', async () => {
      // Acceptance: Each row has Manage button
    });
  });
});
```

### E2E Tests

```typescript
test.describe('Admin Session Management E2E', () => {
  test('admin can view user sessions with device details', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/users/user123/sessions');

    await expect(page.getByText('User Sessions')).toBeVisible();
    await expect(page.getByText('Chrome on Windows')).toBeVisible();
    await expect(page.locator('[data-testid="session-card"]')).toHaveCount(3);
  });

  test('admin can terminate single session with confirmation', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/users/user123/sessions');

    // Click terminate on first session
    await page.locator('[data-testid="terminate-btn"]').first().click();

    // Confirmation dialog appears
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(page.getByText('Terminate Session?')).toBeVisible();

    // Confirm
    await page.getByRole('button', { name: 'Terminate' }).click();

    // Session should be removed from list
    await expect(page.locator('[data-testid="session-card"]')).toHaveCount(2);
  });

  test('terminated session tokens become invalid', async ({ page, request }) => {
    // Get user's token before admin action
    const { accessToken, refreshToken } = await loginAsUser('user123@test.com');

    // Admin terminates session
    await loginAsAdmin(page);
    const sessionId = await getSessionIdForUser('user123');
    await page.goto(`/users/user123/sessions`);
    await page.locator('[data-testid="terminate-btn"]').first().click();
    await page.getByRole('button', { name: 'Terminate' }).click();

    // User's tokens should now be invalid
    const introspect = await request.post('/token/introspect', {
      data: { token: accessToken },
    });
    expect((await introspect.json()).active).toBe(false);

    const refresh = await request.post('/token', {
      data: { grant_type: 'refresh_token', refresh_token: refreshToken },
    });
    expect(refresh.ok()).toBe(false);
  });

  test('admin can force logout user with all tokens revoked', async ({ page, request }) => {
    // Get user's tokens
    const { accessToken } = await loginAsUser('user123@test.com');

    // Admin force logout
    await loginAsAdmin(page);
    await page.goto('/users/user123/sessions');

    await page.getByRole('button', { name: 'Force Logout' }).click();
    await expect(page.getByText('critical security action')).toBeVisible();
    await page.getByRole('button', { name: 'Force Logout' }).click();

    await expect(page.getByText('logged out from all devices')).toBeVisible();

    // All tokens invalid
    const introspect = await request.post('/token/introspect', {
      data: { token: accessToken },
    });
    expect((await introspect.json()).active).toBe(false);
  });

  test('sessions dashboard shows accurate stats', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/sessions');

    // Stats cards visible
    await expect(page.getByText('Total Sessions')).toBeVisible();
    await expect(page.getByText('Active Now')).toBeVisible();
    await expect(page.getByText('Logins (24h)')).toBeVisible();
  });

  test('suspicious activity is highlighted with correct data', async ({ page }) => {
    // Setup: Create suspicious activity
    await createMultipleIPLogins('user123', 5);

    await loginAsAdmin(page);
    await page.goto('/sessions');

    // Suspicious card highlighted
    await expect(page.locator('.border-orange-500')).toBeVisible();
    await expect(page.getByText('Suspicious Activity Detected')).toBeVisible();
    await expect(page.getByText('different IPs')).toBeVisible();
  });

  test('admin can filter sessions by device type', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/sessions');

    // Select mobile filter
    await page.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Mobile' }).click();

    // Wait for filtered results
    await page.waitForResponse(resp => resp.url().includes('device_type=mobile'));

    // Only mobile sessions shown
    const deviceCells = page.locator('td:nth-child(2)');
    await expect(deviceCells).toContainText(['Safari on iOS', 'Chrome on Android']);
  });

  test('admin without users:manage cannot terminate sessions', async ({ page }) => {
    // Login as admin with only users:read permission
    await loginAsLimitedAdmin(page);
    await page.goto('/users/user123/sessions');

    // Terminate buttons should be disabled or hidden
    await expect(page.getByRole('button', { name: 'Terminate All' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Force Logout' })).toBeDisabled();
  });

  test('session list paginates correctly', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/sessions?limit=10');

    // First page
    await expect(page.locator('tbody tr')).toHaveCount(10);

    // Navigate to next page
    await page.getByRole('button', { name: 'Next' }).click();

    // URL updated
    await expect(page).toHaveURL(/offset=10/);
  });
});
```

### Coverage Requirements

| Component | Target Coverage |
|-----------|----------------|
| Admin Session Routes | >90% |
| Permission Middleware | 100% |
| Token Revocation in Admin | 100% |
| Suspicious Activity Detection | >80% |
| User Sessions UI | >80% |
| Sessions Dashboard UI | >80% |

**Overall Lane 6 Coverage Target: >85%**

**Critical Path Coverage**: The following must have 100% coverage:
- Token revocation in all admin operations
- Permission checks for all endpoints
- Force logout complete revocation
- Tenant isolation

---

## Rollout Checklist

- [ ] Implement admin session API routes
- [ ] Add session management to admin dashboard
- [ ] Implement suspicious activity detection
- [ ] Add session statistics endpoint
- [ ] Create user sessions page UI
- [ ] Create sessions dashboard UI
- [ ] Add force logout functionality
- [ ] Add bulk session operations
- [ ] Emit audit events for all operations
- [ ] Write unit tests
- [ ] Write E2E tests
- [ ] Update admin navigation
- [ ] Document admin session management

---

## Estimated Effort
- API routes: 6-8 hours
- Admin UI - User sessions page: 4-6 hours
- Admin UI - Sessions dashboard: 4-6 hours
- Suspicious activity detection: 3-4 hours
- Testing: 6-8 hours
- Documentation: 2 hours
- **Total: 25-34 hours**

## Security Considerations
- All operations require admin role
- Force logout requires 'users:manage' permission
- All operations logged as audit events (warning/critical level)
- Suspicious activity detection runs automatically
- Cannot terminate own session via admin routes
- Rate limiting on session management operations
