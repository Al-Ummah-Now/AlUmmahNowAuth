/**
 * Server-side logging utility for admin dashboard (Cloudflare Workers)
 * Provides structured logging with different levels and context
 * Logs to console (viewable via wrangler tail or Cloudflare dashboard)
 * Optionally logs to D1 database for persistent storage
 * 
 * Note: Cloudflare Workers don't have filesystem access. Use console logs
 * which are captured by Cloudflare's logging infrastructure. For persistent
 * logs, enable Logpush in your Cloudflare dashboard, or use D1 storage.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  [key: string]: any;
}

class Logger {
  private db: D1Database | null = null;
  private enableD1Logging = false;
  private ctx: ExecutionContext | null = null;
  private logQueue: Array<{ level: LogLevel; message: string; context?: LogContext; timestamp: string }> = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private isFlushingLogs = false;

  /**
   * Initialize D1 logging (call this from your loaders/actions)
   */
  setDatabase(db: D1Database | null, enabled: boolean = true): void {
    this.db = db;
    this.enableD1Logging = enabled && db !== null;
  }

  /**
   * Set the execution context to allow async operations to complete after response
   */
  setContext(ctx: ExecutionContext): void {
    this.ctx = ctx;
  }

  private formatMessage(level: LogLevel, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    const contextStr = context ? ` | ${JSON.stringify(context)}` : '';
    return `[${timestamp}] [ADMIN] [${level.toUpperCase()}] ${message}${contextStr}`;
  }

  private async flushLogsToD1(): Promise<void> {
    if (!this.enableD1Logging || !this.db || this.logQueue.length === 0 || this.isFlushingLogs) {
      return;
    }

    this.isFlushingLogs = true;
    const logsToFlush = [...this.logQueue];
    this.logQueue = [];

    try {
      // Use D1 batch API to write all logs in a single transaction
      const statements = logsToFlush.map(log => {
        const contextStr = log.context ? JSON.stringify(log.context) : null;
        return this.db!.prepare(
          'INSERT INTO logs (timestamp, level, service, message, context) VALUES (?, ?, ?, ?, ?)'
        ).bind(log.timestamp, log.level.toUpperCase(), 'ADMIN', log.message, contextStr);
      });

      await this.db.batch(statements);
    } catch (error) {
      // Silently fail D1 logging to avoid infinite loops
      console.error('[Logger] Failed to flush logs to D1:', error);
    } finally {
      this.isFlushingLogs = false;
    }
  }

  private queueLogForD1(level: LogLevel, message: string, context?: LogContext): void {
    if (!this.enableD1Logging) return;

    const timestamp = new Date().toISOString();
    this.logQueue.push({ level, message, context, timestamp });

    // Clear existing timer and set a new one to batch writes
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }

    // Flush logs after 100ms of inactivity or if queue is large
    const shouldFlushImmediately = this.logQueue.length >= 10;
    const flushDelay = shouldFlushImmediately ? 0 : 100;

    this.flushTimer = setTimeout(() => {
      if (this.ctx) {
        this.ctx.waitUntil(this.flushLogsToD1());
      } else {
        this.flushLogsToD1();
      }
    }, flushDelay);
  }

  private log(level: LogLevel, message: string, context?: LogContext): void {
    const formattedMessage = this.formatMessage(level, message, context);

    // Write to console (captured by Cloudflare Workers logging)
    switch (level) {
      case 'debug':
        console.debug(formattedMessage);
        break;
      case 'info':
        console.log(formattedMessage);
        break;
      case 'warn':
        console.warn(formattedMessage);
        break;
      case 'error':
        console.error(formattedMessage);
        break;
    }

    // Queue log for batched D1 write
    this.queueLogForD1(level, message, context);
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }

  // Loader logging helper
  logLoader(loaderName: string, request: Request, additionalContext?: LogContext): void {
    const url = new URL(request.url);
    this.info(`Loader: ${loaderName}`, {
      path: url.pathname,
      search: url.search,
      ...additionalContext,
    });
  }

  // Action logging helper
  logAction(actionName: string, request: Request, additionalContext?: LogContext): void {
    const url = new URL(request.url);
    this.info(`Action: ${actionName}`, {
      method: request.method,
      path: url.pathname,
      ...additionalContext,
    });
  }

  // Auth logging helper
  logAuth(event: string, context?: LogContext): void {
    this.info(`Auth: ${event}`, context);
  }

  // Database logging helper
  logDB(operation: string, context?: LogContext): void {
    this.debug(`DB: ${operation}`, context);
  }
}

export const logger = new Logger();
