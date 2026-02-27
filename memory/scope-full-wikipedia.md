# Scope Document: Full Wikipedia Support (Chunked Architecture)

**Feature:** Support full English Wikipedia (~6.8M articles) via chunked index + on-demand fetch
**Started:** 2026-02-27
**Status:** Scoped
**Complexity:** Large (L)

---

## Problem Statement

xikipedia currently uses Simple Wikipedia (~270K articles) loaded entirely into memory via `smoldata.json` (~215MB uncompressed, ~40MB Brotli). To support full English Wikipedia (~6.8M articles, 25x more), we need a new architecture that:

1. Keeps the index small enough for initial load (~50-100MB)
2. Fetches article text on-demand when posts render
3. Maintains 100% client-side algorithm execution
4. Integrates with existing WebWorker infrastructure

---

## Acceptance Criteria

### Must Have
- [ ] Lightweight index containing only: title, id, categories, thumbnail reference (~50-100MB compressed)
- [ ] Article text stored in ~680 chunk files (~10K articles per chunk)
- [ ] On-demand chunk fetching when post renders
- [ ] Caching layer for fetched chunks (LRU eviction)
- [ ] Progress UI for initial index load
- [ ] Graceful degradation if chunk fetch fails

### Should Have
- [ ] Prefetch next likely chunks based on category affinity
- [ ] Service Worker integration for chunk caching
- [ ] Offline support for cached chunks

### Won't Have (This Phase)
- [ ] Incremental index updates
- [ ] Full-text search
- [ ] Image/media galleries
- [ ] Wikipedia API fallback for text

---

## Scope Boundaries

### In Scope
- New data format (index.json + chunk files)
- R2 storage structure for chunks
- Data generation script for full Wikipedia
- Client-side chunk loading and caching
- WebWorker integration for chunk-aware scoring
- UI loading states for on-demand content

### Out of Scope
- Changes to the scoring algorithm
- New UI features (beyond loading states)
- Authentication changes
- Category hierarchy changes
- Deployment pipeline changes

---

## Technical Approach Overview

### Data Structure

**Current:**
```
smoldata.json (215MB)
{
  pages: [[title, id, text, thumb, categories, links], ...],
  subCategories: {...},
  noPageMaps: {...}
}
```

**Proposed:**
```
index.json (~50-100MB compressed)
{
  pages: [[title, id, chunkId, thumbRef, categories], ...],  // NO text!
  subCategories: {...},
  noPageMaps: {...}
}

articles/chunk-000000.json (~15MB each)
{
  articles: {
    "12345": "Article text...",
    "12346": "Another article...",
    ...
  }
}
```

### R2 Storage Structure
```
xikipedia-data/
├── index.json           # Lightweight index
├── smoldata.json       # Legacy (keep for fallback)
└── articles/
    ├── chunk-000000.json
    ├── chunk-000001.json
    ...
    └── chunk-000679.json
```

### Client Flow
1. **Startup:** Load `index.json` (~50-100MB) with progress
2. **Algorithm:** Score articles using index (no text needed)
3. **Render:** When post displays, check chunk cache
4. **Fetch:** If miss, fetch chunk containing article
5. **Cache:** Store chunk in memory LRU (keep ~10 chunks)
6. **Display:** Show article text once loaded

### Key Files to Modify
- `scripts/generate-data.mjs` - Generate chunked format from Wikipedia dumps
- `public/index.html` - Chunk loading, caching, UI states
- `public/algorithm-worker.js` - Chunk-aware post selection
- `src/index.ts` - R2 routes for chunk serving

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Index still too large | Slow startup | Use Brotli level 11, strip unnecessary fields |
| Chunk fetch latency | Poor UX | Prefetch likely chunks, show loading skeleton |
| Memory pressure | Browser crash | Strict LRU eviction, limit concurrent fetches |
| Wikipedia dump processing | Hours/days to run | Document process, make resumable |

---

## Estimated Effort

| Phase | Time | Notes |
|-------|------|-------|
| Data format design | 2h | Schema, chunk size optimization |
| Generation script | 4h | Parse dumps, generate chunks |
| Client loader | 4h | Fetch, cache, integrate |
| WebWorker updates | 2h | Chunk-aware prefetch |
| UI polish | 2h | Loading states, errors |
| Testing | 2h | Mock chunks for tests |
| **Total** | ~16h | |

---

## Dependencies

- Access to Wikipedia dump files (https://dumps.wikimedia.org/)
- R2 bucket storage capacity (~5-10GB)
- No external service dependencies (offline-capable)

---

## Success Metrics

- Initial load time < 30 seconds (on 4G)
- Article text appears < 2 seconds after scroll
- Memory usage < 500MB peak
- 95% of articles render text on first try

---

*Last updated: 2026-02-27 08:48 MST*
