# Scope: WebWorker for Algorithm Processing

**Created:** 2026-02-27
**Status:** Draft
**Complexity:** Large (L)

---

## 1. Problem Statement

### Why This Matters

The `getNextPost()` function currently runs on the main thread and performs computationally intensive work:

1. **Samples 10,000 random articles** from a 270K article array
2. **Filters** against seen posts (Set lookup × 10K)
3. **Scores each article** by iterating through its `allCategories` Set (averaging ~15-30 categories per article)
4. **Applies multiple scoring factors**: base score, category scores, time decay, boost/reduce/block filters, variety penalties, roulette bonuses
5. **Selects winner** via weighted random or highest score

This happens **every time a post is needed** - roughly every 1-2 seconds during active scrolling.

### Impact
- **Jank on slower devices**: The ~10-50ms blocking operation causes visible frame drops
- **Scroll stuttering**: New posts are created on scroll, creating periodic hitches
- **Touch responsiveness**: Double-tap detection and like animations compete with algorithm
- **Battery drain**: Inefficient use of main thread prevents proper power optimization

### Evidence
- User context mentions "jank on slower devices during heavy processing"
- Code inspection shows synchronous sampling and scoring of 10,000 articles
- No yielding or chunking in the scoring loop

---

## 2. Acceptance Criteria

### Must Have
- [ ] Algorithm runs entirely in a WebWorker, off the main thread
- [ ] Main thread remains responsive during article selection
- [ ] Feed continues to scroll smoothly while next post is being computed
- [ ] All existing algorithm behavior preserved (scoring, variety, serendipity, roulette)
- [ ] Preferences (likes, blocks, boosts) still work correctly
- [ ] Explore mode toggle still works
- [ ] No visible change in feed behavior to users

### Should Have
- [ ] Worker pre-computes next 2-3 posts in background for instant delivery
- [ ] Graceful fallback if WebWorker unavailable (old browsers)
- [ ] Worker initialization happens during data loading phase

### Nice to Have
- [ ] Performance metrics logging (time per selection in worker vs. previous main thread)
- [ ] Worker can be terminated/restarted if stuck

---

## 3. Scope Boundaries

### IN SCOPE
- Moving `getNextPost()` logic to WebWorker
- Moving `getRandomPost()` logic to WebWorker
- Moving scoring calculations to WebWorker
- Transferring article data to worker
- Message protocol between main thread and worker
- State synchronization (category scores, filters, seen posts)

### OUT OF SCOPE
- Changing the algorithm itself (only moving it)
- Modifying data loading (smoldata.json fetch)
- UI changes
- Auth/persistence changes
- Any other refactoring (splitting index.html, etc.)
- Performance optimizations beyond the WebWorker move

---

## 4. Technical Considerations

### 4.1 What Code Moves to the Worker

**Primary Functions:**
```javascript
// These move to worker entirely:
getNextPost()           // ~100 lines - main algorithm
getRandomPost()         // ~15 lines - random selection
markPostSeen()          // ~5 lines - seen tracking
getDecayFactor()        // ~10 lines - time decay calc
```

**Supporting State (must be synced to worker):**
```javascript
// Read-only in worker (synced from main):
pagesArr                // 270K articles, ~200MB in memory
algorithmAggressiveness // number 0-100
exploreMode             // boolean

// Mutable in both directions:
categoryScores          // object, ~100-500 entries
seenPostIds             // Set, grows to ~5000 entries
categoryLastEngaged     // object, timestamps

// Read-only filters (synced from main):
hiddenCategories        // Set
reducedCategories       // Set  
boostedCategories       // Set
```

### 4.2 Communication Protocol

**Main Thread → Worker:**
```javascript
// Initial data transfer (once, during startup)
{ type: 'INIT', payload: {
    pagesArr: [...],              // Transferred, not copied
    categoryScores: {...},
    hiddenCategories: [...],
    reducedCategories: [...],
    boostedCategories: [...],
    seenPostIds: [...],
    algorithmAggressiveness: 50,
    exploreMode: false
}}

// Request next post
{ type: 'GET_NEXT' }

// State updates
{ type: 'UPDATE_SCORES', payload: { categoryScores: {...} }}
{ type: 'UPDATE_FILTERS', payload: { hidden: [...], reduced: [...], boosted: [...] }}
{ type: 'UPDATE_SETTINGS', payload: { aggressiveness: 75, exploreMode: true }}
{ type: 'MARK_SEEN', payload: { postId: 12345 }}
{ type: 'ENGAGE_POST', payload: { postId: 12345, amount: 75 }}
```

**Worker → Main Thread:**
```javascript
// Post ready
{ type: 'POST_READY', payload: {
    post: { title, id, text, thumb, allCategories: [...], recommendedBecause: [...] },
    nextPostId: 12346  // Pre-fetched hint
}}

// State sync back (after engagement)
{ type: 'SCORES_UPDATED', payload: { categoryScores: {...} }}
```

### 4.3 Handling pagesArr (270K Articles)

**Option A: Transfer ArrayBuffer (Recommended)**
- Serialize pagesArr to ArrayBuffer on load
- Transfer (not copy) to worker via `postMessage(data, [data.buffer])`
- Worker owns the data; main thread has no copy
- Pros: Zero-copy, fast, memory efficient
- Cons: Complex serialization, main thread can't access directly

**Option B: SharedArrayBuffer**
- Store article data in SharedArrayBuffer
- Both threads can read simultaneously
- Pros: No transfer needed, shared access
- Cons: Requires COOP/COEP headers, browser support varies

**Option C: Copy on Init**
- structuredClone() the entire array to worker
- Pros: Simple, works everywhere
- Cons: 2x memory usage, slow initial transfer (~200MB)

**Recommendation:** Start with Option C for simplicity, optimize to Option A if memory becomes an issue. The data is loaded once at startup, so transfer time is acceptable.

### 4.4 State Synchronization Strategy

**Category Scores:**
- Main thread is source of truth (user clicks like/more/less)
- Debounced sync to worker every 500ms when dirty
- Worker uses scores for calculations but doesn't modify

**Seen Posts:**
- Worker tracks internally (adds on each selection)
- Syncs back to main thread periodically
- Main thread persists to localStorage

**Filters (hidden/reduced/boosted):**
- Main thread is source of truth
- Immediate sync to worker on change

### 4.5 Impact on Existing Functionality

**Feed Rendering:**
- `createNextPost()` stays on main thread (DOM manipulation)
- Calls `requestNextPost()` instead of `getNextPost()` directly
- Uses async/callback pattern

**Session Stats:**
- `articlesViewed`, `articlesLiked` stay on main thread
- `viewedHistory` stays on main thread

**Persistence:**
- `saveSeenPosts()`, `savePreferences()` stay on main thread
- Worker state synced back before save

**Tests:**
- Existing E2E tests should pass unchanged
- May need new unit tests for worker protocol

---

## 5. Implementation Approach

### Phase 1: Create Worker Shell
1. Create `/public/algorithm-worker.js`
2. Set up message handling infrastructure
3. Implement `INIT` and `GET_NEXT` messages
4. Copy algorithm functions to worker

### Phase 2: Wire Up Main Thread
1. Create `AlgorithmWorkerManager` class in index.html
2. Initialize worker during data loading
3. Replace `getNextPost()` with async `requestNextPost()`
4. Modify `createNextPost()` to handle async

### Phase 3: State Synchronization
1. Implement score/filter sync messages
2. Add debounced sync for categoryScores
3. Handle engagement updates
4. Sync seen posts

### Phase 4: Polish
1. Add fallback for no WebWorker support
2. Pre-fetch next post(s) for instant delivery
3. Error handling and worker restart
4. Performance logging

---

## 6. Risks & Concerns

### High Risk
- **Data serialization overhead**: 270K articles × ~500 bytes = ~135MB. Initial transfer could take 1-2 seconds on slow devices.
  - *Mitigation*: Show loading indicator during worker init; consider streaming init

### Medium Risk
- **Race conditions**: User rapidly clicking like/less while worker is processing
  - *Mitigation*: Queue requests, process sequentially

- **State divergence**: Scores get out of sync between threads
  - *Mitigation*: Main thread is authoritative; periodic full sync

### Low Risk
- **Browser compatibility**: WebWorkers supported in all target browsers (IE11 not supported)
- **Testing complexity**: E2E tests should work unchanged; may need mock worker for unit tests

---

## 7. Estimated Effort

| Phase | Effort | Notes |
|-------|--------|-------|
| Phase 1: Worker Shell | 2-3 hours | Core algorithm port |
| Phase 2: Wire Up Main | 2-3 hours | Async refactor |
| Phase 3: State Sync | 2-3 hours | Most complex part |
| Phase 4: Polish | 1-2 hours | Error handling, prefetch |

**Total: 7-11 hours** (~2-3 sessions)

**Complexity: Large (L)** - Architectural change with thread coordination

---

## 8. Open Questions

1. **Memory budget**: Is 2x memory usage acceptable during development? Can optimize later.
2. **Prefetch depth**: How many posts to pre-compute? 2-3 seems reasonable.
3. **Sync frequency**: How often to sync scores back? 500ms debounce seems reasonable.
4. **Error recovery**: If worker crashes, restart or fall back to main thread?

---

## Appendix: Relevant Code Locations

| Function | Lines (approx) | Purpose |
|----------|---------------|---------|
| `getNextPost()` | 2790-2886 | Main algorithm |
| `getRandomPost()` | 2770-2788 | Random selection |
| `markPostSeen()` | 2764-2768 | Seen tracking |
| `getDecayFactor()` | 1670-1678 | Time decay |
| `engagePost()` | 2186-2199 | Score updates |
| `createNextPost()` | 2388-2550 | Post DOM creation |
