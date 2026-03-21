/**
 * Xikipedia Cloudflare Worker
 *
 * Serves static assets, proxies the large data file from R2 storage,
 * and provides user authentication + preferences API.
 */

import { createLogger } from './logger';
import { addSecurityHeaders, getCorsHeaders, errorResponse } from './helpers';
import { serveR2File } from './r2';
import { ensureTables, API_ROUTES, initApiRoutes, apiRoutesInitialized } from './routes';

export interface Env {
  DATA_BUCKET: R2Bucket;
  DB: D1Database;
  JWT_SECRET: string;
}

// ─── Environment Validation ──────────────────────────────────────────

function validateApiEnv(env: Env): string | null {
  if (!env.JWT_SECRET) {
    return 'JWT_SECRET is not configured';
  }
  if (env.JWT_SECRET.length < 32) {
    return 'JWT_SECRET must be at least 32 characters';
  }
  if (!env.DB) {
    return 'D1 database binding (DB) is not configured';
  }
  return null;
}

function validateR2Env(env: Env): string | null {
  if (!env.DATA_BUCKET) {
    return 'R2 bucket binding (DATA_BUCKET) is not configured';
  }
  return null;
}

// ─── Main Worker ─────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const startTime = Date.now();
    const requestId = crypto.randomUUID();
    const response = await handleRequest(request, env, requestId);
    const secured = addSecurityHeaders(response);
    secured.headers.set('Server-Timing', `total;dur=${Date.now() - startTime}`);
    secured.headers.set('X-Request-Id', requestId);
    return secured;
  },
};

async function handleRequest(request: Request, env: Env, requestId: string): Promise<Response> {
    const logger = createLogger(requestId);
    const url = new URL(request.url);

    logger.info('request.received', {
      method: request.method,
      pathname: url.pathname,
    });

    // Handle CORS preflight for API routes
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(request),
      });
    }

    // API Routes
    if (url.pathname.startsWith('/api/')) {
      // Validate JWT_SECRET and DB before processing API requests
      const apiEnvError = validateApiEnv(env);
      if (apiEnvError) {
        logger.error('env.invalid', { reason: apiEnvError });
        return new Response('Server misconfigured', { status: 500 });
      }

      await ensureTables(env.DB);

      try {
        // Initialize route map on first request (handlers are hoisted)
        if (!apiRoutesInitialized) initApiRoutes();

        const routeHandlers = API_ROUTES[url.pathname];
        if (routeHandlers) {
          const handler = routeHandlers[request.method];
          if (handler) {
            return await handler(request, env, logger);
          }
          // Include OPTIONS in Allow per RFC 9110 (CORS preflight is handled above)
          const allowed = ['OPTIONS', ...Object.keys(routeHandlers)].join(', ');
          return errorResponse(request, `Method ${request.method} not allowed`, 405, { Allow: allowed });
        }

        return errorResponse(request, 'Not found', 404);
      } catch (e: unknown) {
        logger.error('api.error', { pathname: url.pathname, error: e instanceof Error ? e.message : String(e) });
        return errorResponse(request, 'Internal server error', 500);
      }
    }

    // Validate R2 binding before serving data files
    const r2EnvError = validateR2Env(env);
    if (r2EnvError) {
      logger.error('env.invalid', { reason: r2EnvError });
      return new Response('Server misconfigured', { status: 500 });
    }

    // Handle index.json request - serve from R2
    if (url.pathname === '/index.json') {
      return serveR2File(env.DATA_BUCKET, 'index.json', request, {
        cacheControl: 'public, max-age=86400', // 1 day - may update with new articles
        contentType: 'application/json',
      }, logger);
    }

    // Handle article chunk requests - /articles/chunk-NNNNNN.json
    const chunkMatch = url.pathname.match(/^\/articles\/chunk-(\d{6})\.json$/);
    if (chunkMatch) {
      const chunkId = parseInt(chunkMatch[1], 10);
      // Validate chunk ID is in valid range (0-999, allowing room for growth)
      if (chunkId < 0 || chunkId > 999) {
        return new Response('Invalid chunk ID', { status: 400 });
      }
      const chunkKey = `articles/chunk-${chunkMatch[1]}.json`;
      return serveR2File(env.DATA_BUCKET, chunkKey, request, {
        cacheControl: 'public, max-age=604800, immutable', // 1 week, content rarely changes
        contentType: 'application/json',
      }, logger);
    }

    // Handle smoldata.json request - serve from R2
    if (url.pathname === '/smoldata.json') {
      return serveR2File(env.DATA_BUCKET, 'smoldata.json', request, {
        cacheControl: 'public, max-age=604800', // 1 week
        contentType: 'application/json',
      }, logger);
    }

    // All other requests are handled by Cloudflare's asset serving
    // (this code won't be reached for static assets when [assets] is configured)
    return new Response('Not Found', { status: 404 });
}
