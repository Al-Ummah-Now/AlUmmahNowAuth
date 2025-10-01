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

  private async saveToD1(level: LogLevel, message: string, context?: LogContext): Promise<void> {
    if (!this.enableD1Logging || !this.db) return;

    try {
      const timestamp = new Date().toISOString();
      const contextStr = context ? JSON.stringify(context) : null;

      await this.db.prepare(
        'INSERT INTO logs (timestamp, level, service, message, context) VALUES (?, ?, ?, ?, ?)'
      ).bind(timestamp, level.toUpperCase(), 'ADMIN', message, contextStr).run();
    } catch (error) {
      // Silently fail D1 logging to avoid infinite loops
      console.error('[Logger] Failed to save to D1:', error);
    }
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

    // Save to D1 using ctx.waitUntil to ensure it completes even after response is sent
    if (this.enableD1Logging && this.ctx) {
      this.ctx.waitUntil(
        this.saveToD1(level, message, context).catch((err) => {
          console.error('[Logger] Failed to save to D1:', err);
        })
      );
    } else if (this.enableD1Logging) {
      // Fallback for development without ExecutionContext (shouldn't happen with wrangler dev)
      console.warn('[Logger] ExecutionContext not set - logs may not persist to D1');
      this.saveToD1(level, message, context).catch((err) => {
        console.error('[Logger] Failed to save to D1:', err);
      });
    }
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
