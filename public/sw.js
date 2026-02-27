// ============================================
// Xikipedia Service Worker
// Provides offline support and caching
// ============================================

const CACHE_VERSION = 'v1';
const STATIC_CACHE = `xiki-static-${CACHE_VERSION}`;
const DATA_CACHE = `xiki-data-${CACHE_VERSION}`;
const THUMBS_CACHE = `xiki-thumbs-${CACHE_VERSION}`;
const THUMBS_MAX_SIZE = 50 * 1024 * 1024; // 50MB

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/favicon.ico',
];

// ============ INSTALL ============
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ============ ACTIVATE ============
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith('xiki-') && 
                        !key.endsWith(CACHE_VERSION))
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
      .then(() => notifyClients({ type: 'SW_ACTIVATED', version: CACHE_VERSION }))
  );
});

// ============ FETCH ============
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Network-only for API
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }
  
  // Stale-while-revalidate for index.html
  if (url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(staleWhileRevalidate(event.request, STATIC_CACHE));
    return;
  }
  
  // Cache-first for smoldata.json
  if (url.pathname === '/smoldata.json') {
    event.respondWith(cacheFirst(event.request, DATA_CACHE));
    return;
  }
  
  // Runtime cache for thumbnails
  if (url.pathname.startsWith('/thumbs/') || 
      url.hostname === 'upload.wikimedia.org') {
    event.respondWith(runtimeCache(event.request, THUMBS_CACHE));
    return;
  }
  
  // Cache-first for static assets
  if (url.pathname === '/favicon.ico') {
    event.respondWith(cacheFirst(event.request, STATIC_CACHE));
    return;
  }
  
  // Network-first for everything else
  event.respondWith(networkFirst(event.request, STATIC_CACHE));
});

// ============ MESSAGE ============
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'GET_CACHE_SIZE') {
    if (!event.ports?.[0]) {
      console.warn('GET_CACHE_SIZE: No MessagePort provided');
      return;
    }
    getCacheSize().then(size => {
      event.ports[0].postMessage({ type: 'CACHE_SIZE', size });
    });
  }
});

// ============ STRATEGIES ============

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request);
  
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) {
      cache.put(request, response.clone()).catch(err => {
        // Handle quota errors gracefully - cache is full but response still works
        console.warn('Cache put failed (quota?):', err.message);
      });
      // Notify about update (for index.html)
      notifyClients({ 
        type: 'CONTENT_UPDATED', 
        url: request.url 
      });
    }
    return response;
  }).catch(() => cachedResponse);
  
  return cachedResponse || fetchPromise;
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request);
  
  if (cachedResponse) {
    return cachedResponse;
  }
  
  const response = await fetch(request);
  if (response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }
    throw error;
  }
}

async function runtimeCache(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request);
  
  if (cachedResponse) {
    return cachedResponse;
  }
  
  try {
    const response = await fetch(request);
    if (response.ok) {
      // Check cache size before adding
      await enforceCacheLimit(cache, THUMBS_MAX_SIZE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    // Return placeholder for failed image loads
    return new Response('', { status: 503 });
  }
}

// ============ HELPERS ============

async function notifyClients(message) {
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(client => client.postMessage(message));
}

async function enforceCacheLimit(cache, maxSize) {
  const keys = await cache.keys();
  let totalSize = 0;
  const entries = [];
  
  for (const request of keys) {
    const response = await cache.match(request);
    if (response) {
      const blob = await response.clone().blob();
      entries.push({ request, size: blob.size });
      totalSize += blob.size;
    }
  }
  
  // FIFO eviction: delete entries in cache.keys() order until under limit
  // Note: This is not true LRU - cache.keys() order is insertion order, not access order
  while (totalSize > maxSize && entries.length > 0) {
    const oldest = entries.shift();
    await cache.delete(oldest.request);
    totalSize -= oldest.size;
  }
}

async function getCacheSize() {
  const cacheNames = [STATIC_CACHE, DATA_CACHE, THUMBS_CACHE];
  let total = 0;
  
  for (const name of cacheNames) {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    for (const request of keys) {
      const response = await cache.match(request);
      if (response) {
        const blob = await response.clone().blob();
        total += blob.size;
      }
    }
  }
  
  return total;
}
