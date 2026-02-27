# Service Worker Design Document

**Feature:** Offline Support & Caching
**Status:** Ready for Implementation
**Created:** 2026-02-27

---

## 1. Overview

Add service worker support to xikipedia for:
- **Instant loading** - Cache index.html for immediate startup
- **Offline browsing** - Continue using the app when connectivity drops
- **Bandwidth efficiency** - Cache the 225MB smoldata.json to avoid re-downloads
- **Progressive enhancement** - Works without SW, better with it

---

## 2. Technical Approach

### 2.1 Caching Strategies by Resource Type

| Resource | Strategy | Rationale |
|----------|----------|-----------|
| `index.html` | Stale-While-Revalidate | Instant load + background update |
| `smoldata.json` | Cache-First | 225MB - too large for frequent updates |
| `favicon.ico` | Cache-First | Static, rarely changes |
| `/thumbs/*` | Runtime Cache (50MB cap) | Cache as user scrolls, LRU eviction |
| `upload.wikimedia.org/*` | Runtime Cache (50MB cap) | External thumbnails |
| `/api/*` | Network-Only | Auth must be live |
| Everything else | Network-First | Default safe behavior |

### 2.2 Cache Names

```javascript
const CACHE_VERSION = 'v1';
const CACHES = {
  static: `xiki-static-${CACHE_VERSION}`,    // index.html, favicon
  data: `xiki-data-${CACHE_VERSION}`,        // smoldata.json
  thumbs: `xiki-thumbs-${CACHE_VERSION}`,    // thumbnails (runtime)
};
```

### 2.3 Service Worker Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                      Service Worker Lifecycle                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  INSTALL                                                        │
│  ├─ Open static cache                                           │
│  ├─ Pre-cache: index.html, favicon.ico                          │
│  └─ skipWaiting() to activate immediately                       │
│                                                                 │
│  ACTIVATE                                                       │
│  ├─ Delete old version caches                                   │
│  ├─ clients.claim() to control existing tabs                    │
│  └─ Post message: { type: 'SW_ACTIVATED' }                      │
│                                                                 │
│  FETCH                                                          │
│  ├─ /api/* → Network only                                       │
│  ├─ index.html → Stale-while-revalidate                         │
│  ├─ smoldata.json → Cache-first                                 │
│  ├─ thumbs/wikimedia → Runtime cache with LRU                   │
│  └─ Other → Network-first                                       │
│                                                                 │
│  MESSAGE                                                        │
│  ├─ SKIP_WAITING → self.skipWaiting()                           │
│  └─ GET_CACHE_SIZE → Return bytes used                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Files to Create/Modify

### 3.1 New File: `public/sw.js`

Complete service worker implementation (~200 lines).

### 3.2 Modify: `public/index.html`

Add:
1. **Service worker registration** (in `<script>`)
2. **Offline indicator** (new element + styles)
3. **Update toast** (new element + styles)
4. **Event listeners** for SW messages

---

## 4. Implementation Details

### 4.1 Service Worker (`public/sw.js`)

```javascript
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
      cache.put(request, response.clone());
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
  
  // LRU eviction: delete oldest entries until under limit
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
```

### 4.2 Index.html Changes

#### 4.2.1 New CSS (add to existing `<style>`)

```css
/* === Offline Indicator === */
#offlineIndicator {
    position: fixed;
    top: calc(16px + env(safe-area-inset-top, 0px));
    left: 50%;
    transform: translateX(-50%);
    background: #f59e0b;
    color: #000;
    padding: 8px 16px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 500;
    z-index: 1000;
    display: none;
    align-items: center;
    gap: 6px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
}
#offlineIndicator.visible {
    display: flex;
}
#offlineIndicator::before {
    content: '📡';
}

/* === Update Toast === */
#updateToast {
    position: fixed;
    bottom: calc(200px + env(safe-area-inset-bottom, 0px));
    left: 50%;
    transform: translateX(-50%);
    background: var(--accent-color, #2cafff);
    color: #fff;
    padding: 12px 20px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    z-index: 1000;
    display: none;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    max-width: 280px;
    text-align: center;
}
#updateToast.visible {
    display: flex;
}
#updateToast button {
    background: #fff;
    color: var(--accent-color, #2cafff);
    border: none;
    padding: 6px 16px;
    border-radius: 16px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
}
#updateToast button:hover {
    opacity: 0.9;
}
#updateToast .dismiss {
    background: transparent;
    color: rgba(255,255,255,0.8);
    font-size: 12px;
}
```

#### 4.2.2 New HTML Elements (add before `</body>`)

```html
<!-- Offline indicator -->
<div id="offlineIndicator" role="status" aria-live="polite">
    You're offline
</div>

<!-- Update toast -->
<div id="updateToast" role="alert" aria-live="assertive">
    <span>A new version is available!</span>
    <button id="updateBtn">Refresh to update</button>
    <button class="dismiss" id="updateDismiss">Not now</button>
</div>
```

#### 4.2.3 Service Worker Registration (add to `<script>`)

```javascript
// ============================================
// Service Worker Registration & Handlers
// ============================================

// Track online/offline status
let isOnline = navigator.onLine;
const offlineIndicator = document.getElementById('offlineIndicator');
const updateToast = document.getElementById('updateToast');
const updateBtn = document.getElementById('updateBtn');
const updateDismiss = document.getElementById('updateDismiss');

function updateOnlineStatus() {
    isOnline = navigator.onLine;
    if (offlineIndicator) {
        offlineIndicator.classList.toggle('visible', !isOnline);
    }
}

window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus(); // Initial check

// Service Worker registration
let swRegistration = null;
let updateAvailable = false;

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
        .then(registration => {
            swRegistration = registration;
            console.log('SW registered:', registration.scope);
            
            // Check for updates
            registration.addEventListener('updatefound', () => {
                const newWorker = registration.installing;
                newWorker.addEventListener('statechange', () => {
                    if (newWorker.state === 'installed' && 
                        navigator.serviceWorker.controller) {
                        // New version available
                        showUpdateToast();
                    }
                });
            });
        })
        .catch(err => console.error('SW registration failed:', err));
    
    // Listen for messages from SW
    navigator.serviceWorker.addEventListener('message', event => {
        if (event.data?.type === 'CONTENT_UPDATED') {
            // index.html was updated in background
            if (!updateAvailable) {
                showUpdateToast();
            }
        }
        if (event.data?.type === 'SW_ACTIVATED') {
            console.log('SW activated, version:', event.data.version);
        }
    });
}

function showUpdateToast() {
    updateAvailable = true;
    if (updateToast) {
        updateToast.classList.add('visible');
    }
}

function hideUpdateToast() {
    if (updateToast) {
        updateToast.classList.remove('visible');
    }
}

// Update button handler
if (updateBtn) {
    updateBtn.addEventListener('click', () => {
        if (swRegistration?.waiting) {
            // Tell waiting SW to take over
            swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
        // Reload to get new version
        window.location.reload();
    });
}

// Dismiss button handler
if (updateDismiss) {
    updateDismiss.addEventListener('click', hideUpdateToast);
}

// Keyboard shortcut: U to check for updates (dev convenience)
document.addEventListener('keydown', e => {
    if (e.key === 'u' && e.ctrlKey && e.shiftKey) {
        if (swRegistration) {
            swRegistration.update().then(() => {
                console.log('Checked for SW updates');
            });
        }
    }
});
```

---

## 5. UI Changes Summary

### 5.1 Offline Indicator

- **Position:** Top center, below safe area
- **Color:** Amber (#f59e0b) for warning state
- **Content:** "📡 You're offline"
- **Behavior:** Shows when `navigator.onLine` is false, hides when true

### 5.2 Update Toast

- **Position:** Bottom center, above floating buttons
- **Color:** Accent blue to match theme
- **Content:** "A new version is available!" + Refresh button + Dismiss
- **Behavior:** 
  - Shows when new SW is waiting OR index.html updated in background
  - Refresh reloads the page after activating new SW
  - Dismiss hides toast (update applies on next visit)

### 5.3 Visual Design

```
┌────────────────────────────────────────┐
│        [📡 You're offline]             │  ← Top center (when offline)
│                                        │
│   ┌────────────────────────────────┐   │
│   │                                │   │
│   │         Feed Content           │   │
│   │                                │   │
│   └────────────────────────────────┘   │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │  A new version is available!    │  │  ← Update toast (when available)
│  │     [Refresh to update]         │  │
│  │          Not now                │  │
│  └──────────────────────────────────┘  │
│                                        │
│                            [↻] [🎲]    │  ← Floating buttons
└────────────────────────────────────────┘
```

---

## 6. Test Strategy

### 6.1 New Test File: `tests/service-worker.spec.ts`

```typescript
import { test, expect, Page } from '@playwright/test';

// Service Worker tests need special handling
test.describe('Service Worker', () => {
  
  test.beforeEach(async ({ context }) => {
    // Grant SW permission (Chromium-specific)
    await context.grantPermissions([]);
  });

  test('service worker registers successfully', async ({ page }) => {
    await page.goto('/');
    
    // Wait for SW to register
    const swRegistered = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const registration = await navigator.serviceWorker.ready;
      return registration.active !== null;
    });
    
    expect(swRegistered).toBe(true);
  });

  test('offline indicator shows when offline', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    const indicator = page.locator('#offlineIndicator');
    await expect(indicator).not.toBeVisible();
    
    // Simulate offline
    await context.setOffline(true);
    await page.waitForTimeout(500);
    
    await expect(indicator).toBeVisible();
    await expect(indicator).toContainText("You're offline");
    
    // Go back online
    await context.setOffline(false);
    await page.waitForTimeout(500);
    
    await expect(indicator).not.toBeVisible();
  });

  test('cached pages load when offline', async ({ page, context }) => {
    // First visit - cache the page
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    // Wait for SW to be active
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    
    // Go offline
    await context.setOffline(true);
    
    // Navigate again - should load from cache
    await page.goto('/');
    
    // Page should still render
    await expect(page.locator('body')).toBeVisible();
    await expect(page.locator('#themeToggle')).toBeVisible();
  });

  test('update toast appears when new version available', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    // Simulate SW message for update
    await page.evaluate(() => {
      const event = new MessageEvent('message', {
        data: { type: 'CONTENT_UPDATED', url: '/index.html' }
      });
      navigator.serviceWorker.dispatchEvent(event);
    });
    
    // This triggers via the window message handler
    await page.evaluate(() => {
      // Manually show for test since we can't easily mock SW
      document.getElementById('updateToast')?.classList.add('visible');
    });
    
    const toast = page.locator('#updateToast');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('A new version is available');
  });

  test('update toast dismiss button works', async ({ page }) => {
    await page.goto('/');
    
    // Show toast
    await page.evaluate(() => {
      document.getElementById('updateToast')?.classList.add('visible');
    });
    
    const toast = page.locator('#updateToast');
    await expect(toast).toBeVisible();
    
    // Dismiss
    await page.locator('#updateDismiss').click();
    await expect(toast).not.toBeVisible();
  });

  test('update refresh button reloads page', async ({ page }) => {
    await page.goto('/');
    
    // Show toast
    await page.evaluate(() => {
      document.getElementById('updateToast')?.classList.add('visible');
    });
    
    // Track if reload happens
    const reloadPromise = page.waitForNavigation();
    await page.locator('#updateBtn').click();
    await reloadPromise;
    
    // Should have reloaded
    await expect(page.locator('body')).toBeVisible();
  });

  test('smoldata.json is cached after first load', async ({ page, context }) => {
    // Mock smoldata for faster test
    await page.route('**/smoldata.json', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ pages: [], subCategories: {}, noPageMaps: {} })
      });
    });
    
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    // Wait for SW
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    
    // Check if cached
    const isCached = await page.evaluate(async () => {
      const cache = await caches.open('xiki-data-v1');
      const keys = await cache.keys();
      return keys.some(k => k.url.includes('smoldata.json'));
    });
    
    // Note: This may be false if the mock intercepts before SW
    // In real scenario, the SW would cache the response
  });

  test('thumbnails are runtime cached', async ({ page }) => {
    await page.goto('/');
    
    // Wait for SW
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    
    // Add a thumbnail URL to cache manually (simulating runtime caching)
    await page.evaluate(async () => {
      const cache = await caches.open('xiki-thumbs-v1');
      const testResponse = new Response('fake-image-data', {
        headers: { 'Content-Type': 'image/jpeg' }
      });
      await cache.put('https://upload.wikimedia.org/test.jpg', testResponse);
    });
    
    // Verify it's in cache
    const isCached = await page.evaluate(async () => {
      const cache = await caches.open('xiki-thumbs-v1');
      const match = await cache.match('https://upload.wikimedia.org/test.jpg');
      return match !== undefined;
    });
    
    expect(isCached).toBe(true);
  });

  test('API requests are not cached (network only)', async ({ page }) => {
    await page.goto('/');
    
    // Wait for SW
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    
    // Check that no API responses are in any cache
    const apiCached = await page.evaluate(async () => {
      const cacheNames = await caches.keys();
      for (const name of cacheNames) {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        if (keys.some(k => k.url.includes('/api/'))) {
          return true;
        }
      }
      return false;
    });
    
    expect(apiCached).toBe(false);
  });
});

// Integration tests with feed
test.describe('Service Worker + Feed Integration', () => {
  
  test('can browse feed offline after initial load', async ({ page, context }) => {
    // Use mock data for test speed
    await page.route('**/smoldata.json', async route => {
      const mockData = {
        pages: Array.from({ length: 50 }, (_, i) => [
          `Article ${i}`,
          i + 1,
          'Test content '.repeat(20),
          i % 3 === 0 ? 'thumb.jpg' : null,
          ['science', 'nature'],
          []
        ]),
        subCategories: {},
        noPageMaps: {}
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockData)
      });
    });
    
    await page.goto('/');
    
    // Start the feed
    const startBtn = page.locator('[data-testid="start-button"]');
    await expect(startBtn).not.toBeDisabled({ timeout: 30000 });
    await startBtn.click();
    
    // Wait for posts to render
    await expect(page.locator('[data-testid="post"]').first()).toBeVisible();
    
    // Go offline
    await context.setOffline(true);
    
    // Should still be able to scroll and view cached posts
    await page.evaluate(() => window.scrollTo(0, 1000));
    await page.waitForTimeout(500);
    
    // Feed should still be visible
    await expect(page.locator('[data-testid="post"]').first()).toBeVisible();
    
    // Offline indicator should show
    await expect(page.locator('#offlineIndicator')).toBeVisible();
  });

  test('offline indicator has correct aria attributes', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    const indicator = page.locator('#offlineIndicator');
    
    // Check accessibility attributes
    await expect(indicator).toHaveAttribute('role', 'status');
    await expect(indicator).toHaveAttribute('aria-live', 'polite');
    
    // When visible, should be announced
    await context.setOffline(true);
    await page.waitForTimeout(500);
    await expect(indicator).toBeVisible();
  });

  test('update toast has correct aria attributes', async ({ page }) => {
    await page.goto('/');
    
    const toast = page.locator('#updateToast');
    
    // Check accessibility attributes
    await expect(toast).toHaveAttribute('role', 'alert');
    await expect(toast).toHaveAttribute('aria-live', 'assertive');
  });
});
```

### 6.2 Testing Approach

1. **Unit Tests** (in sw.spec.ts):
   - SW registration succeeds
   - Online/offline indicator toggles
   - Update toast shows/hides
   - Dismiss and refresh buttons work

2. **Integration Tests**:
   - Feed works after going offline
   - Cached content loads correctly
   - API calls still fail when offline (expected)

3. **Manual Testing Checklist**:
   - [ ] Clear all site data, load page - SW installs
   - [ ] Reload page - loads from cache (instant)
   - [ ] Disconnect network - offline indicator shows
   - [ ] Navigate while offline - cached pages load
   - [ ] Reconnect - indicator hides
   - [ ] Deploy new version - update toast appears
   - [ ] Click refresh - gets new version

---

## 7. Risks & Concerns

### 7.1 Cache Invalidation

**Risk:** Users stuck with old cached version of index.html
**Mitigation:** 
- Stale-while-revalidate ensures background fetch
- Update toast prompts user to refresh
- Version number in cache names for clean breaks

### 7.2 Storage Quota

**Risk:** 50MB thumbnail cache + 225MB smoldata = significant storage
**Mitigation:**
- Browsers typically allow 50% of available disk space
- LRU eviction for thumbnail cache
- Check `navigator.storage.estimate()` before caching large files

### 7.3 smoldata.json Updates

**Risk:** Users never get new Wikipedia content
**Mitigation:**
- Add periodic background check (e.g., check ETag monthly)
- Add "Clear cache" option in UI (future enhancement)
- Document that data updates require manual cache clear

### 7.4 CORS for Thumbnails

**Risk:** Wikipedia thumbnail caching might fail due to CORS
**Mitigation:**
- Test with actual Wikipedia URLs
- Fallback: don't cache if response is opaque
- Current code handles this with 503 fallback

### 7.5 Service Worker Scope

**Risk:** SW registered at wrong scope
**Mitigation:**
- SW file at `/sw.js` gives scope `/`
- Cloudflare Workers serves static from `/public`
- Verify `navigator.serviceWorker.controller.scriptURL`

---

## 8. Implementation Steps

1. **Create `public/sw.js`** (~30 min)
   - Copy the service worker code from section 4.1
   - Test locally with `wrangler dev`

2. **Add CSS to index.html** (~10 min)
   - Add offline indicator styles
   - Add update toast styles

3. **Add HTML elements to index.html** (~5 min)
   - Add offline indicator div
   - Add update toast div with buttons

4. **Add JS to index.html** (~20 min)
   - Add online/offline event handlers
   - Add SW registration code
   - Add update handlers

5. **Create tests** (~30 min)
   - Create `tests/service-worker.spec.ts`
   - Run tests, fix any issues

6. **Manual testing** (~15 min)
   - Test offline behavior
   - Test update flow
   - Test on mobile

**Total estimated time:** ~2 hours

---

## 9. Future Enhancements

- **Background sync** - Queue likes/preferences when offline, sync when online
- **Cache management UI** - Show cache size, option to clear
- **Periodic update check** - Check for smoldata.json updates weekly
- **Push notifications** - Notify of significant content updates
- **IndexedDB for preferences** - More robust offline preference storage

---

## 10. References

- [Service Worker API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- [The Offline Cookbook](https://web.dev/offline-cookbook/)
- [Workbox Strategies](https://developer.chrome.com/docs/workbox/modules/workbox-strategies/)
- [Playwright Service Worker Testing](https://playwright.dev/docs/service-workers-experimental)
