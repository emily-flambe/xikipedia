/**
 * Xikipedia Algorithm Worker
 *
 * Handles article selection algorithm off the main thread.
 * Receives full article dataset once, then processes requests.
 * Algorithm logic lives in algorithm.mjs (shared with main-thread fallback).
 */

import { createAlgorithm } from './algorithm.mjs';

// === STATE (owned by worker, passed to algorithm as live context) ===
const state = {
    pagesArr: [],
    categoryScores: {},
    seenPostIds: new Set(),
    categoryLastEngaged: {},
    hiddenCategories: new Set(),
    reducedCategories: new Set(),
    boostedCategories: new Set(),
    exploredCategories: new Set(),
    algorithmAggressiveness: 50,
    exploreMode: false,
};

const algorithm = createAlgorithm(state);

// Prefetch queue (holds ready-to-serve posts)
let prefetchQueue = [];
const PREFETCH_SIZE = 3;

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
            const post = algorithm.getNextPost();
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
                state.pagesArr = payload.pagesArr;
                state.categoryScores = payload.categoryScores || {};
                state.seenPostIds = new Set(payload.seenPostIds || []);
                state.categoryLastEngaged = payload.categoryLastEngaged || {};
                state.hiddenCategories = new Set(payload.hiddenCategories || []);
                state.reducedCategories = new Set(payload.reducedCategories || []);
                state.boostedCategories = new Set(payload.boostedCategories || []);
                state.exploredCategories = new Set(payload.exploredCategories || []);
                state.algorithmAggressiveness = payload.algorithmAggressiveness ?? 50;
                state.exploreMode = payload.exploreMode ?? false;

                // Convert allCategories back to Sets (lost in structured clone)
                state.pagesArr.forEach(p => {
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
                    post = serializePost(algorithm.getNextPost());
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
                state.categoryScores = payload.categoryScores || state.categoryScores;
                break;

            case 'UPDATE_FILTERS':
                if (payload.hidden) state.hiddenCategories = new Set(payload.hidden);
                if (payload.reduced) state.reducedCategories = new Set(payload.reduced);
                if (payload.boosted) state.boostedCategories = new Set(payload.boosted);
                // Clear prefetch queue - filters changed
                prefetchQueue = [];
                fillPrefetchQueue();
                break;

            case 'UPDATE_SETTINGS':
                if (payload.algorithmAggressiveness !== undefined) {
                    state.algorithmAggressiveness = payload.algorithmAggressiveness;
                }
                if (payload.exploreMode !== undefined) {
                    state.exploreMode = payload.exploreMode;
                }
                // Clear prefetch queue - settings changed
                prefetchQueue = [];
                fillPrefetchQueue();
                break;

            case 'MARK_SEEN':
                state.seenPostIds.add(payload.postId);
                break;

            case 'ENGAGE_CATEGORY':
                state.categoryLastEngaged[payload.category] = payload.timestamp;
                break;

            case 'SYNC_EXPLORED':
                state.exploredCategories = new Set(payload.exploredCategories || []);
                break;

            case 'RESET':
                // Clear seen markers and prefetch queue (for feed refresh)
                state.pagesArr.forEach(p => { delete p.seen; delete p.recommendedBecause; });
                prefetchQueue = [];
                algorithm.reset();
                // Note: exploredCategories persists across refresh (intentional)
                fillPrefetchQueue();
                self.postMessage({ type: 'READY' });
                break;

            case 'GET_SEEN_IDS':
                // Sync seen IDs back to main thread for persistence
                self.postMessage({
                    type: 'SEEN_SYNC',
                    payload: { seenPostIds: [...state.seenPostIds] }
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
