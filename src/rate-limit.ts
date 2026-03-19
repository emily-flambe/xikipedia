/**
 * Rate limiting utilities backed by D1.
 */

import { getCorsHeaders } from './helpers';

// ─── Rate Limiting ────────────────────────────────────────────────────

/** Returns true if the IP can be meaningfully rate-limited.
 *  Loopback and unknown IPs are excluded — in production, CF always provides
 *  a real client IP via CF-Connecting-IP. */
export function isRateLimitableIp(ip: string): boolean {
  return ip !== 'unknown' && ip !== '127.0.0.1' && ip !== '::1';
}

export async function atomicIncrement(
  db: D1Database,
  key: string,
  windowSec: number,
): Promise<{ count: number; windowStart: number }> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSec);
  const result = await db
    .prepare(`
      INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN window_start < ?2 THEN 1 ELSE count + 1 END,
        window_start = CASE WHEN window_start < ?2 THEN ?2 ELSE window_start END
      RETURNING count, window_start
    `)
    .bind(key, windowStart)
    .first<{ count: number; window_start: number }>();

  return result
    ? { count: result.count, windowStart: result.window_start }
    : { count: 1, windowStart };
}

export async function resetRateLimit(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
}

export function rateLimitResponse(request: Request, windowStart: number, windowSec: number): Response {
  const now = Math.floor(Date.now() / 1000);
  const retryAfter = Math.max(1, windowStart + windowSec - now);
  return new Response(JSON.stringify({ error: 'Too many requests' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfter),
      ...getCorsHeaders(request),
    },
  });
}
