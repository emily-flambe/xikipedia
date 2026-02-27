# Design Document: Full Wikipedia Support (Chunked Architecture)

**Feature:** Support full English Wikipedia (~6.8M articles) via chunked index + on-demand fetch  
**Author:** XikiGuardian (Design Agent)  
**Created:** 2026-02-27  
**Status:** Draft  
**Scope Reference:** `memory/scope-full-wikipedia.md`

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Data Schema](#1-data-schema)
3. [Chunk Strategy](#2-chunk-strategy)
4. [Client Loading Flow](#3-client-loading-flow)
5. [Caching Architecture](#4-caching-architecture)
6. [WebWorker Integration](#5-webworker-integration)
7. [R2 Route Design](#6-r2-route-design)
8. [Migration Path](#7-migration-path)
9. [Test Strategy](#8-test-strategy)
10. [Implementation Phases](#implementation-phases)
11. [Risk Mitigation](#risk-mitigation)

---

## Executive Summary

This design enables xikipedia to scale from ~270K Simple Wikipedia articles to ~6.8M full English Wikipedia articles by:

1. **Separating index from content** - Lightweight index (~80-100MB compressed) loads at startup; article text fetched on-demand
2. **Chunking articles by ID range** - ~680 chunk files, each ~10K articles (~15MB uncompressed)
3. **Client-side LRU caching** - Keep ~10 chunks in memory, evict oldest on pressure
4. **Progressive loading UX** - Skeleton placeholders while chunks fetch
5. **Backward compatibility** - Support both `smoldata.json` (Simple) and new chunked format

---

## 1. Data Schema

### 1.1 Index File (`index.json`)

The index contains everything needed for the scoring algorithm **except article text**:

```typescript
interface IndexFile {
  // Version for cache invalidation
  version: string;  // "2.0.0"
  
  // Total article count for validation
  articleCount: number;
  
  // Chunk metadata
  chunkSize: number;  // 10000
  chunkCount: number; // 680
  
  // Article index: lightweight array for fast iteration
  // Format: [title, pageId, chunkId, thumbHash, categories]
  // Using array for compactness (~40% smaller than objects)
  pages: ArticleIndexEntry[];
  
  // Category hierarchy (unchanged from current)
  subCategories: Record<string, string[]>;
  
  // Reverse lookup: pageId → title (for link resolution)
  noPageMaps: Record<string, string>;
}

// ArticleIndexEntry as tuple for compactness:
// [0] title: string
// [1] pageId: number
// [2] chunkId: number (0-679)
// [3] thumbHash: string | null (Commons filename hash, first 8 chars)
// [4] categories: string[]
type ArticleIndexEntry = [string, number, number, string | null, string[]];
```

**Size Estimates:**
- ~6.8M articles × ~80 bytes/entry ≈ 544MB uncompressed
- Brotli level 11: ~80-100MB compressed
- Gzip fallback: ~120-150MB compressed

### 1.2 Chunk Files (`articles/chunk-NNNNNN.json`)

Each chunk contains article text for ~10K articles:

```typescript
interface ChunkFile {
  // Chunk metadata
  chunkId: number;
  articleCount: number;
  
  // Articles keyed by pageId (string for JSON key compatibility)
  articles: Record<string, ArticleContent>;
}

interface ArticleContent {
  // Article text (intro/excerpt, ~500-1000 chars)
  text: string;
  
  // Full thumbnail filename for Commons URL reconstruction
  thumb?: string;
  
  // Optional: first paragraph for expanded view (future feature)
  // fullIntro?: string;
}
```

**Size Estimates per chunk:**
- ~10K articles × ~1.5KB avg text = ~15MB uncompressed
- Brotli level 6: ~3-4MB compressed
- Total: ~680 chunks × ~4MB = ~2.7GB storage

### 1.3 Chunk File Naming Convention

```
articles/chunk-000000.json  # pageIds 0-9999
articles/chunk-000001.json  # pageIds 10000-19999
articles/chunk-000002.json  # pageIds 20000-29999
...
articles/chunk-000679.json  # pageIds 6790000-6799999
```

Formula: `chunkId = Math.floor(pageId / 10000)`

---

## 2. Chunk Strategy

### 2.1 Partitioning by Page ID Range

**Why ID-based rather than category/geography:**

| Approach | Pros | Cons |
|----------|------|------|
| **ID Range** ✓ | Deterministic, O(1) lookup, no mapping needed | Articles clustered by creation date, not topic |
| Category | Topic locality | Articles in multiple categories, complex mapping |
| Geography | Geo-queries efficient | Most articles aren't geographic |
| Alphabetic | Good for search | Uneven distribution (many articles start with "The") |

**Decision:** ID range is simplest and most predictable. Topic affinity would require a separate mapping layer that adds complexity without significant UX benefit (users don't scroll through 10K articles).

### 2.2 Chunk Size Optimization

**Target: ~10,000 articles per chunk**

| Chunk Size | Count | Uncompressed | Compressed | Fetch Time (4G) |
|------------|-------|--------------|------------|-----------------|
| 1,000 | 6,800 | ~1.5MB | ~400KB | ~0.3s |
| 5,000 | 1,360 | ~7.5MB | ~2MB | ~1.5s |
| **10,000** | 680 | ~15MB | ~4MB | ~3s |
| 20,000 | 340 | ~30MB | ~8MB | ~6s |
| 50,000 | 136 | ~75MB | ~20MB | ~15s |

**Decision:** 10K articles balances:
- Reasonable fetch time (~3s on 4G)
- Good cache efficiency (1 chunk serves many related pageIds)
- Manageable file count (~680 files vs 6,800 for 1K)

### 2.3 PageId to ChunkId Mapping

```javascript
// O(1) constant-time lookup
function getChunkId(pageId) {
  return Math.floor(pageId / CHUNK_SIZE);
}

function getChunkUrl(chunkId) {
  return `/articles/chunk-${String(chunkId).padStart(6, '0')}.json`;
}
```

---

## 3. Client Loading Flow

### 3.1 Startup Sequence

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. INITIAL LOAD (~30s on 4G)                                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   [Page Load]                                                       │
│        │                                                            │
│        ▼                                                            │
│   [Check localStorage for cached index version]                     │
│        │                                                            │
│        ├─────────────────────────────────────────────────────────── │
│        │ Cache miss or stale                                        │
│        ▼                                                            │
│   [Fetch /index.json with progress UI]  ◄───── ~80-100MB            │
│        │                                                            │
│        ▼                                                            │
│   [Parse JSON, build pagesArr with allCategories]                   │
│        │                                                            │
│        ▼                                                            │
│   [Initialize WebWorker with index data]                            │
│        │                                                            │
│        ▼                                                            │
│   [Show start screen, enable "Continue" button]                     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ 2. POST RENDER FLOW (per article)                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   [Algorithm selects next article from index]                       │
│        │                                                            │
│        ▼                                                            │
│   [Create post DOM with skeleton placeholder]                       │
│        │                                                            │
│        ├─── Has text in cache? ───┐                                 │
│        │          NO              │ YES                             │
│        ▼                          ▼                                 │
│   [Add to chunk fetch queue]    [Render text immediately]           │
│        │                                                            │
│        ▼                                                            │
│   [Batch fetch if queue.length >= 3 OR timeout 100ms]               │
│        │                                                            │
│        ▼                                                            │
│   [Fetch chunk(s) from R2/cache]                                    │
│        │                                                            │
│        ▼                                                            │
│   [Store in LRU cache, update DOM]                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 Index Load Implementation

```javascript
// In main() after showing start screen:
async function loadIndex() {
  const loadingProgress = document.getElementById('loadingProgress');
  const loadingDetails = document.getElementById('loadingDetails');
  
  // Check for format preference or detection
  const useChunked = localStorage.getItem('xiki_data_format') !== 'simple';
  
  if (useChunked) {
    startBtn.innerText = "Loading index... (downloading ~80MB)";
    
    const indexData = await getFileWithProgress("/index.json");
    
    // Store metadata for chunk loading
    window.chunkSize = indexData.chunkSize;
    window.chunkCount = indexData.chunkCount;
    window.indexVersion = indexData.version;
    
    // Process pages (same as current, but no text field)
    const subCategories = indexData.subCategories;
    noPageMaps = indexData.noPageMaps;
    
    for (const entry of indexData.pages) {
      const tempPage = {
        title: entry[0],
        id: entry[1],
        chunkId: entry[2],
        thumbHash: entry[3],
        categories: entry[4],
        text: null,  // Will be loaded on-demand
        textLoading: false,
        textError: false
      };
      
      tempPage.allCategories = new Set(
        recursiveCategories(subCategories, [...tempPage.categories], 0)
      );
      tempPage.allCategories.add(`p:${tempPage.id}`);
      pagesArr.push(tempPage);
    }
  } else {
    // Fallback to current Simple Wikipedia format
    await loadSimpleWikipediaData();
  }
}
```

### 3.3 Post Render with Lazy Text Loading

```javascript
async function createNextPost(specificPost = null) {
  let nextPost = specificPost || await getNextPostAsync();
  
  const postDiv = document.createElement("article");
  const postP = document.createElement("p");
  
  // ... existing setup code ...
  
  // Text handling for chunked format
  if (nextPost.text) {
    // Text already loaded (from cache or simple format)
    postP.innerText = nextPost.text;
  } else if (nextPost.chunkId !== undefined) {
    // Chunked format: show skeleton, queue fetch
    postP.classList.add("skeleton");
    postP.setAttribute("aria-busy", "true");
    postP.innerText = ""; // Skeleton CSS handles appearance
    
    // Queue chunk fetch
    queueChunkFetch(nextPost.id, nextPost.chunkId, (text) => {
      postP.classList.remove("skeleton");
      postP.removeAttribute("aria-busy");
      postP.innerText = text || "[Article text unavailable]";
    });
  }
  
  // ... rest of post creation ...
}
```

---

## 4. Caching Architecture

### 4.1 LRU Cache Implementation

```javascript
class ChunkCache {
  constructor(maxChunks = 10) {
    this.maxChunks = maxChunks;
    this.cache = new Map(); // chunkId → ChunkData
    this.accessOrder = [];  // LRU tracking: most recent at end
  }
  
  get(chunkId) {
    const data = this.cache.get(chunkId);
    if (data) {
      // Move to end (most recently used)
      this.accessOrder = this.accessOrder.filter(id => id !== chunkId);
      this.accessOrder.push(chunkId);
    }
    return data;
  }
  
  set(chunkId, data) {
    // Evict if at capacity
    while (this.cache.size >= this.maxChunks && this.accessOrder.length > 0) {
      const evictId = this.accessOrder.shift();
      this.cache.delete(evictId);
      console.log(`ChunkCache: evicted chunk ${evictId}`);
    }
    
    this.cache.set(chunkId, data);
    this.accessOrder.push(chunkId);
  }
  
  has(chunkId) {
    return this.cache.has(chunkId);
  }
  
  getArticleText(pageId, chunkId) {
    const chunk = this.get(chunkId);
    return chunk?.articles?.[String(pageId)]?.text;
  }
  
  // Memory pressure callback (called by worker or main thread)
  reduceSize(targetChunks = 5) {
    while (this.cache.size > targetChunks && this.accessOrder.length > 0) {
      const evictId = this.accessOrder.shift();
      this.cache.delete(evictId);
    }
  }
  
  // Stats for debugging
  getStats() {
    return {
      chunksLoaded: this.cache.size,
      maxChunks: this.maxChunks,
      totalArticlesCached: Array.from(this.cache.values())
        .reduce((sum, chunk) => sum + Object.keys(chunk.articles).length, 0)
    };
  }
}

// Global instance
const chunkCache = new ChunkCache(10);
```

### 4.2 Memory Budget

| Component | Memory Estimate | Notes |
|-----------|-----------------|-------|
| Index (pagesArr) | ~300MB | 6.8M entries with Sets |
| WebWorker copy | ~300MB | Duplicated for algorithm |
| Chunk cache (10×15MB) | ~150MB | 10 chunks at 15MB each |
| DOM/UI | ~50MB | Posts, images, etc. |
| **Total** | **~800MB** | Within 1GB budget |

### 4.3 Prefetch Strategy

```javascript
class ChunkPrefetcher {
  constructor(cache, maxConcurrent = 2) {
    this.cache = cache;
    this.maxConcurrent = maxConcurrent;
    this.pending = new Set();
    this.queue = [];
  }
  
  // Predict likely chunks based on current post's categories
  predictChunks(currentPost) {
    // Find articles with overlapping categories (already scored by algorithm)
    // Get their chunkIds, prioritize uncached ones
    const candidateChunks = new Set();
    
    // Worker's prefetch queue already has upcoming posts
    // Get their chunkIds
    if (algorithmWorker?.prefetchQueue) {
      algorithmWorker.prefetchQueue.forEach(post => {
        if (!this.cache.has(post.chunkId)) {
          candidateChunks.add(post.chunkId);
        }
      });
    }
    
    return Array.from(candidateChunks).slice(0, 3);
  }
  
  // Called after user engages with a post (like/more/less)
  async prefetchRelated(currentPost) {
    const chunks = this.predictChunks(currentPost);
    
    for (const chunkId of chunks) {
      if (!this.cache.has(chunkId) && !this.pending.has(chunkId)) {
        this.queue.push(chunkId);
      }
    }
    
    this.processQueue();
  }
  
  async processQueue() {
    while (this.queue.length > 0 && this.pending.size < this.maxConcurrent) {
      const chunkId = this.queue.shift();
      if (this.cache.has(chunkId) || this.pending.has(chunkId)) continue;
      
      this.pending.add(chunkId);
      
      fetchChunk(chunkId)
        .then(data => {
          this.cache.set(chunkId, data);
        })
        .catch(err => console.warn(`Prefetch failed for chunk ${chunkId}:`, err))
        .finally(() => {
          this.pending.delete(chunkId);
          this.processQueue();
        });
    }
  }
}
```

---

## 5. WebWorker Integration

### 5.1 Updated Worker Data Model

The worker doesn't need article text for scoring - it only needs the index data:

```javascript
// algorithm-worker.js changes

// State (no text field needed for scoring)
let pagesArr = [];  // [{id, title, chunkId, thumbHash, allCategories}, ...]

// INIT message payload (smaller without text)
case 'INIT':
  pagesArr = payload.pagesArr;  // No text field
  // ... rest of init unchanged ...
  break;
```

### 5.2 Chunk Coordination Protocol

```javascript
// Main thread ↔ Worker communication for chunks

// Worker notifies main thread about upcoming posts' chunks
case 'POST_READY':
  self.postMessage({
    type: 'POST_READY',
    requestId,
    payload: {
      post: serializePost(post),
      prefetchAvailable: prefetchQueue.length,
      // NEW: include upcoming chunk IDs for prefetch
      upcomingChunks: prefetchQueue.slice(0, 3).map(p => p.chunkId)
    }
  });
  break;

// Main thread requests chunk prefetch hints
case 'GET_PREFETCH_HINTS':
  const hints = prefetchQueue
    .slice(0, 5)
    .map(p => p.chunkId)
    .filter((id, i, arr) => arr.indexOf(id) === i);  // Dedupe
  
  self.postMessage({
    type: 'PREFETCH_HINTS',
    payload: { chunkIds: hints }
  });
  break;
```

### 5.3 Post Selection Without Text

The scoring algorithm doesn't use `text` - it only uses:
- `allCategories` (for category scoring)
- `thumb` (bonus for having image)
- `seen` counter (penalty for already viewed)

Therefore, the worker can operate entirely from the index without chunk data.

---

## 6. R2 Route Design

### 6.1 URL Structure

```
/index.json                    # Lightweight index
/articles/chunk-000000.json    # Chunk files
/articles/chunk-000001.json
...
/articles/chunk-000679.json
/smoldata.json                 # Legacy Simple Wikipedia (keep)
```

### 6.2 Worker Route Handler

```typescript
// src/index.ts additions

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // ... existing routes ...
    
    // Handle index.json request
    if (url.pathname === '/index.json') {
      return serveR2File(env, 'index.json', request, {
        cacheControl: 'public, max-age=86400',  // 1 day
        contentType: 'application/json'
      });
    }
    
    // Handle chunk requests: /articles/chunk-NNNNNN.json
    const chunkMatch = url.pathname.match(/^\/articles\/chunk-(\d{6})\.json$/);
    if (chunkMatch) {
      const chunkId = parseInt(chunkMatch[1], 10);
      
      // Validate chunk ID
      if (chunkId < 0 || chunkId > 679) {
        return new Response('Invalid chunk ID', { status: 404 });
      }
      
      return serveR2File(env, `articles/chunk-${chunkMatch[1]}.json`, request, {
        cacheControl: 'public, max-age=604800, immutable',  // 1 week, immutable
        contentType: 'application/json'
      });
    }
    
    // ... rest of routing ...
  }
};

// Helper function for R2 serving with caching
async function serveR2File(
  env: Env, 
  key: string, 
  request: Request,
  options: { cacheControl: string; contentType: string }
): Promise<Response> {
  const object = await env.DATA_BUCKET.get(key);
  
  if (!object) {
    return new Response('Not found', { status: 404 });
  }
  
  const headers = new Headers();
  headers.set('Content-Type', options.contentType);
  headers.set('Cache-Control', options.cacheControl);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Vary', 'Accept-Encoding');
  
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
    
    return new Response(object.body, {
      status: 206,
      headers
    });
  }
  
  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
}
```

### 6.3 Caching Headers Strategy

| File | Cache-Control | Rationale |
|------|---------------|-----------|
| `index.json` | `max-age=86400` (1 day) | May update with new articles |
| `chunk-*.json` | `max-age=604800, immutable` (1 week) | Content rarely changes |
| `smoldata.json` | `max-age=604800` (1 week) | Legacy, rarely updates |

---

## 7. Migration Path

### 7.1 Feature Flag Approach

```javascript
// Detect data format and feature flag
function detectDataFormat() {
  // Priority:
  // 1. URL parameter for testing: ?format=chunked or ?format=simple
  // 2. localStorage preference
  // 3. Default based on deployment
  
  const urlParams = new URLSearchParams(window.location.search);
  const urlFormat = urlParams.get('format');
  if (urlFormat === 'chunked' || urlFormat === 'simple') {
    return urlFormat;
  }
  
  const storedFormat = localStorage.getItem('xiki_data_format');
  if (storedFormat) {
    return storedFormat;
  }
  
  // Default: chunked for new users (once fully deployed)
  // During migration: default to 'simple'
  return 'simple';
}
```

### 7.2 Parallel Format Support

```javascript
async function loadWikipediaData() {
  const format = detectDataFormat();
  
  if (format === 'chunked') {
    return loadChunkedFormat();
  } else {
    return loadSimpleFormat();  // Current smoldata.json
  }
}

async function loadSimpleFormat() {
  // Existing code path (unchanged)
  const smoldata = await getFileWithProgress("smoldata.json");
  // ... process as today ...
}

async function loadChunkedFormat() {
  // New code path
  const indexData = await getFileWithProgress("index.json");
  // ... process index, defer text loading ...
}
```

### 7.3 Migration Timeline

| Phase | Duration | Actions |
|-------|----------|---------|
| **1. Build** | 2 weeks | Generate chunked data, update worker code |
| **2. Test** | 1 week | Deploy with `?format=chunked` flag, test internally |
| **3. Canary** | 1 week | Enable for 10% of new users via localStorage |
| **4. Rollout** | 1 week | Increase to 50%, then 100% |
| **5. Cleanup** | After stable | Remove `smoldata.json` from R2 (keep code path for local dev) |

---

## 8. Test Strategy

### 8.1 Mock Data Structure

Create `public/test-data/` with minimal mock files:

```javascript
// test-data/index.json
{
  "version": "2.0.0-test",
  "articleCount": 30,
  "chunkSize": 10,
  "chunkCount": 3,
  "pages": [
    ["Test Article 1", 1, 0, "abc12345", ["science", "technology"]],
    ["Test Article 2", 2, 0, null, ["history"]],
    // ... 28 more entries across 3 chunks ...
  ],
  "subCategories": {
    "science": ["physics", "chemistry"],
    "technology": ["computing", "engineering"]
  },
  "noPageMaps": {
    "1": "test article 1",
    "2": "test article 2"
  }
}

// test-data/articles/chunk-000000.json
{
  "chunkId": 0,
  "articleCount": 10,
  "articles": {
    "1": { "text": "This is test article 1 about science and technology.", "thumb": "Test1.jpg" },
    "2": { "text": "This is test article 2 about history." }
    // ...
  }
}
```

### 8.2 Playwright Test Cases

```javascript
// tests/chunked-loading.spec.ts

import { test, expect } from '@playwright/test';

test.describe('Chunked Data Loading', () => {
  
  test.beforeEach(async ({ page }) => {
    // Use mock data
    await page.route('/index.json', async route => {
      const mockIndex = await fs.readFile('test-data/index.json');
      await route.fulfill({ body: mockIndex });
    });
    
    await page.route('/articles/chunk-*.json', async route => {
      const url = new URL(route.request().url());
      const filename = url.pathname.split('/').pop();
      const mockChunk = await fs.readFile(`test-data/articles/${filename}`);
      await route.fulfill({ body: mockChunk });
    });
  });
  
  test('loads index and shows skeleton for posts', async ({ page }) => {
    await page.goto('/?format=chunked');
    
    // Wait for start screen
    await expect(page.locator('#startBtn')).toBeEnabled();
    
    // Start feed
    await page.click('#startBtn');
    
    // First post should appear with skeleton while chunk loads
    const firstPost = page.locator('.post').first();
    await expect(firstPost).toBeVisible();
    
    // Should show skeleton initially
    await expect(firstPost.locator('p.skeleton')).toBeVisible();
    
    // After chunk loads, skeleton should disappear
    await expect(firstPost.locator('p.skeleton')).not.toBeVisible({ timeout: 5000 });
    await expect(firstPost.locator('p')).toContainText(/test article/i);
  });
  
  test('caches chunks and reuses them', async ({ page }) => {
    let chunkFetchCount = 0;
    
    await page.route('/articles/chunk-000000.json', async route => {
      chunkFetchCount++;
      const mockChunk = await fs.readFile('test-data/articles/chunk-000000.json');
      await route.fulfill({ body: mockChunk });
    });
    
    await page.goto('/?format=chunked');
    await page.click('#startBtn');
    
    // Scroll through several posts in same chunk
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('j');
      await page.waitForTimeout(100);
    }
    
    // Chunk should only be fetched once
    expect(chunkFetchCount).toBe(1);
  });
  
  test('handles chunk fetch failure gracefully', async ({ page }) => {
    await page.route('/articles/chunk-000001.json', route => {
      route.fulfill({ status: 500 });
    });
    
    await page.goto('/?format=chunked');
    await page.click('#startBtn');
    
    // Navigate to a post in the failing chunk
    // ... setup to hit chunk 1 ...
    
    // Should show error state, not crash
    const errorPost = page.locator('.post p:has-text("unavailable")');
    await expect(errorPost).toBeVisible({ timeout: 10000 });
  });
  
  test('LRU evicts old chunks under memory pressure', async ({ page }) => {
    await page.goto('/?format=chunked');
    await page.click('#startBtn');
    
    // Load more chunks than cache limit (10)
    // This would require mocking 15+ chunks and navigating through them
    
    const cacheStats = await page.evaluate(() => window.chunkCache?.getStats());
    expect(cacheStats.chunksLoaded).toBeLessThanOrEqual(10);
  });
});
```

### 8.3 Unit Tests for Cache Logic

```javascript
// tests/unit/chunk-cache.test.js

import { ChunkCache } from '../public/chunk-cache.js';

describe('ChunkCache', () => {
  test('evicts LRU chunk when at capacity', () => {
    const cache = new ChunkCache(3);
    
    cache.set(0, { articles: { '1': { text: 'a' }}});
    cache.set(1, { articles: { '2': { text: 'b' }}});
    cache.set(2, { articles: { '3': { text: 'c' }}});
    
    // Access chunk 0 to make it recently used
    cache.get(0);
    
    // Add chunk 3, should evict chunk 1 (LRU)
    cache.set(3, { articles: { '4': { text: 'd' }}});
    
    expect(cache.has(0)).toBe(true);  // Recently accessed
    expect(cache.has(1)).toBe(false); // Evicted
    expect(cache.has(2)).toBe(true);
    expect(cache.has(3)).toBe(true);
  });
  
  test('getArticleText returns correct text', () => {
    const cache = new ChunkCache(10);
    cache.set(5, { 
      articles: { 
        '12345': { text: 'Hello world' },
        '12346': { text: 'Goodbye' }
      }
    });
    
    expect(cache.getArticleText(12345, 5)).toBe('Hello world');
    expect(cache.getArticleText(12346, 5)).toBe('Goodbye');
    expect(cache.getArticleText(99999, 5)).toBeUndefined();
  });
});
```

---

## Implementation Phases

### Phase 1: Data Generation (4h)

1. Modify `scripts/generate-data.mjs` to:
   - Download English Wikipedia dumps instead of Simple
   - Generate `index.json` with new schema
   - Generate chunk files by ID range
   - Compress with Brotli level 11 for index, level 6 for chunks

2. Upload to R2 bucket

### Phase 2: Worker Routes (2h)

1. Add R2 routes for `/index.json` and `/articles/chunk-*.json`
2. Add appropriate caching headers
3. Test with curl/browser

### Phase 3: Client Loader (4h)

1. Add `ChunkCache` class
2. Add `ChunkFetcher` with batching
3. Modify `loadWikipediaData()` to handle both formats
4. Add skeleton CSS and loading states

### Phase 4: Post Rendering (3h)

1. Update `createNextPost()` to handle lazy text loading
2. Add chunk queue and batch fetching
3. Handle errors gracefully

### Phase 5: WebWorker Updates (2h)

1. Update worker init to handle text-less data
2. Add prefetch hint messages
3. Integrate prefetcher with worker's upcoming posts queue

### Phase 6: Polish & Test (3h)

1. Add loading skeleton CSS
2. Implement Service Worker chunk caching
3. Run full Playwright test suite
4. Performance testing on 4G throttling

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Index too large (>100MB) | Strip categories to top 5, use numeric IDs, more aggressive Brotli |
| Chunk fetch latency | Prefetch aggressively, show engaging skeleton UI |
| Memory exhaustion | Strict LRU eviction, reduce cache to 5 chunks if pressure detected |
| Wikipedia dump processing | Document process, make resumable, cache intermediate files |
| Browser compatibility | Test IndexedDB fallback for chunk storage in Safari |

---

## Appendix: Skeleton CSS

```css
/* Skeleton loading animation for post text */
.post p.skeleton {
  background: linear-gradient(
    90deg,
    var(--bg-tertiary) 25%,
    var(--bg-secondary) 50%,
    var(--bg-tertiary) 75%
  );
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s infinite;
  border-radius: 4px;
  min-height: 4em;
  color: transparent;
}

.post p.skeleton::before {
  content: "Loading article content...";
  visibility: hidden;
}

@keyframes skeleton-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* Reduced motion preference */
@media (prefers-reduced-motion: reduce) {
  .post p.skeleton {
    animation: none;
    background: var(--bg-tertiary);
  }
}
```

---

*Last updated: 2026-02-27 08:50 MST*
