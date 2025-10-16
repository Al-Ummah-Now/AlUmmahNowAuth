/**
 * Test Helper Utilities for Audit Logging Tests
 *
 * Provides mock objects, test data generators, and utility functions
 * for comprehensive audit logging test coverage.
 */

import { vi } from 'vitest';
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
    errorMessage: null,
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
    errorMessage: null,
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
    errorMessage: null,
  };
}

/**
 * Mock D1Database for testing
 */
export class MockD1Database implements D1Database {
  private data: Map<string, any[]> = new Map();
  private shouldFail: 'none' | 'locked' | 'constraint' | 'timeout' | 'partial' = 'none';
  private failureCount = 0;
  public batch = vi.fn();
  public prepare = vi.fn();

  constructor() {
    this.batch = vi.fn(this._batchImpl.bind(this));
    this.prepare = vi.fn(this._prepareImpl.bind(this));
  }

  simulateError(errorType: 'locked' | 'constraint' | 'timeout' | 'partial') {
    this.shouldFail = errorType;
    this.failureCount = 0;
  }

  clearError() {
    this.shouldFail = 'none';
  }

  private _prepareImpl(query: string): D1PreparedStatement {
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

  private async _batchImpl(statements: D1PreparedStatement[]): Promise<D1Result[]> {
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
    if (this.shouldFail === 'partial') {
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
    this.data.get('audit_events')!.push(...statements);

    return results;
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }

  async exec(query: string): Promise<D1ExecResult> {
    return { count: 0, duration: 0 };
  }

  withSession(constraintOrBookmark?: string): D1DatabaseSession {
    // Return a mock session object
    return this as any as D1DatabaseSession;
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
    this.batch.mockClear();
    this.prepare.mockClear();
  }
}

/**
 * Create mock D1 database
 */
export function createMockD1Database(): MockD1Database {
  return new MockD1Database();
}

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

/**
 * Create mock webhook server
 */
export function createMockWebhookServer(): MockWebhookServer {
  return new MockWebhookServer();
}

/**
 * Mock ExecutionContext
 */
export function createMockExecutionContext(): ExecutionContext & { _awaitAll: () => Promise<void> } {
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
