/**
 * HTTP response helpers, CORS, and security headers.
 */

// ─── Security Headers ────────────────────────────────────────────────

const CSP_POLICY = [
  'default-src \'self\'',
  'script-src \'self\' \'unsafe-inline\'',  // inline scripts in single-file app
  'style-src \'self\' \'unsafe-inline\'',   // inline styles
  'img-src \'self\' https://commons.wikimedia.org https://upload.wikimedia.org data:',
  'connect-src \'self\'',
  'worker-src \'self\'',
  'font-src \'self\'',
  'object-src \'none\'',
  'base-uri \'self\'',
  'form-action \'self\'',
  'frame-ancestors \'none\'',
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function addSecurityHeaders(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

// ─── CORS ────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://xiki.emilycogsdill.com',
  'https://xikipedia.emily-cogsdill.workers.dev',
];

export function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
  };
}

// ─── Response Helpers ────────────────────────────────────────────────

export function jsonResponse(
  request: Request,
  data: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request),
    },
  });
}

export function errorResponse(request: Request, message: string, status: number): Response {
  return jsonResponse(request, { error: message }, status);
}

// ─── Client IP ───────────────────────────────────────────────────────

export function getClientIp(request: Request): string {
  // In production, Cloudflare sets both headers and controls X-Forwarded-For
  // (clients can't spoof it). Prioritizing XFF lets tests isolate rate limits
  // via spoofed IPs while wrangler dev sets CF-Connecting-IP to 127.0.0.1.
  return request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ||
         request.headers.get('CF-Connecting-IP') ||
         'unknown';
}
