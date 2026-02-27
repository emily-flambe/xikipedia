# Active Improvements

*Currently in-progress work for xikipedia*

## Current Work

### Full Wikipedia Support (Chunked Architecture)
- **Status:** Phase 2 Complete → Starting Phase 3
- **Started:** 2026-02-27 08:50 MST
- **Scope Document:** `memory/scope-full-wikipedia.md`
- **Design Document:** `memory/design-full-wikipedia.md`
- **Description:** Support full English Wikipedia (6.8M articles) via chunked index + on-demand fetch. Lightweight index (~80-100MB) for client-side scoring, article text fetched per-post.
- **Architecture:** 
  - `index.json` — titles, IDs, categories, thumbs (~80-100MB compressed, tuple arrays)
  - `articles/chunk-NNNNNN.json` — 680 chunks × ~4MB each, article text in ~10K batches
  - Client loads index, fetches text on-demand with LRU cache (10 chunks)
- **Implementation Phases:** (estimated ~18h total)
  1. ✅ Data Generation (4h) - Wikipedia dump processing, index/chunk creation
  2. ✅ Worker Routes (2h) - R2 routes for index.json and chunk files → **PR #50 merged**
  3. ⏳ Client Loader (4h) - ChunkCache, ChunkFetcher, format detection
  4. Post Rendering (3h) - Lazy text loading, skeleton UI
  5. WebWorker Updates (2h) - Prefetch hints, text-less scoring
  6. Polish & Test (3h) - Skeleton CSS, SW caching, testing
- **Current Phase:** Phase 3 (Client Loader) - sub-agent running
- **Phase 1 Agent:** `agent:xikipedia:subagent:8248f0fa-303f-470c-8c9f-2def16e4f919` ✅
- **Phase 2 Agent:** `agent:xikipedia:subagent:be034a30-d84f-4cbe-9030-001a3c5f0fd6` ✅
- **Phase 3 Agent:** `agent:xikipedia:subagent:c965862e-8867-4d69-a91e-6a81b6360977` ⏳
- **Blockers:** None

---

## Recently Completed

### PR #50: Phase 2 Worker Routes
- **Status:** ✅ Merged
- **Completed:** 2026-02-27 09:18 MST
- **Description:** R2 routes for chunked Wikipedia architecture
- **Key changes:**
  - Added `serveR2File` helper function with cache headers & range requests
  - `/index.json` route (1-day cache)
  - `/articles/chunk-NNNNNN.json` route (1-week immutable cache)
  - Refactored `smoldata.json` to use new helper

### PR #48: WebWorker for Algorithm Processing
- **Status:** ✅ Merged
- **Completed:** 2026-02-27
- **Description:** Offloaded algorithm calculations to background WebWorker thread

---

*Last updated: 2026-02-27 09:18 MST*
