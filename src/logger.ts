/**
 * Structured JSON logger for Cloudflare Workers.
 * Cloudflare Observability parses JSON from stdout automatically.
 */

type LogLevel = 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  requestId: string;
  [key: string]: unknown;
}

export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

export function createLogger(requestId: string): Logger {
  function log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    try {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level,
        event,
        requestId,
        ...data,
      };
      console.log(JSON.stringify(entry));
    } catch {
      // Never throw from logger
    }
  }

  return {
    info:  (event, data) => log('info',  event, data),
    warn:  (event, data) => log('warn',  event, data),
    error: (event, data) => log('error', event, data),
  };
}
