// ─── R2 File Serving ─────────────────────────────────────────────────
// Extracted from index.ts for modularity.

import type { Logger } from './logger';

/**
 * Check if an ETag matches an If-None-Match header value.
 * Handles wildcard (*), comma-separated lists, and W/ weak validators per RFC 9110.
 */
export function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const trimmed = ifNoneMatch.trim();
  if (trimmed === '*') return true;

  // Strip W/ weak prefix for comparison (weak comparison per RFC 9110 §8.8.3.2)
  const stripWeak = (tag: string): string => tag.trim().replace(/^W\//, '');
  const normalizedEtag = stripWeak(etag);

  // Parse comma-separated list of ETags
  return trimmed.split(',').some((tag) => stripWeak(tag) === normalizedEtag);
}

/**
 * Serve a file from an R2 bucket with ETag, HEAD, and range request support.
 */
export async function serveR2File(
  bucket: R2Bucket,
  key: string,
  request: Request,
  options: { cacheControl: string; contentType: string },
  logger: Logger,
): Promise<Response> {
  const headers = new Headers();
  headers.set('Content-Type', options.contentType);
  headers.set('Cache-Control', options.cacheControl);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Accept-Ranges', 'bytes');

  const ifNoneMatch = request.headers.get('If-None-Match');
  const method = request.method.toUpperCase();

  // Efficiently handle HEAD requests using R2 metadata only (no body download)
  if (method === 'HEAD') {
    const head = await bucket.head(key);
    if (!head) {
      return new Response('File not found', { status: 404 });
    }

    const etag = head.httpEtag;
    if (ifNoneMatch && etag && etagMatches(ifNoneMatch, etag)) {
      logger.info('data.notModified', { key, etag, method: 'HEAD' });
      headers.set('ETag', etag);
      return new Response(null, { status: 304, headers });
    }

    headers.set('Content-Length', String(head.size));
    if (etag) headers.set('ETag', etag);
    if (head.uploaded) headers.set('Last-Modified', head.uploaded.toUTCString());

    logger.info('data.head', { key, size: head.size, etag });
    return new Response(null, { status: 200, headers });
  }

  // Handle range requests using R2's native range support
  const rangeHeader = request.headers.get('range');
  logger.info('data.serve', { key, ranged: !!rangeHeader });
  if (rangeHeader) {
    // First, get object metadata (HEAD) to know total size
    const head = await bucket.head(key);
    if (!head) {
      return new Response('File not found', { status: 404 });
    }

    // Check ETag for conditional request (after HEAD, before fetching body)
    const etag = head.httpEtag;
    if (ifNoneMatch && etag && etagMatches(ifNoneMatch, etag)) {
      logger.info('data.notModified', { key, etag });
      headers.set('ETag', etag);
      return new Response(null, { status: 304, headers });
    }

    const totalSize = head.size;
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

    // Validate range
    if (start < 0 || start >= totalSize || end >= totalSize || start > end) {
      headers.set('Content-Range', `bytes */${totalSize}`);
      return new Response('Range Not Satisfiable', { status: 416, headers });
    }

    // Fetch only the requested range from R2
    const object = await bucket.get(key, {
      range: { offset: start, length: end - start + 1 },
    });

    if (!object) {
      return new Response('File not found', { status: 404 });
    }

    headers.set('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    headers.set('Content-Length', String(end - start + 1));
    if (etag) headers.set('ETag', etag);

    logger.info('data.serve', { key, bytes: end - start + 1, range: true });
    return new Response(object.body, {
      status: 206,
      headers,
    });
  }

  // For non-range requests with If-None-Match, do a HEAD first to check ETag
  if (ifNoneMatch) {
    const head = await bucket.head(key);
    if (!head) {
      return new Response('File not found', { status: 404 });
    }

    const etag = head.httpEtag;
    if (etag && etagMatches(ifNoneMatch, etag)) {
      logger.info('data.notModified', { key, etag });
      headers.set('ETag', etag);
      return new Response(null, { status: 304, headers });
    }
  }

  // Full object request
  const object = await bucket.get(key);

  if (!object) {
    return new Response('File not found', { status: 404 });
  }

  if (object.httpEtag) headers.set('ETag', object.httpEtag);

  logger.info('data.serve', { key, bytes: object.size });
  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
}
