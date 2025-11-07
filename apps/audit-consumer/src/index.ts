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

import { handleAuditBatch } from "@openauthjs/openauth/services/audit-consumer";
import type { AuditEventMessage } from "@openauthjs/openauth/services/audit";

/**
 * Queue consumer handler
 *
 * Processes batches of audit events from Cloudflare Queue.
 * Messages are batched for efficiency (up to 50 events per batch).
 *
 * @param batch - Batch of audit event messages from queue
 * @param env - Worker environment with D1 database binding
 */
export default {
  async queue(
    batch: MessageBatch<AuditEventMessage>,
    env: Env
  ): Promise<void> {
    const startTime = Date.now();
    const messageCount = batch.messages.length;

    console.log(
      `AuditConsumer: Processing batch of ${messageCount} audit events`
    );

    try {
      // Use OpenAuth's built-in batch handler
      await handleAuditBatch(batch, env.AUDIT_DB, "token_usage");

      const duration = Date.now() - startTime;
      console.log(
        `AuditConsumer: Successfully processed ${messageCount} events in ${duration}ms`
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(
        `AuditConsumer: Failed to process batch after ${duration}ms:`,
        error
      );
      // handleAuditBatch already handles retries, so this is just for logging
    }
  },

  /**
   * HTTP endpoint for health checks and metrics
   */
  async fetch(request: Request, env: Env): Promise<Response> {
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
} satisfies ExportedHandler<Env>;
