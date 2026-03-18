// ─── Structured JSON Logger ──────────────────────────────────────────

type LogLevel = 'info' | 'warn' | 'error';

interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

function log(
  level: LogLevel,
  requestId: string,
  event: string,
  data?: Record<string, unknown>,
): void {
  const entry: Record<string, unknown> = {
    ...data,
    timestamp: new Date().toISOString(),
    level,
    event,
    requestId,
  };
  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else if (level === 'warn') {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

export function createLogger(requestId: string): Logger {
  return {
    info(event: string, data?: Record<string, unknown>): void {
      log('info', requestId, event, data);
    },
    warn(event: string, data?: Record<string, unknown>): void {
      log('warn', requestId, event, data);
    },
    error(event: string, data?: Record<string, unknown>): void {
      log('error', requestId, event, data);
    },
  };
}
