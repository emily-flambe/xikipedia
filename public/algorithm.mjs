/**
 * Xikipedia Algorithm - Shared Module
 *
 * Exports createAlgorithm(context, options) — a factory for the recommendation
 * algorithm used by both the main thread (fallback) and the algorithm worker.
 *
 * @param {object} context - Live state shared with the caller. Must expose:
 *   pagesArr, categoryScores, seenPostIds (Set), categoryLastEngaged,
 *   hiddenCategories (Set), reducedCategories (Set), boostedCategories (Set),
 *   exploredCategories (Set), algorithmAggressiveness, exploreMode.
 *   The algorithm reads and mutates these directly (e.g. seenPostIds.add).
 *
 * @param {object} [options]
 * @param {function|null} [options.onMarkSeen] - Called after a post is marked
 *   seen; use for persistence side-effects (e.g. saveSeenPosts on main thread).
 * @param {object} [options.noPageMaps] - Fallback display names for page IDs.
 *
 * @returns {{ getNextPost, getRandomPost, reset }}
 */
export function createAlgorithm(context, options = {}) {
    const { onMarkSeen = null, noPageMaps = {} } = options;

    // === PRIVATE ALGORITHM STATE ===
    let postsSinceRandom = 0;
    let lastTopCategory = null;
    let consecutiveSameCategory = 0;

    // === HELPER: Convert category ID to display name ===
    function convertCat(cat) {
        if (!cat) return cat;
        if (cat.startsWith('p:')) {
            const id = cat.slice(2);
            const page = context.pagesArr.find(e => e.id == id);
            return page?.title ?? noPageMaps[id] ?? cat;
        }
        return cat.charAt(0).toUpperCase() + cat.slice(1).toLowerCase();
    }

    // === ALGORITHM: Time-based decay ===
    function getDecayFactor(category) {
        const lastEngaged = context.categoryLastEngaged[category];
        if (!lastEngaged) return 0.5; // Never engaged = 50% weight
        const ageMs = Date.now() - lastEngaged;
        const ageHours = ageMs / (1000 * 60 * 60);
        // Decay: starts at 1.0, halves every hour, floor at 0.1
        return Math.max(0.1, Math.pow(0.5, ageHours));
    }

    // === ALGORITHM: Mark post as seen ===
    function markPostSeen(post) {
        context.seenPostIds.add(post.id);
        post.seen = (post.seen ?? 0) + 1;
        if (onMarkSeen) onMarkSeen(post);
    }

    // === ALGORITHM: Random unseen post ===
    function isHiddenPost(post) {
        if (context.hiddenCategories.size === 0) return false;
        const contentCats = [...post.allCategories].filter(c => !c.startsWith('p:'));
        if (contentCats.length === 0) return false;
        return contentCats.every(c => context.hiddenCategories.has(c));
    }

    function getRandomPost() {
        for (let i = 0; i < 1000; i++) {
            const randomPost = context.pagesArr[Math.floor(Math.random() * context.pagesArr.length)];
            if (!context.seenPostIds.has(randomPost.id) && !isHiddenPost(randomPost)) {
                markPostSeen(randomPost);
                randomPost.recommendedBecause = ['🎲 Serendipity'];
                return randomPost;
            }
        }
        // Fallback: if we've seen everything, allow repeat (but still respect hidden)
        for (let i = 0; i < 1000; i++) {
            const randomPost = context.pagesArr[Math.floor(Math.random() * context.pagesArr.length)];
            if (!isHiddenPost(randomPost)) {
                console.warn('Exhausted unique posts, allowing repeat');
                markPostSeen(randomPost);
                randomPost.recommendedBecause = ['🎲 Serendipity'];
                return randomPost;
            }
        }
        // True fallback: everything is hidden or seen
        console.warn('Exhausted all posts including hidden filter');
        const randomPost = context.pagesArr[Math.floor(Math.random() * context.pagesArr.length)];
        markPostSeen(randomPost);
        randomPost.recommendedBecause = ['🎲 Serendipity'];
        return randomPost;
    }

    // === ALGORITHM: Main selection ===
    function getNextPost() {
        // Explore mode OR aggressiveness 0: return purely random post
        if (context.exploreMode || context.algorithmAggressiveness === 0) {
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
            const allCats = new Set();
            context.pagesArr.slice(0, 1000).forEach(p => p.allCategories?.forEach(c => allCats.add(c)));
            const unexplored = [...allCats].filter(c =>
                !context.exploredCategories.has(c) &&
                !context.hiddenCategories.has(c) &&
                c !== 'given names' && c !== 'surnames'
            );
            if (unexplored.length > 0) {
                rouletteBoostCategory = unexplored[Math.floor(Math.random() * unexplored.length)];
            }
        }

        // Scale category influence by aggressiveness (50 = normal, 100 = 2x, 25 = 0.5x)
        const aggFactor = context.algorithmAggressiveness / 50;

        const potentialPosts = [...Array(10000)]
            .map(() => context.pagesArr[Math.floor(Math.random() * context.pagesArr.length)])
            // Hard block: filter out already-seen posts
            .filter(post => !context.seenPostIds.has(post.id))
            // Filter out posts where ALL non-page categories are hidden
            .filter(post => {
                if (context.hiddenCategories.size === 0) return true;
                const contentCats = [...post.allCategories].filter(c => !c.startsWith('p:'));
                if (contentCats.length === 0) return true;
                return contentCats.some(c => !context.hiddenCategories.has(c));
            })
            .map(post => {
                // Stronger penalty (10x) as backup for any edge cases
                const initialScore = (post.thumb ? 5 : 0) + (3 ** (post.seen ?? 0) - 1) * -500000;
                let postScore = [...post.allCategories].reduce(
                    (sum, cat) => {
                        // Skip hidden categories entirely — they contribute no score
                        if (context.hiddenCategories.has(cat)) return sum;

                        // Apply time-based decay to category score
                        const baseScore = (context.categoryScores[cat] ?? 0) * aggFactor;
                        let catScore = baseScore * getDecayFactor(cat);

                        // === USER CATEGORY FILTERS ===
                        // Boosted categories get 3x score bonus
                        if (context.boostedCategories.has(cat)) {
                            catScore += 2000;
                        }
                        // Reduced categories get 75% penalty
                        if (context.reducedCategories.has(cat)) {
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

        // If all sampled posts were filtered out, sample more aggressively
        if (potentialPosts.length === 0) {
            console.warn('All sampled posts filtered, trying harder...');
            for (let i = 0; i < 10000; i++) {
                const randomPost = context.pagesArr[Math.floor(Math.random() * context.pagesArr.length)];
                if (context.seenPostIds.has(randomPost.id)) continue;
                // Apply hidden category filter in fallback too
                if (context.hiddenCategories.size > 0) {
                    const contentCats = [...randomPost.allCategories].filter(c => !c.startsWith('p:'));
                    if (contentCats.length > 0 && contentCats.every(c => context.hiddenCategories.has(c))) continue;
                }
                markPostSeen(randomPost);
                return randomPost;
            }
            // True fallback - everything seen/hidden
            const randomPost = context.pagesArr[Math.floor(Math.random() * context.pagesArr.length)];
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

        // Track top contributing categories for transparency (exclude hidden)
        const categoryContributions = [...bestPost.allCategories]
            .filter(cat => !context.hiddenCategories.has(cat))
            .map(cat => ({ cat, score: context.categoryScores[cat] || 0 }))
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

    // Reset private algorithm state (call after feed refresh)
    function reset() {
        postsSinceRandom = 0;
        lastTopCategory = null;
        consecutiveSameCategory = 0;
    }

    return { getNextPost, getRandomPost, reset };
}
