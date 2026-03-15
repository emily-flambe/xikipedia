// ─── Structured Logger ───────────────────────────────────────────────

export function createLogger(requestId: string) {
  function log(level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>): void {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      requestId,
      ...data,
    }));
  }

  return {
    info(event: string, data?: Record<string, unknown>): void {
      log('info', event, data);
    },
    warn(event: string, data?: Record<string, unknown>): void {
      log('warn', event, data);
    },
    error(event: string, data?: Record<string, unknown>): void {
      log('error', event, data);
    },
  };
}
