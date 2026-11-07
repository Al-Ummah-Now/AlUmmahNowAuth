/**
 * Al Ummah Now - Audit Event Consumer
 *
 * Cloudflare Queue consumer that processes audit events and writes them to D1.
 * This worker runs separately from the main auth server for better scalability.
 *
 * Architecture:
 * - Auth server publishes audit events to queue (non-blocking)
 * - This consumer reads from queue in batches
 * - Writes to D1 in batch transactions for performance
 * - Automatic retries with exponential backoff
 * - Dead letter queue for failed messages
 *
 * @packageDocumentation
 */

import type { AuditEventMessage } from "@al-ummah-now/openauth/services/audit";
import type { ExportedHandler, MessageBatch as CloudflareMessageBatch, Message, D1Database } from "@cloudflare/workers-types";

/**
 * Application audit event published by apps/auth's QueueSink
 * (see apps/auth/src/audit-emitter.ts AppAuditQueueMessage).
 */
export interface AppAuditQueueMessage {
  version: 1;
  type: "app_audit_event";
  event: {
    timestamp: string;
    eventType: string;
    severity: string;
    userId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    requestId: string | null;
    metadata?: Record<string, unknown>;
    success: boolean;
    errorMessage?: string | null;
  };
  enqueued_at: number;
}

type QueueMessageBody = AuditEventMessage | AppAuditQueueMessage;

export function isAppAuditMessage(body: unknown): body is AppAuditQueueMessage {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { type?: unknown }).type === "app_audit_event" &&
    typeof (body as { event?: unknown }).event === "object"
  );
}

/**
 * Convert an OpenAuth token-usage event to a row of the live token_usage table
 * (apps/auth/migrations/0002_jwt_tokens.sql):
 *   id, tenant_id, client_id NOT NULL, user_id, token_type NOT NULL,
 *   ip_address, user_agent, created_at (epoch ms)
 * The lifecycle event (generated/refreshed/revoked/reused) is stored in token_type.
 */
export function toTokenUsageRow(event: AuditEventMessage["event"]) {
  const subject = event.subject ?? "";
  const userId = subject.includes(":") ? subject.slice(subject.indexOf(":") + 1) : subject || null;
  const tenantId =
    typeof event.metadata?.tenant_id === "string" && event.metadata.tenant_id ? event.metadata.tenant_id : "default";
  // Accept both seconds and milliseconds
  const ts = typeof event.timestamp === "number" && event.timestamp > 0 ? event.timestamp : Date.now();
  const createdAt = ts < 1e12 ? ts * 1000 : ts;
  return {
    tenant_id: tenantId,
    client_id: event.client_id || "unknown",
    user_id: userId,
    token_type: event.event_type,
    ip_address: event.ip_address ?? null,
    user_agent: event.user_agent ?? null,
    created_at: createdAt,
  };
}

/** Max delivery attempts before a message is acknowledged and dropped (logged) */
const MAX_APP_EVENT_ATTEMPTS = 3;

async function writeWithRetry<T>(
  messages: readonly Message<T>[],
  label: string,
  write: () => Promise<unknown>
): Promise<void> {
  if (messages.length === 0) return;
  try {
    await write();
    messages.forEach((m) => m.ack());
  } catch (error) {
    console.error(`AuditConsumer: failed to write ${label}:`, error);
    for (const m of messages) {
      if (m.attempts < MAX_APP_EVENT_ATTEMPTS) {
        m.retry({ delaySeconds: Math.pow(2, m.attempts) * 5 });
      } else {
        console.error(JSON.stringify({ type: "audit_events_backup", kind: label, body: m.body }));
        m.ack();
      }
    }
  }
}

/**
 * Write application audit events to the audit_events table (same columns as
 * apps/auth D1Sink). Retries the messages on failure; after the last attempt
 * the events are logged so they remain recoverable from Workers logs.
 */
export async function handleAppAuditMessages(
  messages: readonly Message<AppAuditQueueMessage>[],
  db: D1Database
): Promise<void> {
  await writeWithRetry(messages, "app audit events", () => {
    const stmt = db.prepare(
      `INSERT INTO audit_events (
        timestamp, event_type, severity, user_id, ip_address,
        user_agent, request_id, metadata, success, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    return db.batch(
      messages.map(({ body: { event } }) =>
        stmt.bind(
          event.timestamp,
          event.eventType,
          event.severity,
          event.userId ?? null,
          event.ipAddress ?? null,
          event.userAgent ?? null,
          event.requestId ?? null,
          JSON.stringify(event.metadata ?? {}),
          event.success ? 1 : 0,
          event.errorMessage ?? null
        )
      )
    );
  });
}

/**
 * Write OpenAuth token-usage events to the live token_usage table.
 */
export async function handleTokenUsageMessages(
  messages: readonly Message<AuditEventMessage>[],
  db: D1Database
): Promise<void> {
  await writeWithRetry(messages, "token usage events", () => {
    const stmt = db.prepare(
      `INSERT INTO token_usage (
        tenant_id, client_id, user_id, token_type, ip_address, user_agent, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    return db.batch(
      messages.map(({ body }) => {
        const r = toTokenUsageRow(body.event);
        return stmt.bind(r.tenant_id, r.client_id, r.user_id, r.token_type, r.ip_address, r.user_agent, r.created_at);
      })
    );
  });
}

export default {
  async queue(
    batch: CloudflareMessageBatch<QueueMessageBody>,
    env: Env
  ): Promise<void> {
    const startTime = Date.now();
    const messageCount = batch.messages.length;

    console.info(
      `AuditConsumer: Processing batch of ${messageCount} audit events`
    );

    // Split application audit events (-> audit_events) from OpenAuth token usage events
    const appMessages = batch.messages.filter((m) => isAppAuditMessage(m.body)) as Message<AppAuditQueueMessage>[];
    const tokenMessages = batch.messages.filter((m) => !isAppAuditMessage(m.body));

    try {
      await handleAppAuditMessages(appMessages, env.AUDIT_DB);

      await handleTokenUsageMessages(tokenMessages as Message<AuditEventMessage>[], env.AUDIT_DB);

      const duration = Date.now() - startTime;
      console.info(
        `AuditConsumer: Successfully processed ${messageCount} events in ${duration}ms`
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(
        `AuditConsumer: Failed to process batch after ${duration}ms:`,
        error
      );
      // Per-message retry/ack is handled by the write helpers; this is just for logging
    }
  },

  /**
   * HTTP endpoint for health checks and metrics
   */
  // @ts-expect-error - Type mismatch between Cloudflare Workers types versions
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          service: "audit-consumer",
          timestamp: Date.now(),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Metrics endpoint (basic)
    if (url.pathname === "/metrics") {
      // In production, you'd track metrics via Cloudflare Analytics or a metrics service
      return new Response(
        JSON.stringify({
          service: "audit-consumer",
          message: "Metrics available via Cloudflare Analytics",
          timestamp: Date.now(),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response("Audit Consumer - Queue Worker", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  },
} satisfies ExportedHandler<Env, QueueMessageBody>;
