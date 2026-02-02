/**
 * Xikipedia Cloudflare Worker
 * 
 * Serves static assets and proxies the large data file from R2 storage.
 */

export interface Env {
  DATA_BUCKET: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // Handle smoldata.json request - serve from R2
    if (url.pathname === '/smoldata.json') {
      const object = await env.DATA_BUCKET.get('smoldata.json');
      
      if (!object) {
        return new Response('Data file not found', { status: 404 });
      }
      
      const headers = new Headers();
      headers.set('Content-Type', 'application/json');
      headers.set('Cache-Control', 'public, max-age=604800'); // Cache for 1 week
      headers.set('Access-Control-Allow-Origin', '*');
      
      // Handle range requests for streaming
      const range = request.headers.get('range');
      if (range) {
        const size = object.size;
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : size - 1;
        
        headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
        headers.set('Content-Length', String(end - start + 1));
        headers.set('Accept-Ranges', 'bytes');
        
        // Slice the body for range request
        const body = object.body;
        return new Response(body, {
          status: 206,
          headers,
        });
      }
      
      headers.set('Content-Length', String(object.size));
      return new Response(object.body, { headers });
    }
    
    // All other requests are handled by Cloudflare's asset serving
    // (this code won't be reached for static assets when [assets] is configured)
    return new Response('Not Found', { status: 404 });
  },
};
