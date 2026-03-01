/**
 * Xikipedia Algorithm Worker
 * 
 * Handles article selection algorithm off the main thread.
 * Receives full article dataset once, then processes requests.
 */

'use strict';

// === STATE (owned by worker) ===
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

// Variety enforcement state
let postsSinceRandom = 0;
let lastTopCategory = null;
let consecutiveSameCategory = 0;

// Prefetch queue (holds ready-to-serve posts)
let prefetchQueue = [];
const PREFETCH_SIZE = 3;

// === HELPER: Convert category to display name ===
function convertCat(cat) {
    if (!cat) return cat;
    if (cat.startsWith("p:")) {
        cat = cat.slice(2);
        const page = pagesArr.find(e => e.id == cat);
        return page?.title ?? cat;
    }
    return cat.charAt(0).toUpperCase() + cat.slice(1).toLowerCase();
}

// === ALGORITHM: Time-based decay ===
function getDecayFactor(category) {
    const lastEngaged = categoryLastEngaged[category];
    if (!lastEngaged) return 0.5; // Never engaged = 50% weight
    const ageMs = Date.now() - lastEngaged;
    const ageHours = ageMs / (1000 * 60 * 60);
    // Decay: starts at 1.0, halves every hour, floor at 0.1
    return Math.max(0.1, Math.pow(0.5, ageHours));
}

// === ALGORITHM: Mark post as seen ===
function markPostSeen(post) {
    seenPostIds.add(post.id);
    post.seen = (post.seen ?? 0) + 1;
    // Note: saveSeenPosts() happens on main thread via periodic sync
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
    // Fallback: if we've seen everything, allow repeat
    console.warn('Exhausted unique posts, allowing repeat');
    const randomPost = pagesArr[Math.floor(Math.random() * pagesArr.length)];
    markPostSeen(randomPost);
    randomPost.recommendedBecause = ['🎲 Serendipity'];
    return randomPost;
}

// === ALGORITHM: Main selection (ported from index.html) ===
function getNextPost() {
    // Explore mode OR aggressiveness 0: return purely random post
    if (exploreMode || algorithmAggressiveness === 0) {
        return getRandomPost();
    }

    // === SERENDIPITY INJECTION ===
    // Every 5-10 posts, inject a random one to break filter bubbles
    postsSinceRandom++;
    const serendipityThreshold = 5 + Math.floor(Math.random() * 6); // 5-10
    if (postsSinceRandom >= serendipityThreshold) {
        postsSinceRandom = 0;
        return getRandomPost();
    }

    // === VARIETY ENFORCEMENT ===
    // Penalize if we've had 2+ posts from the same dominant category
    let varietyPenaltyCategory = null;
    if (consecutiveSameCategory >= 2 && lastTopCategory) {
        varietyPenaltyCategory = lastTopCategory;
    }

    // === CATEGORY ROULETTE ===
    // 10% chance to boost a random unexplored category
    let rouletteBoostCategory = null;
    if (Math.random() < 0.1) {
        // Find categories we haven't engaged with yet
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

    // Scale category influence by aggressiveness (50 = normal, 100 = 2x, 25 = 0.5x)
    const aggFactor = algorithmAggressiveness / 50;

    const potentialPosts = [...Array(10000)]
        .map(() => pagesArr[Math.floor(Math.random() * pagesArr.length)])
        // Hard block: filter out already-seen posts
        .filter(post => !seenPostIds.has(post.id))
        .map(post => {
            // Stronger penalty (10x) as backup for any edge cases
            const initialScore = (post.thumb ? 5 : 0) + (3 ** (post.seen ?? 0) - 1) * -500000;
            let postScore = [...post.allCategories].reduce(
                (sum, cat) => {
                    // Apply time-based decay to category score
                    const baseScore = (categoryScores[cat] ?? 0) * aggFactor;
                    let catScore = baseScore * getDecayFactor(cat);
                    
                    // === USER CATEGORY FILTERS ===
                    // Boosted categories get 3x score bonus
                    if (boostedCategories.has(cat)) {
                        catScore += 2000;
                    }
                    // Reduced categories get 75% penalty
                    if (reducedCategories.has(cat)) {
                        catScore -= 1500;
                    }
                    
                    // Variety: penalize overexposed category
                    if (cat === varietyPenaltyCategory) {
                        catScore -= 5000;
                    }
                    
                    // Roulette: boost unexplored category
                    if (cat === rouletteBoostCategory) {
                        catScore += 3000;
                    }
                    
                    return sum + catScore;
                },
                initialScore
            );
            post.score = postScore;
            return post;
        });

    // If all sampled posts were seen, sample more aggressively
    if (potentialPosts.length === 0) {
        console.warn('All sampled posts seen, trying harder...');
        for (let i = 0; i < 10000; i++) {
            const randomPost = pagesArr[Math.floor(Math.random() * pagesArr.length)];
            if (!seenPostIds.has(randomPost.id)) {
                markPostSeen(randomPost);
                return randomPost;
            }
        }
        // True fallback - everything seen
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

    // Track top contributing categories for transparency
    const categoryContributions = [...bestPost.allCategories]
        .map(cat => ({ cat, score: categoryScores[cat] || 0 }))
        .filter(c => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

    if (categoryContributions.length > 0) {
        bestPost.recommendedBecause = categoryContributions.map(c => convertCat(c.cat));
        
        // Track for variety enforcement
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

    // Roulette feedback
    if (rouletteBoostCategory && bestPost.allCategories.has(rouletteBoostCategory)) {
        bestPost.recommendedBecause = ['🎰 ' + convertCat(rouletteBoostCategory)];
    }

    return bestPost;
}

// === SERIALIZE: Prepare post for transfer (Sets → Arrays) ===
function serializePost(post) {
    return {
        id: post.id,
        title: post.title,
        text: post.text,
        thumb: post.thumb,
        chunkId: post.chunkId,  // Include chunkId for chunked format
        allCategories: [...post.allCategories],
        recommendedBecause: post.recommendedBecause,
        score: post.score
    };
}

// === PREFETCH HINTS: Get unique chunkIds from prefetch queue ===
function getUpcomingChunkIds() {
    const chunkIds = new Set();
    for (const post of prefetchQueue) {
        if (post.chunkId !== undefined && post.chunkId !== null) {
            chunkIds.add(post.chunkId);
        }
    }
    return [...chunkIds];
}

// === PREFETCH: Fill queue with upcoming posts ===
function fillPrefetchQueue() {
    while (prefetchQueue.length < PREFETCH_SIZE) {
        try {
            const post = getNextPost();
            prefetchQueue.push(serializePost(post));
        } catch (err) {
            console.error('Error filling prefetch queue:', err);
            break;
        }
    }
}

// === MESSAGE HANDLER ===
self.onmessage = function(e) {
    const { type, payload, requestId } = e.data;

    try {
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

                // Convert allCategories back to Sets (lost in structured clone)
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
                
                // Refill queue first so we can report upcoming chunks
                fillPrefetchQueue();
                
                self.postMessage({
                    type: 'POST_READY',
                    requestId,
                    payload: {
                        post,
                        prefetchAvailable: prefetchQueue.length,
                        upcomingChunks: getUpcomingChunkIds()  // Hint for chunk prefetching
                    }
                });
                break;

            case 'PREFETCH':
                fillPrefetchQueue();
                self.postMessage({
                    type: 'PREFETCH_READY',
                    payload: { 
                        count: prefetchQueue.length,
                        upcomingChunks: getUpcomingChunkIds()  // Include chunk hints
                    }
                });
                break;

            case 'GET_UPCOMING_CHUNKS':
                // Explicit request for chunk IDs in prefetch queue
                self.postMessage({
                    type: 'UPCOMING_CHUNKS',
                    requestId,
                    payload: { 
                        chunkIds: getUpcomingChunkIds(),
                        queueSize: prefetchQueue.length
                    }
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
                // Clear seen markers and prefetch queue (for feed refresh)
                pagesArr.forEach(p => { delete p.seen; delete p.recommendedBecause; });
                prefetchQueue = [];
                postsSinceRandom = 0;
                lastTopCategory = null;
                consecutiveSameCategory = 0;
                // Note: exploredCategories persists across refresh (intentional)
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
    } catch (err) {
        console.error('Worker error:', err);
        self.postMessage({
            type: 'ERROR',
            requestId,
            payload: { message: err.message || 'Unknown worker error' }
        });
    }
};
