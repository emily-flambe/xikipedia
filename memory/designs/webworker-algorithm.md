# Design: WebWorker for Algorithm Processing

**Scope Document:** `memory/scopes/webworker-algorithm.md`
**Created:** 2026-02-27
**Status:** Draft

---

## 1. Technical Approach

### 1.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Main Thread                               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐   │
│  │ DOM/Render   │    │ User Events  │    │ AlgorithmWorker  │   │
│  │ createPost() │◄───│ scroll/like  │◄───│    Manager       │   │
│  └──────────────┘    └──────────────┘    └────────┬─────────┘   │
│                                                    │ postMessage │
└────────────────────────────────────────────────────┼─────────────┘
                                                     │
                    ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ─
                                                     │
┌────────────────────────────────────────────────────┼─────────────┐
│                        Worker Thread               │             │
│                      ┌─────────────────────────────▼───────────┐ │
│                      │         algorithm-worker.js             │ │
│                      │  ┌────────────┐  ┌─────────────────┐   │ │
│                      │  │ pagesArr   │  │ getNextPost()   │   │ │
│                      │  │ (270K)     │  │ getRandomPost() │   │ │
│                      │  └────────────┘  │ markPostSeen()  │   │ │
│                      │  ┌────────────┐  │ getDecayFactor()│   │ │
│                      │  │ State      │  └─────────────────┘   │ │
│                      │  │ categoryS. │                         │ │
│                      │  │ seenPosts  │  ┌─────────────────┐   │ │
│                      │  │ filters    │  │ Prefetch Queue  │   │ │
│                      │  └────────────┘  │ (2-3 posts)     │   │ │
│                      │                   └─────────────────┘   │ │
│                      └─────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### 1.2 Worker File Structure

**`public/algorithm-worker.js`** - Self-contained module with:

```javascript
// === STATE (owned by worker) ===
let pagesArr = [];              // Full article dataset (transferred once)
let categoryScores = {};        // Engagement scores per category
let seenPostIds = new Set();    // Posts already shown
let categoryLastEngaged = {};   // Timestamps for decay calculation
let hiddenCategories = new Set();
let reducedCategories = new Set();
let boostedCategories = new Set();
let exploredCategories = new Set();
let algorithmAggressiveness = 50;
let exploreMode = false;

// Variety enforcement state
let postsSinceRandom = 0;
let lastTopCategory = null;
let consecutiveSameCategory = 0;

// Prefetch queue
let prefetchQueue = [];
const PREFETCH_SIZE = 3;

// === ALGORITHM FUNCTIONS (moved from index.html) ===
function getDecayFactor(cat) { ... }
function markPostSeen(post) { ... }
function getRandomPost() { ... }
function getNextPost() { ... }

// === MESSAGE HANDLER ===
self.onmessage = function(e) { ... }
```

### 1.3 Message Protocol

#### Main Thread → Worker

| Message Type | Payload | Purpose |
|--------------|---------|---------|
| `INIT` | `{ pagesArr, categoryScores, seenPostIds, hiddenCategories, reducedCategories, boostedCategories, algorithmAggressiveness, exploreMode, categoryLastEngaged, exploredCategories }` | Initial data transfer at startup |
| `GET_NEXT_POST` | `{ requestId }` | Request next article |
| `PREFETCH` | `{}` | Trigger background prefetch |
| `UPDATE_SCORES` | `{ categoryScores }` | Sync category scores after engagement |
| `UPDATE_FILTERS` | `{ hidden, reduced, boosted }` | Sync user filter changes |
| `UPDATE_SETTINGS` | `{ algorithmAggressiveness?, exploreMode? }` | Sync algorithm settings |
| `MARK_SEEN` | `{ postId }` | Explicit seen mark (redundant safety) |
| `ENGAGE_CATEGORY` | `{ category, timestamp }` | Update categoryLastEngaged for decay |
| `SYNC_EXPLORED` | `{ exploredCategories }` | Sync explored categories |

#### Worker → Main Thread

| Message Type | Payload | Purpose |
|--------------|---------|---------|
| `READY` | `{}` | Worker initialized and ready |
| `POST_READY` | `{ requestId, post, prefetchAvailable }` | Requested post delivered |
| `PREFETCH_READY` | `{ count }` | Prefetch queue status |
| `SEEN_SYNC` | `{ seenPostIds: [...] }` | Periodic sync of seen IDs back |
| `ERROR` | `{ message, requestId? }` | Error occurred |

---

## 2. Files to Create

### 2.1 `public/algorithm-worker.js`

Complete worker implementation:

```javascript
/**
 * Xikipedia Algorithm Worker
 * 
 * Handles article selection algorithm off the main thread.
 * Receives full article dataset once, then processes requests.
 */

'use strict';

// === STATE ===
let pagesArr = [];
let categoryScores = {};
let seenPostIds = new Set();
let categoryLastEngaged = {};
let hiddenCategories = new Set();
let reducedCategories = new Set();
let boostedCategories = new Set();
let exploredCategories = new Set();
let algorithmAggressiveness = 50;
let exploreMode = false;

// Variety enforcement
let postsSinceRandom = 0;
let lastTopCategory = null;
let consecutiveSameCategory = 0;

// Prefetch queue (holds ready-to-serve posts)
let prefetchQueue = [];
const PREFETCH_SIZE = 3;

// === HELPER: Convert category to display name ===
function convertCat(cat) {
    if (!cat) return cat;
    return cat.charAt(0).toUpperCase() + cat.slice(1).toLowerCase();
}

// === ALGORITHM: Time-based decay ===
function getDecayFactor(cat) {
    const lastEngaged = categoryLastEngaged[cat];
    if (!lastEngaged) return 1;
    const hoursSince = (Date.now() - lastEngaged) / (1000 * 60 * 60);
    // Decay to 50% after 24 hours, to 10% after 72 hours
    return Math.max(0.1, Math.exp(-hoursSince / 48));
}

// === ALGORITHM: Mark post as seen ===
function markPostSeen(post) {
    seenPostIds.add(post.id);
    post.seen = (post.seen ?? 0) + 1;
    // Note: saveSeenPosts() happens on main thread
}

// === ALGORITHM: Random unseen post ===
function getRandomPost() {
    for (let i = 0; i < 1000; i++) {
        const randomPost = pagesArr[Math.floor(Math.random() * pagesArr.length)];
        if (!seenPostIds.has(randomPost.id)) {
            markPostSeen(randomPost);
            randomPost.recommendedBecause = ['🎲 Serendipity'];
            return randomPost;
        }
    }
    // Fallback: allow repeat
    console.warn('Exhausted unique posts, allowing repeat');
    const randomPost = pagesArr[Math.floor(Math.random() * pagesArr.length)];
    markPostSeen(randomPost);
    randomPost.recommendedBecause = ['🎲 Serendipity'];
    return randomPost;
}

// === ALGORITHM: Main selection (port from index.html lines 2790-2886) ===
function getNextPost() {
    // Explore mode OR aggressiveness 0: return purely random post
    if (exploreMode || algorithmAggressiveness === 0) {
        return getRandomPost();
    }

    // === SERENDIPITY INJECTION ===
    postsSinceRandom++;
    const serendipityThreshold = 5 + Math.floor(Math.random() * 6);
    if (postsSinceRandom >= serendipityThreshold) {
        postsSinceRandom = 0;
        return getRandomPost();
    }

    // === VARIETY ENFORCEMENT ===
    let varietyPenaltyCategory = null;
    if (consecutiveSameCategory >= 2 && lastTopCategory) {
        varietyPenaltyCategory = lastTopCategory;
    }

    // === CATEGORY ROULETTE ===
    let rouletteBoostCategory = null;
    if (Math.random() < 0.1) {
        const allCats = new Set();
        pagesArr.slice(0, 1000).forEach(p => p.allCategories?.forEach(c => allCats.add(c)));
        const unexplored = [...allCats].filter(c => 
            !exploredCategories.has(c) && 
            !hiddenCategories.has(c) &&
            c !== 'given names' && c !== 'surnames'
        );
        if (unexplored.length > 0) {
            rouletteBoostCategory = unexplored[Math.floor(Math.random() * unexplored.length)];
        }
    }

    // Scale category influence by aggressiveness
    const aggFactor = algorithmAggressiveness / 50;

    const potentialPosts = [...Array(10000)]
        .map(() => pagesArr[Math.floor(Math.random() * pagesArr.length)])
        .filter(post => !seenPostIds.has(post.id))
        .map(post => {
            const initialScore = (post.thumb ? 5 : 0) + (3 ** (post.seen ?? 0) - 1) * -500000;
            let postScore = [...post.allCategories].reduce(
                (sum, cat) => {
                    const baseScore = (categoryScores[cat] ?? 0) * aggFactor;
                    let catScore = baseScore * getDecayFactor(cat);
                    
                    if (boostedCategories.has(cat)) catScore += 2000;
                    if (reducedCategories.has(cat)) catScore -= 1500;
                    if (cat === varietyPenaltyCategory) catScore -= 5000;
                    if (cat === rouletteBoostCategory) catScore += 3000;
                    
                    return sum + catScore;
                },
                initialScore
            );
            post.score = postScore;
            return post;
        });

    // Fallback if all sampled posts seen
    if (potentialPosts.length === 0) {
        console.warn('All sampled posts seen, trying harder...');
        for (let i = 0; i < 10000; i++) {
            const randomPost = pagesArr[Math.floor(Math.random() * pagesArr.length)];
            if (!seenPostIds.has(randomPost.id)) {
                markPostSeen(randomPost);
                return randomPost;
            }
        }
        const randomPost = pagesArr[Math.floor(Math.random() * pagesArr.length)];
        markPostSeen(randomPost);
        return randomPost;
    }

    let highestScore = -Infinity;
    let bestPost = potentialPosts[0];

    if (Math.random() < 0.4) {
        // Weighted random selection
        const minScore = Math.min(...potentialPosts.map(e => e.score));
        const maxScore = potentialPosts.reduce((sum, post) => sum + post.score - minScore, 0);
        const targetScore = Math.random() * maxScore;
        let scoreCount = 0;

        while (scoreCount < targetScore && potentialPosts.length) {
            const potentialPost = potentialPosts.pop();
            bestPost = potentialPost;
            scoreCount += potentialPost.score - minScore;
        }
    } else if (Math.random() > 0.3) {
        // Highest score selection
        potentialPosts.forEach(post => {
            if (post.score > highestScore) {
                bestPost = post;
                highestScore = post.score;
            }
        });
    }

    markPostSeen(bestPost);

    // Track recommendation reasons
    const categoryContributions = [...bestPost.allCategories]
        .map(cat => ({ cat, score: categoryScores[cat] || 0 }))
        .filter(c => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

    if (categoryContributions.length > 0) {
        bestPost.recommendedBecause = categoryContributions.map(c => convertCat(c.cat));
        
        const topCat = categoryContributions[0].cat;
        if (topCat === lastTopCategory) {
            consecutiveSameCategory++;
        } else {
            lastTopCategory = topCat;
            consecutiveSameCategory = 1;
        }
    } else {
        bestPost.recommendedBecause = null;
        lastTopCategory = null;
        consecutiveSameCategory = 0;
    }

    if (rouletteBoostCategory && bestPost.allCategories.has(rouletteBoostCategory)) {
        bestPost.recommendedBecause = ['🎰 ' + convertCat(rouletteBoostCategory)];
    }

    return bestPost;
}

// === PREFETCH: Fill queue with upcoming posts ===
function fillPrefetchQueue() {
    while (prefetchQueue.length < PREFETCH_SIZE) {
        const post = getNextPost();
        prefetchQueue.push(serializePost(post));
    }
}

// === SERIALIZE: Prepare post for transfer (Sets → Arrays) ===
function serializePost(post) {
    return {
        id: post.id,
        title: post.title,
        text: post.text,
        thumb: post.thumb,
        allCategories: [...post.allCategories],
        recommendedBecause: post.recommendedBecause,
        score: post.score
    };
}

// === MESSAGE HANDLER ===
self.onmessage = function(e) {
    const { type, payload, requestId } = e.data;

    switch (type) {
        case 'INIT':
            // Receive full dataset and initial state
            pagesArr = payload.pagesArr;
            categoryScores = payload.categoryScores || {};
            seenPostIds = new Set(payload.seenPostIds || []);
            categoryLastEngaged = payload.categoryLastEngaged || {};
            hiddenCategories = new Set(payload.hiddenCategories || []);
            reducedCategories = new Set(payload.reducedCategories || []);
            boostedCategories = new Set(payload.boostedCategories || []);
            exploredCategories = new Set(payload.exploredCategories || []);
            algorithmAggressiveness = payload.algorithmAggressiveness ?? 50;
            exploreMode = payload.exploreMode ?? false;

            // Convert allCategories back to Sets (lost in transfer)
            pagesArr.forEach(p => {
                if (Array.isArray(p.allCategories)) {
                    p.allCategories = new Set(p.allCategories);
                }
            });

            // Pre-fill queue
            fillPrefetchQueue();

            self.postMessage({ type: 'READY' });
            break;

        case 'GET_NEXT_POST':
            let post;
            if (prefetchQueue.length > 0) {
                post = prefetchQueue.shift();
            } else {
                post = serializePost(getNextPost());
            }
            
            self.postMessage({
                type: 'POST_READY',
                requestId,
                payload: {
                    post,
                    prefetchAvailable: prefetchQueue.length
                }
            });

            // Refill queue in background
            fillPrefetchQueue();
            break;

        case 'PREFETCH':
            fillPrefetchQueue();
            self.postMessage({
                type: 'PREFETCH_READY',
                payload: { count: prefetchQueue.length }
            });
            break;

        case 'UPDATE_SCORES':
            categoryScores = payload.categoryScores || categoryScores;
            break;

        case 'UPDATE_FILTERS':
            if (payload.hidden) hiddenCategories = new Set(payload.hidden);
            if (payload.reduced) reducedCategories = new Set(payload.reduced);
            if (payload.boosted) boostedCategories = new Set(payload.boosted);
            // Clear prefetch queue - filters changed
            prefetchQueue = [];
            fillPrefetchQueue();
            break;

        case 'UPDATE_SETTINGS':
            if (payload.algorithmAggressiveness !== undefined) {
                algorithmAggressiveness = payload.algorithmAggressiveness;
            }
            if (payload.exploreMode !== undefined) {
                exploreMode = payload.exploreMode;
            }
            // Clear prefetch queue - settings changed
            prefetchQueue = [];
            fillPrefetchQueue();
            break;

        case 'MARK_SEEN':
            seenPostIds.add(payload.postId);
            break;

        case 'ENGAGE_CATEGORY':
            categoryLastEngaged[payload.category] = payload.timestamp;
            break;

        case 'SYNC_EXPLORED':
            exploredCategories = new Set(payload.exploredCategories || []);
            break;

        case 'RESET':
            // Clear seen posts and prefetch queue (for feed refresh)
            pagesArr.forEach(p => { delete p.seen; });
            prefetchQueue = [];
            postsSinceRandom = 0;
            lastTopCategory = null;
            consecutiveSameCategory = 0;
            fillPrefetchQueue();
            self.postMessage({ type: 'READY' });
            break;

        case 'GET_SEEN_IDS':
            // Sync seen IDs back to main thread for persistence
            self.postMessage({
                type: 'SEEN_SYNC',
                payload: { seenPostIds: [...seenPostIds] }
            });
            break;

        default:
            console.warn('Unknown message type:', type);
    }
};
```

---

## 3. Files to Modify

### 3.1 `public/index.html`

#### 3.1.1 Add AlgorithmWorkerManager Class

Insert after the global state variables (~line 1480):

```javascript
// ============================================
// WebWorker Algorithm Manager
// ============================================

class AlgorithmWorkerManager {
    constructor() {
        this.worker = null;
        this.pendingRequests = new Map(); // requestId → { resolve, reject }
        this.requestIdCounter = 0;
        this.isReady = false;
        this.readyPromise = null;
        this.readyResolve = null;
        this.syncTimer = null;
    }

    // Initialize worker with article data
    async init(pagesArr, initialState) {
        if (typeof Worker === 'undefined') {
            console.warn('WebWorkers not supported, using fallback');
            return false;
        }

        this.worker = new Worker('/algorithm-worker.js');
        
        // Create ready promise
        this.readyPromise = new Promise(resolve => {
            this.readyResolve = resolve;
        });

        // Set up message handler
        this.worker.onmessage = (e) => this._handleMessage(e);
        this.worker.onerror = (e) => this._handleError(e);

        // Prepare data for transfer (Sets → Arrays)
        const transferData = {
            pagesArr: pagesArr.map(p => ({
                ...p,
                allCategories: [...p.allCategories]
            })),
            categoryScores: initialState.categoryScores,
            seenPostIds: [...initialState.seenPostIds],
            categoryLastEngaged: initialState.categoryLastEngaged,
            hiddenCategories: [...initialState.hiddenCategories],
            reducedCategories: [...initialState.reducedCategories],
            boostedCategories: [...initialState.boostedCategories],
            exploredCategories: [...initialState.exploredCategories],
            algorithmAggressiveness: initialState.algorithmAggressiveness,
            exploreMode: initialState.exploreMode
        };

        // Send init message
        this.worker.postMessage({ type: 'INIT', payload: transferData });

        // Wait for ready signal
        await this.readyPromise;
        this.isReady = true;

        // Start periodic score sync
        this._startSyncTimer();

        return true;
    }

    // Request next post (returns Promise)
    async getNextPost() {
        if (!this.isReady) {
            await this.readyPromise;
        }

        const requestId = ++this.requestIdCounter;
        
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(requestId, { resolve, reject });
            this.worker.postMessage({ type: 'GET_NEXT_POST', requestId });
            
            // Timeout after 5 seconds
            setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(new Error('Worker request timeout'));
                }
            }, 5000);
        });
    }

    // Sync category scores to worker
    syncScores(categoryScores) {
        if (!this.worker) return;
        this.worker.postMessage({
            type: 'UPDATE_SCORES',
            payload: { categoryScores }
        });
    }

    // Sync filter changes
    syncFilters(hidden, reduced, boosted) {
        if (!this.worker) return;
        this.worker.postMessage({
            type: 'UPDATE_FILTERS',
            payload: {
                hidden: [...hidden],
                reduced: [...reduced],
                boosted: [...boosted]
            }
        });
    }

    // Sync settings changes
    syncSettings(algorithmAggressiveness, exploreMode) {
        if (!this.worker) return;
        this.worker.postMessage({
            type: 'UPDATE_SETTINGS',
            payload: { algorithmAggressiveness, exploreMode }
        });
    }

    // Reset for feed refresh
    reset() {
        if (!this.worker) return;
        this.worker.postMessage({ type: 'RESET' });
    }

    // Request seen IDs for persistence
    requestSeenIds() {
        if (!this.worker) return;
        this.worker.postMessage({ type: 'GET_SEEN_IDS' });
    }

    // Private: Handle messages from worker
    _handleMessage(e) {
        const { type, requestId, payload } = e.data;

        switch (type) {
            case 'READY':
                if (this.readyResolve) {
                    this.readyResolve();
                    this.readyResolve = null;
                }
                break;

            case 'POST_READY':
                const pending = this.pendingRequests.get(requestId);
                if (pending) {
                    this.pendingRequests.delete(requestId);
                    // Reconstruct Set for allCategories
                    const post = payload.post;
                    post.allCategories = new Set(post.allCategories);
                    pending.resolve(post);
                }
                break;

            case 'SEEN_SYNC':
                // Update main thread seenPostIds for persistence
                window.seenPostIds = new Set(payload.seenPostIds);
                saveSeenPosts();
                break;

            case 'ERROR':
                console.error('Worker error:', payload.message);
                if (requestId) {
                    const pending = this.pendingRequests.get(requestId);
                    if (pending) {
                        this.pendingRequests.delete(requestId);
                        pending.reject(new Error(payload.message));
                    }
                }
                break;
        }
    }

    // Private: Handle worker errors
    _handleError(e) {
        console.error('Worker error:', e);
        // Reject all pending requests
        for (const [id, { reject }] of this.pendingRequests) {
            reject(new Error('Worker crashed'));
        }
        this.pendingRequests.clear();
    }

    // Private: Periodic score sync
    _startSyncTimer() {
        this.syncTimer = setInterval(() => {
            this.syncScores(categoryScores);
            this.requestSeenIds();
        }, 5000); // Every 5 seconds
    }

    // Cleanup
    terminate() {
        if (this.syncTimer) clearInterval(this.syncTimer);
        if (this.worker) this.worker.terminate();
    }
}

// Global instance
let algorithmWorker = null;
let useWorkerAlgorithm = false;
```

#### 3.1.2 Modify Data Loading to Initialize Worker

In the data loading section (after `pagesArr` is populated, ~line 3100):

```javascript
// After: pagesArr = data.pages;

// Initialize WebWorker for algorithm
algorithmWorker = new AlgorithmWorkerManager();
const workerInitState = {
    categoryScores,
    seenPostIds,
    categoryLastEngaged,
    hiddenCategories,
    reducedCategories,
    boostedCategories,
    exploredCategories,
    algorithmAggressiveness,
    exploreMode
};

algorithmWorker.init(pagesArr, workerInitState)
    .then(success => {
        useWorkerAlgorithm = success;
        console.log('Algorithm worker:', success ? 'enabled' : 'fallback mode');
    })
    .catch(err => {
        console.warn('Worker init failed:', err);
        useWorkerAlgorithm = false;
    });
```

#### 3.1.3 Create Async getNextPostAsync()

Add new function alongside existing `getNextPost()`:

```javascript
// Async wrapper for algorithm (worker or fallback)
async function getNextPostAsync() {
    if (useWorkerAlgorithm && algorithmWorker?.isReady) {
        try {
            return await algorithmWorker.getNextPost();
        } catch (err) {
            console.warn('Worker failed, falling back:', err);
            // Fall through to synchronous version
        }
    }
    // Fallback: original synchronous algorithm
    return getNextPost();
}
```

#### 3.1.4 Modify createNextPost() to be Async

Current (sync):
```javascript
function createNextPost() {
    const nextPost = getNextPost();
    // ... DOM creation
}
```

New (async with queue):
```javascript
let postCreationInProgress = false;
let pendingPostCreation = false;

async function createNextPost() {
    if (postCreationInProgress) {
        pendingPostCreation = true;
        return;
    }
    
    postCreationInProgress = true;
    
    try {
        const nextPost = await getNextPostAsync();
        
        // ... existing DOM creation code unchanged ...
        
    } finally {
        postCreationInProgress = false;
        
        // If another request came in while we were working, handle it
        if (pendingPostCreation) {
            pendingPostCreation = false;
            // Check if we still need more posts
            if (document.documentElement.scrollHeight < scrollY + innerHeight + 1500) {
                createNextPost();
            }
        }
    }
}
```

#### 3.1.5 Add Sync Hooks for State Changes

After `engagePost()` function, add sync call:

```javascript
// After modifying categoryScores in engagePost():
if (algorithmWorker) {
    algorithmWorker.syncScores(categoryScores);
}
```

Add similar hooks:
- After filter changes (hidden/reduced/boosted)
- After aggressiveness slider change
- After explore mode toggle
- On `refreshFeed()` call `algorithmWorker.reset()`

#### 3.1.6 Update refreshFeed()

```javascript
function refreshFeed() {
    // ... existing code ...
    
    // Reset worker state
    if (algorithmWorker) {
        algorithmWorker.reset();
    }
    
    // ... rest of function
}
```

---

## 4. Key Implementation Details

### 4.1 Worker Initialization and Data Transfer

**Timing:** Initialize worker immediately after `pagesArr` is populated during data load. This happens while the user is still on the start screen, so the ~1-2 second transfer is hidden.

**Data Preparation:**
```javascript
// Sets must be converted to Arrays for structured clone
const transferData = {
    pagesArr: pagesArr.map(p => ({
        ...p,
        allCategories: [...p.allCategories]  // Set → Array
    })),
    seenPostIds: [...seenPostIds],           // Set → Array
    // ... other Sets similarly
};
```

**Memory:** The data is cloned (not transferred), so both threads have a copy. This uses ~2x memory but keeps implementation simple and allows fallback.

### 4.2 Message Protocol Details

**Request/Response Matching:**
- Each `GET_NEXT_POST` includes a `requestId`
- `POST_READY` echoes the `requestId` for matching
- Pending requests stored in `Map<requestId, {resolve, reject}>`
- 5-second timeout prevents memory leaks

**Debounced Syncing:**
- Score sync: every 5 seconds (not on every engagement)
- Filter sync: immediate (important for UX)
- Settings sync: immediate

### 4.3 State Synchronization

**Main Thread Authoritative:**
- `categoryScores` - modified on main thread, synced to worker
- `hiddenCategories/reducedCategories/boostedCategories` - same
- `algorithmAggressiveness`, `exploreMode` - same

**Worker Tracks Internally:**
- `seenPostIds` - worker adds on selection, syncs back periodically
- `postsSinceRandom`, `lastTopCategory`, etc. - worker-only state

**Conflict Resolution:**
- On filter/settings change: worker clears prefetch queue
- On explicit sync: worker state is replaced, not merged

### 4.4 Async getNextPost() Replacement

**Non-Breaking Change:**
- Old `getNextPost()` remains unchanged (fallback)
- New `getNextPostAsync()` wraps it
- `createNextPost()` becomes async but maintains same behavior

**Queue Prevention:**
```javascript
// Prevent multiple simultaneous createNextPost calls
let postCreationInProgress = false;
let pendingPostCreation = false;
```

### 4.5 Prefetch Strategy

Worker maintains a queue of 3 pre-computed posts:
- Filled immediately after INIT
- Refilled after each GET_NEXT_POST
- Cleared when filters/settings change

This means most `GET_NEXT_POST` requests return instantly from the queue.

---

## 5. Test Strategy

### 5.1 E2E Tests (Existing - Should Pass Unchanged)

The existing Playwright tests should work without modification because:
- `createNextPost()` still produces the same DOM output
- Feed behavior is identical to users
- Async nature is transparent to selectors

**Verify:**
```bash
npm test
```

### 5.2 New Unit Tests for Worker Protocol

Create `tests/algorithm-worker.test.js`:

```javascript
describe('AlgorithmWorkerManager', () => {
    test('initializes without error', async () => {
        const worker = new AlgorithmWorkerManager();
        const success = await worker.init(mockPagesArr, mockState);
        expect(success).toBe(true);
    });

    test('returns valid post from getNextPost()', async () => {
        const worker = new AlgorithmWorkerManager();
        await worker.init(mockPagesArr, mockState);
        const post = await worker.getNextPost();
        expect(post).toHaveProperty('id');
        expect(post).toHaveProperty('title');
        expect(post.allCategories).toBeInstanceOf(Set);
    });

    test('respects filter changes', async () => {
        const worker = new AlgorithmWorkerManager();
        await worker.init(mockPagesArr, mockState);
        worker.syncFilters(new Set(['blocked-category']), new Set(), new Set());
        const post = await worker.getNextPost();
        expect(post.allCategories.has('blocked-category')).toBe(false);
    });

    test('handles timeout gracefully', async () => {
        // Test with deliberately slow worker
    });

    test('falls back to sync when worker unavailable', async () => {
        // Simulate Worker undefined
    });
});
```

### 5.3 Manual Testing Checklist

- [ ] Feed loads and scrolls without jank
- [ ] Like/More/Less buttons work correctly
- [ ] Explore mode toggle works
- [ ] Algorithm aggressiveness slider works
- [ ] Category filters (hide/reduce/boost) work
- [ ] Feed refresh works
- [ ] Session persistence works (reload page)
- [ ] Works on mobile (iOS Safari, Chrome)
- [ ] Works on slow device (throttle CPU in DevTools)
- [ ] Graceful degradation in IE11 / old browsers

### 5.4 Performance Verification

Add temporary logging:
```javascript
// In createNextPost()
const start = performance.now();
const nextPost = await getNextPostAsync();
console.log(`Post selection: ${(performance.now() - start).toFixed(2)}ms`);
```

**Expected Results:**
- First post: ~5-50ms (may wait for prefetch)
- Subsequent posts: <5ms (from prefetch queue)
- Main thread: no blocking during algorithm execution

---

## 6. Risks and Concerns

### 6.1 High Risk

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Memory doubling** (~400MB total) | High | Medium | Acceptable for modern devices. Document as known limitation. Consider SharedArrayBuffer in future. |
| **Initial transfer latency** (1-2s) | High | Low | Transfer during start screen. Show loading indicator if needed. |

### 6.2 Medium Risk

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Race condition: rapid filter changes** | Medium | Low | Worker clears prefetch queue on filter change. New posts selected with correct filters. |
| **State divergence: scores out of sync** | Medium | Low | 5-second sync interval. Main thread is authoritative. |
| **Worker crashes** | Low | Medium | Automatic fallback to synchronous algorithm. Error logging. |

### 6.3 Low Risk

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Browser compatibility** | Low | Low | WebWorker support: Chrome 4+, Firefox 3.5+, Safari 4+, Edge 12+. Only IE11 lacks support (not a target). |
| **Test flakiness** | Low | Low | E2E tests should be unaffected. New unit tests use mocks. |

### 6.4 Open Questions

1. **SharedArrayBuffer upgrade?** - Could reduce memory by ~50% but requires COOP/COEP headers. Defer to future optimization.

2. **Transferable ArrayBuffer?** - Could eliminate copy on init but requires complex serialization. Not worth complexity for one-time transfer.

3. **Worker restart on crash?** - Current design falls back to sync. Auto-restart could be added but may mask underlying issues.

4. **Prefetch depth tuning?** - Currently 3 posts. Could be configurable or adaptive based on scroll speed.

---

## 7. Implementation Phases

### Phase 1: Worker Shell (2-3 hours)
- Create `algorithm-worker.js`
- Port algorithm functions
- Implement INIT and GET_NEXT_POST handlers
- Basic message handling

### Phase 2: Main Thread Wiring (2-3 hours)
- Add `AlgorithmWorkerManager` class
- Initialize during data load
- Create `getNextPostAsync()`
- Modify `createNextPost()` to be async
- Add fallback handling

### Phase 3: State Synchronization (2-3 hours)
- Score sync with debouncing
- Filter sync (immediate)
- Settings sync (immediate)
- Seen posts sync (periodic)
- Reset handling for refresh

### Phase 4: Polish (1-2 hours)
- Prefetch queue implementation
- Error handling and logging
- Performance verification
- Browser compatibility testing

**Total: 7-11 hours**

---

## Appendix: Code Locations Reference

| Item | Current Location | Action |
|------|------------------|--------|
| `getNextPost()` | index.html:2790-2886 | Copy to worker |
| `getRandomPost()` | index.html:2770-2788 | Copy to worker |
| `markPostSeen()` | index.html:2764-2768 | Copy to worker |
| `getDecayFactor()` | index.html:1670-1678 | Copy to worker |
| `convertCat()` | index.html:1652-1656 | Copy to worker |
| `createNextPost()` | index.html:2388-2550 | Modify to async |
| `engagePost()` | index.html:2186-2199 | Add sync hook |
| `refreshFeed()` | index.html:3050-3070 | Add reset call |
| Data loading | index.html:~3100 | Add worker init |
