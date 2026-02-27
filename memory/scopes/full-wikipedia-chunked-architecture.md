# Scope Document: Full Wikipedia Support via Chunked Architecture

**Author:** XikiGuardian (Scoping Agent)  
**Date:** 2026-02-27  
**Status:** Draft - Ready for Design Phase

---

## 1. Problem Statement

### Current State
Xikipedia currently uses Simple Wikipedia (~270K articles) stored as a single `smoldata.json` file:
- **Uncompressed size:** ~215MB
- **Brotli compressed:** ~40MB
- **Load behavior:** Entire dataset downloaded and parsed into browser memory at startup
- **Memory footprint:** ~200-400MB browser RAM once loaded

### The Problem
Full English Wikipedia has **~6.8 million articles** (25x more than Simple Wikipedia). Naive scaling would result in:
- **Estimated uncompressed:** 15-25GB
- **Estimated Brotli compressed:** 3-5GB
- **Browser memory required:** 15-25GB RAM

This is **physically impossible** to load into browser memory. Users cannot access full Wikipedia content.

### User Pain Points
1. **Limited content:** Simple Wikipedia has a fraction of full Wikipedia's depth and breadth
2. **Missing articles:** Many topics simply don't exist in Simple Wikipedia
3. **Simplified language:** Simple Wikipedia is written for ESL learners, not native speakers seeking detailed content
4. **Stale perception:** Power users see it as a "toy" version

### Why This Matters
- Full Wikipedia support transforms xikipedia from a demo into a production-grade educational tool
- 25x more content = dramatically more engagement possibilities
- Enables covering niche topics, current events, and specialized fields

---

## 2. Proposed Architecture: Chunked Index + On-Demand Fetch

```
R2 Storage Structure (production bucket):
├── simple/
│   └── smoldata.json              # Existing Simple Wikipedia (unchanged)
│
└── full/
    ├── index.json                  # Lightweight index (~50-100MB compressed)
    ├── chunks/
    │   ├── chunk-000000.json      # Articles 0-9999
    │   ├── chunk-000001.json      # Articles 10000-19999
    │   ├── chunk-000002.json      # Articles 20000-29999
    │   └── ...                    # ~680 chunk files total
    └── meta.json                   # Version, article count, last updated
```

### Key Insight
The algorithm only needs **metadata** (title, categories, thumbnail URL) to score and rank articles. The **article text** is only needed when rendering a specific post.

**Separation of concerns:**
- **Index (index.json):** All metadata for all articles — loaded at startup
- **Chunks (chunk-*.json):** Article text grouped in files — fetched on-demand

---

## 3. Data Pipeline

### 3.1 Source Data: Wikipedia Dumps

Use the official Wikipedia dump files from [dumps.wikimedia.org](https://dumps.wikimedia.org/):

**Recommended files:**
```
enwiki-YYYYMMDD-pages-articles.xml.bz2    # Full article content (~22GB compressed)
enwiki-YYYYMMDD-categorylinks.sql.gz      # Category relationships
enwiki-YYYYMMDD-page.sql.gz               # Page metadata (titles, IDs)
enwiki-YYYYMMDD-pagelinks.sql.gz          # Internal links (optional)
```

**Alternative (faster, simpler):**
```
enwiki-YYYYMMDD-cirrussearch-content.json.gz  # Pre-processed JSON (~55GB)
```

The CirrusSearch dump is already parsed and includes:
- Article text (plain text extract)
- Categories
- Incoming link counts
- Page IDs

### 3.2 Processing Script Requirements

Create `scripts/generate-full-wikipedia.mjs`:

```javascript
// Pseudocode structure:

// Phase 1: Parse Wikipedia dump
// - Stream-process XML or JSON (don't load all into memory)
// - Extract: id, title, text (first 500 chars), categories
// - Filter out: redirects, disambiguation pages, stubs <300 chars

// Phase 2: Fetch thumbnails
// - For each article, query Wikipedia API for thumbnail
// - Rate limit: ~50 requests/second (respect API terms)
// - Store thumbnail filename (not full URL)

// Phase 3: Build category hierarchy
// - Parse categorylinks dump
// - Build parent→child relationships
// - Compute recursive category expansion (with cycle detection)

// Phase 4: Generate outputs
// - Sort articles by ID
// - Generate index.json with metadata only
// - Generate chunk files (10,000 articles each)
// - Generate meta.json with statistics

// Phase 5: Compress & upload
// - Brotli compress all JSON files
// - Upload to R2 bucket under full/ prefix
```

**Runtime estimates:**
- Parsing dump: 2-4 hours
- Thumbnail fetching: 10-20 hours (at 50 req/sec = 38 hours for 6.8M articles)
- Consider: Use existing thumbnail URLs from dump, skip API calls

### 3.3 Estimated Output Sizes

| File | Articles | Uncompressed | Brotli Compressed |
|------|----------|--------------|-------------------|
| index.json | 6,800,000 | ~800MB | **~80-120MB** |
| Each chunk file | 10,000 | ~25-30MB | ~3-5MB |
| Total chunks (680) | 6,800,000 | ~17-20GB | ~2-3.5GB |
| meta.json | 1 | <1KB | <1KB |

**Total R2 storage:** ~3-4GB

**Browser download at startup:** ~80-120MB (index only)

---

## 4. Index Schema

The index must be **minimal** but support the full scoring algorithm.

### 4.1 Current Algorithm Requirements

From `algorithm-worker.js`, scoring needs:
- `id` — Unique identifier
- `title` — Display name
- `thumb` — Boolean or filename (has thumbnail = +5 score)
- `allCategories` — Set of all categories (for category score sum)
- `seen` — Runtime only (not persisted)

### 4.2 Proposed Index Entry Format

```typescript
// Compact array format for size efficiency
// [title, id, thumb, chunkId, categories[]]

type IndexEntry = [
  string,        // 0: title
  number,        // 1: id (Wikipedia page ID)
  string | null, // 2: thumb filename (null if none)
  number,        // 3: chunkId (which chunk file has the text)
  string[]       // 4: categories (direct categories only)
];
```

**Example:**
```json
["Albert Einstein", 736, "Albert_Einstein_Head.jpg", 0, ["physicists", "nobel laureates", "german scientists"]]
```

### 4.3 Index File Structure

```typescript
interface IndexFile {
  version: number;           // Schema version for future migrations
  generated: string;         // ISO timestamp
  articleCount: number;      // Total articles
  chunkSize: number;         // Articles per chunk (10000)
  
  // Category hierarchy (for recursive expansion)
  subCategories: Record<string, string[]>;
  
  // Article index (compact array format)
  articles: IndexEntry[];
}
```

**Size optimization techniques:**
1. Use arrays instead of objects (no key repetition)
2. Store only direct categories (expand recursively at runtime)
3. Use chunk IDs instead of computing from article ID
4. Omit null thumbnails entirely (undefined = no thumb)

### 4.4 Index Size Estimate

Per article:
- Title: avg 25 chars = 25 bytes
- ID: avg 7 digits = 7 bytes
- Thumb: avg 30 chars or null = 15 bytes average
- Chunk ID: 3 digits = 3 bytes
- Categories: avg 5 categories × 15 chars = 75 bytes
- JSON overhead: ~20 bytes

**Total per article:** ~145 bytes
**6.8M articles:** ~986MB uncompressed
**Brotli compressed (0.1 ratio):** ~98MB

This is acceptable for initial load (comparable to streaming a 2-minute YouTube video).

---

## 5. Chunk Schema

Chunks contain article text for rendering.

### 5.1 Proposed Chunk Format

```typescript
interface ChunkFile {
  chunkId: number;           // 0, 1, 2, ... 679
  articles: ChunkArticle[];
}

interface ChunkArticle {
  id: number;                // Wikipedia page ID
  text: string;              // Article excerpt (500-1000 chars)
  // Note: title, thumb, categories are in index (don't duplicate)
}
```

**Example chunk-000000.json:**
```json
{
  "chunkId": 0,
  "articles": [
    {"id": 12, "text": "Anarchism is a political philosophy..."},
    {"id": 25, "text": "Autism is a neurodevelopmental condition..."},
    // ... 9,998 more articles
  ]
}
```

### 5.2 Chunk Size Tradeoffs

| Chunk Size | Num Files | Avg File Size | Pros | Cons |
|------------|-----------|---------------|------|------|
| 1,000 | 6,800 | ~250KB | Fine-grained, small requests | Many files, more latency |
| 5,000 | 1,360 | ~1.5MB | Balanced | - |
| **10,000** | **680** | **~3-5MB** | **Good cache hits, reasonable size** | **Larger initial fetch** |
| 50,000 | 136 | ~15-25MB | Fewer files | Too large per request |

**Recommendation:** 10,000 articles per chunk
- Typical browsing session touches ~50-100 articles
- High probability of cache hits within same chunk
- 3-5MB compressed is acceptable for on-demand fetch

### 5.3 Chunk ID Calculation

```typescript
function getChunkId(articleIndex: number): number {
  return Math.floor(articleIndex / 10000);
}

function getChunkUrl(chunkId: number): string {
  return `/full/chunks/chunk-${chunkId.toString().padStart(6, '0')}.json`;
}
```

---

## 6. Client Changes (index.html)

### 6.1 Dual-Mode Support

Add Wikipedia source selection to start screen:

```html
<div id="wikiSourceSection">
  <h4>Wikipedia Source</h4>
  <div class="wiki-source-buttons">
    <button class="wiki-source-btn active" data-source="simple">
      <span class="source-icon">📖</span>
      <span class="source-name">Simple Wikipedia</span>
      <span class="source-desc">270K articles • Fast load</span>
    </button>
    <button class="wiki-source-btn" data-source="full">
      <span class="source-icon">📚</span>
      <span class="source-name">Full Wikipedia</span>
      <span class="source-desc">6.8M articles • Slower load</span>
    </button>
  </div>
</div>
```

### 6.2 Data Loading Flow

```javascript
// Pseudocode for dual-mode loading

async function loadWikipediaData() {
  const source = localStorage.getItem('xiki_wiki_source') || 'simple';
  
  if (source === 'simple') {
    // Existing flow - load smoldata.json
    return await loadSimpleWikipedia();
  } else {
    // New flow - load index only
    return await loadFullWikipediaIndex();
  }
}

async function loadFullWikipediaIndex() {
  updateProgress('Downloading article index...', 0);
  
  const response = await fetch('/full/index.json');
  const reader = response.body.getReader();
  const total = parseInt(response.headers.get('content-length'));
  
  // Stream and parse with progress
  let loaded = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    updateProgress('Downloading article index...', loaded / total);
  }
  
  updateProgress('Processing index...', 1);
  const text = new TextDecoder().decode(concat(chunks));
  const index = JSON.parse(text);
  
  // Convert index to pagesArr format (without text)
  pagesArr = index.articles.map(([title, id, thumb, chunkId, categories]) => ({
    title,
    id,
    thumb,
    chunkId,
    text: null,  // Loaded on-demand
    allCategories: new Set(categories)
  }));
  
  // Store category hierarchy for recursive expansion
  subCategories = index.subCategories;
  
  // Expand categories recursively
  expandAllCategories();
  
  return { pagesArr, subCategories };
}
```

### 6.3 On-Demand Text Fetching

```javascript
// Chunk cache - maps chunkId to parsed chunk data
const chunkCache = new Map();
const chunkFetchPromises = new Map(); // Prevent duplicate fetches

async function ensureArticleText(article) {
  // Already loaded
  if (article.text !== null) return;
  
  const chunkId = article.chunkId;
  
  // Check cache
  if (chunkCache.has(chunkId)) {
    const chunk = chunkCache.get(chunkId);
    const chunkArticle = chunk.articles.find(a => a.id === article.id);
    if (chunkArticle) {
      article.text = chunkArticle.text;
    }
    return;
  }
  
  // Fetch chunk (with deduplication)
  if (!chunkFetchPromises.has(chunkId)) {
    const promise = fetchChunk(chunkId);
    chunkFetchPromises.set(chunkId, promise);
  }
  
  const chunk = await chunkFetchPromises.get(chunkId);
  chunkCache.set(chunkId, chunk);
  
  const chunkArticle = chunk.articles.find(a => a.id === article.id);
  if (chunkArticle) {
    article.text = chunkArticle.text;
  }
}

async function fetchChunk(chunkId) {
  const url = `/full/chunks/chunk-${chunkId.toString().padStart(6, '0')}.json`;
  const response = await fetch(url);
  return response.json();
}
```

### 6.4 Loading States for Articles

```javascript
function createPost(post) {
  const postDiv = document.createElement('div');
  postDiv.className = 'post';
  
  // Title renders immediately (from index)
  postDiv.innerHTML = `
    <h1>${escapeHtml(post.title)}</h1>
    ${post.thumb ? `<img class="media" src="${getThumbUrl(post.thumb)}">` : ''}
    <p class="post-text">${post.text ? escapeHtml(post.text) : '<span class="loading-text">Loading...</span>'}</p>
    <!-- buttons -->
  `;
  
  // If text not loaded, fetch it
  if (post.text === null) {
    ensureArticleText(post).then(() => {
      const textEl = postDiv.querySelector('.post-text');
      textEl.innerHTML = escapeHtml(post.text);
    });
  }
  
  return postDiv;
}
```

**CSS for loading state:**
```css
.loading-text {
  color: var(--text-secondary);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}
```

### 6.5 WebWorker Integration

Modify `AlgorithmWorkerManager` to handle articles without text:

```javascript
// In INIT message to worker, don't send text:
const transferData = {
  pagesArr: pagesArrData.map(p => ({
    id: p.id,
    title: p.title,
    thumb: p.thumb,
    chunkId: p.chunkId,
    // text: omitted - not needed for scoring
    allCategories: [...p.allCategories]
  })),
  // ... rest of state
};
```

The worker doesn't need article text — it only scores by categories.

### 6.6 Prefetch Strategy

```javascript
// Prefetch chunks for articles likely to be shown next
const prefetchQueue = [];
const MAX_PREFETCH_CHUNKS = 3;

function prefetchUpcomingChunks() {
  // Get next N articles from algorithm worker's prefetch queue
  const upcoming = algorithmWorker.getPrefetchedPostIds();
  
  // Find unique chunk IDs not in cache
  const chunkIds = [...new Set(upcoming.map(id => {
    const article = pagesArr.find(p => p.id === id);
    return article?.chunkId;
  }))].filter(id => id !== undefined && !chunkCache.has(id));
  
  // Prefetch first few
  chunkIds.slice(0, MAX_PREFETCH_CHUNKS).forEach(chunkId => {
    if (!chunkFetchPromises.has(chunkId)) {
      const promise = fetchChunk(chunkId);
      chunkFetchPromises.set(chunkId, promise);
      promise.then(chunk => chunkCache.set(chunkId, chunk));
    }
  });
}

// Call on each scroll event or post render
```

---

## 7. Worker Changes (src/index.ts)

### 7.1 New Routes for Full Wikipedia

```typescript
// Add to fetch handler

// Handle full Wikipedia meta
if (url.pathname === '/full/meta.json') {
  const object = await env.DATA_BUCKET.get('full/meta.json');
  if (!object) return new Response('Not found', { status: 404 });
  
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=86400', // 1 day
      'Access-Control-Allow-Origin': '*',
    }
  });
}

// Handle full Wikipedia index
if (url.pathname === '/full/index.json') {
  const object = await env.DATA_BUCKET.get('full/index.json');
  if (!object) return new Response('Not found', { status: 404 });
  
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=604800', // 1 week
      'Access-Control-Allow-Origin': '*',
      'Content-Encoding': 'br', // If pre-compressed
    }
  });
}

// Handle chunk files
const chunkMatch = url.pathname.match(/^\/full\/chunks\/chunk-(\d{6})\.json$/);
if (chunkMatch) {
  const object = await env.DATA_BUCKET.get(`full/chunks/chunk-${chunkMatch[1]}.json`);
  if (!object) return new Response('Chunk not found', { status: 404 });
  
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=2592000', // 30 days (immutable content)
      'Access-Control-Allow-Origin': '*',
    }
  });
}
```

### 7.2 Caching Strategy

| Resource | Cache-Control | Rationale |
|----------|---------------|-----------|
| meta.json | 1 day | Version info, check for updates |
| index.json | 1 week | Large file, rarely changes |
| chunk-*.json | 30 days | Content is immutable (versioned) |

### 7.3 Range Request Support (Optional Enhancement)

For very large index files, support partial content:

```typescript
if (url.pathname === '/full/index.json') {
  const object = await env.DATA_BUCKET.get('full/index.json');
  if (!object) return new Response('Not found', { status: 404 });
  
  const range = request.headers.get('Range');
  if (range) {
    // Parse Range header and return partial content
    const [start, end] = parseRange(range, object.size);
    const slice = object.body.slice(start, end + 1);
    
    return new Response(slice, {
      status: 206,
      headers: {
        'Content-Type': 'application/json',
        'Content-Range': `bytes ${start}-${end}/${object.size}`,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
      }
    });
  }
  
  // Full response
  // ...
}
```

---

## 8. Migration Path

### Phase 1: Infrastructure (Week 1)
**Goal:** R2 structure and Worker routes ready

1. Create R2 folder structure:
   - Move existing `smoldata.json` to `simple/smoldata.json`
   - Create `full/` directory (empty placeholder)
   
2. Update Worker routes:
   - Add routes for `/full/meta.json`, `/full/index.json`, `/full/chunks/*`
   - Update existing `/smoldata.json` to redirect to `/simple/smoldata.json`
   
3. Add backwards compatibility:
   - Keep `/smoldata.json` working (redirect or alias)

**Deliverable:** Worker deployed, existing functionality unchanged

### Phase 2: Data Pipeline (Weeks 2-3)
**Goal:** Generate full Wikipedia dataset

1. Download Wikipedia dumps (manually, ~100GB)
2. Develop and test `generate-full-wikipedia.mjs`
3. Run initial generation (expect 10-20 hours)
4. Validate output sizes match estimates
5. Upload to R2 bucket

**Deliverable:** Full Wikipedia data in R2

### Phase 3: Client Support (Week 4)
**Goal:** Dual-mode support in browser

1. Add Wikipedia source toggle to start screen
2. Implement index-only loading for full mode
3. Add on-demand chunk fetching
4. Add loading states for articles
5. Test performance on real devices

**Deliverable:** Feature-flagged full Wikipedia mode

### Phase 4: Polish & Ship (Week 5)
**Goal:** Production-ready release

1. Add progress indicators for index download
2. Implement chunk prefetching
3. Add cache management (memory limits)
4. Update UI copy and documentation
5. Enable by default / remove feature flag

**Deliverable:** Full Wikipedia mode live for all users

---

## 9. Acceptance Criteria

### Must Have
- [ ] Full Wikipedia index loads successfully (~80-120MB)
- [ ] Article text loads on-demand within 1 second (cached chunk)
- [ ] Article text loads on-demand within 3 seconds (uncached chunk)
- [ ] Algorithm scoring works identically to Simple Wikipedia mode
- [ ] Users can switch between Simple and Full modes
- [ ] Existing Simple Wikipedia mode continues working unchanged
- [ ] No degradation in Simple Wikipedia performance

### Should Have
- [ ] Loading progress shows during index download
- [ ] Chunk prefetching reduces perceived latency
- [ ] Chunks are cached in memory (up to 50MB)
- [ ] Failed chunk fetches show error state (not crash)
- [ ] Index download can resume after interruption

### Nice to Have
- [ ] Service Worker caches index and frequently-used chunks offline
- [ ] Index is stored in IndexedDB for instant subsequent loads
- [ ] "Download for offline" option for power users
- [ ] Analytics on chunk cache hit rates

---

## 10. Scope Boundaries

### Explicitly IN Scope
- Loading full Wikipedia article metadata at startup
- On-demand fetching of article text from chunks
- Dual-mode toggle (Simple vs Full)
- Worker routes for serving chunks from R2
- Progress indication during index load

### Explicitly OUT OF Scope
- **Article images beyond thumbnail** — Full article media gallery
- **Full article text** — We still show excerpts, not complete articles
- **Incremental updates** — Initial implementation is full regeneration only
- **Search** — Text search across 6.8M articles requires different architecture
- **Offline mode for Full Wikipedia** — Would require downloading all chunks (~3GB)
- **Wikipedia API proxying** — We don't fetch live data from Wikipedia
- **Multi-language support** — Only English Wikipedia initially
- **ML-based scoring** — Algorithm remains simple category-based
- **User-generated content** — No annotations, highlights, or notes
- **Real-time sync** — No cross-device preference sync for chunk cache

---

## 11. Estimated Complexity

**Rating: XL (Extra Large)**

### Justification

| Factor | Assessment |
|--------|------------|
| **Data volume** | 6.8M articles, ~3-4GB storage, 680 chunk files |
| **Infrastructure** | New R2 structure, new Worker routes, new client data flow |
| **Processing** | 10-20 hour data pipeline, Wikipedia dump parsing |
| **Client complexity** | Dual-mode support, on-demand loading, cache management |
| **Testing surface** | New code paths, edge cases (network failures, partial loads) |
| **Dependencies** | Wikipedia dump format stability, R2 storage limits |

### Time Estimate
- **Infrastructure:** 3-5 days
- **Data pipeline:** 5-7 days
- **Client changes:** 5-7 days
- **Testing/polish:** 3-5 days
- **Total:** 4-6 weeks for single developer

### Risk to Timeline
- Wikipedia dump format changes
- Unexpected index size (>150MB = poor UX)
- R2 storage costs exceed budget
- Browser memory issues with large index

---

## 12. Risks & Open Questions

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Index too large for mobile | Medium | High | Test on low-end devices early; consider tiered index |
| Chunk cache consumes too much memory | Medium | Medium | Implement LRU eviction with configurable limit |
| Wikipedia dump format changes | Low | High | Pin to specific dump date; add format version checks |
| R2 egress costs high | Low | Medium | Cache-Control headers; monitor usage |
| Thumbnail URLs break | Medium | Low | Store filename only; reconstruct URL client-side |

### Open Questions

1. **Index compression:** Should we use Brotli pre-compression or let Cloudflare handle it?
   - Pro pre-compression: Guaranteed best ratio
   - Pro dynamic: Simpler deployment

2. **Category expansion:** Expand at build time (larger index) or runtime (slower startup)?
   - Recommend: Store only direct categories; expand at runtime with caching

3. **Chunk size:** 10,000 articles per chunk is the proposal. Should we test 5,000?
   - Needs empirical data on access patterns

4. **Thumbnail source:** Wikipedia Commons thumbnails or generate our own?
   - Recommend: Use existing Wikipedia thumbnail URLs to avoid storage/bandwidth

5. **Index versioning:** How to handle updates without breaking cached clients?
   - Propose: Include version in meta.json; client checks before using cached index

6. **Memory limits:** What's the maximum acceptable memory footprint?
   - Propose: 500MB total (index + chunk cache + overhead)

7. **Fallback behavior:** What if index fails to load?
   - Propose: Offer to fall back to Simple Wikipedia

---

## 13. Appendix: Current Data Structures

### Current smoldata.json Structure (for reference)

```typescript
interface SmolData {
  pages: [
    string,    // title
    number,    // id
    string,    // text (excerpt)
    string,    // thumb (filename or null)
    string[],  // categories
    number[]   // link IDs
  ][];
  subCategories: Record<string, string[]>;
  noPageMaps: Record<number, string>;
}
```

### Current Article Object (runtime)

```typescript
interface Article {
  title: string;
  id: number;
  text: string;
  thumb: string | null;
  allCategories: Set<string>;
  chunkId?: number;  // NEW for full mode
  score?: number;
  seen?: number;
  recommendedBecause?: string[];
}
```

---

## 14. Next Steps

1. **Design agent** should create detailed technical design for:
   - Data pipeline script architecture
   - Client state machine for dual-mode loading
   - Cache eviction strategy
   - Error handling and retry logic

2. **Implementation** should start with Phase 1 (infrastructure) to validate R2 setup before investing in data pipeline.

3. **Consider pilot test** with subset (~500K articles) before full 6.8M to validate approach.

---

*Document ready for design phase handoff.*
