import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Tests for the shared algorithm module (public/algorithm.mjs).
 *
 * Playwright's route interception serves algorithm.mjs from the local
 * filesystem, so these tests are independent of the wrangler dev server.
 */

const ALGORITHM_MJS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../public/algorithm.mjs'
);

/**
 * Set up route interception so the browser can import /algorithm.mjs
 * directly from the local filesystem without the wrangler dev server.
 */
async function setupAlgorithmRoutes(page: any) {
  const algorithmContent = fs.readFileSync(ALGORITHM_MJS_PATH, 'utf8');

  await page.route('**/algorithm.mjs', async (route: any) => {
    await route.fulfill({
      contentType: 'text/javascript',
      body: algorithmContent,
    });
  });

  // Serve a minimal blank page as the navigation target
  await page.route('**/algo-test', async (route: any) => {
    await route.fulfill({
      contentType: 'text/html',
      body: '<html><body></body></html>',
    });
  });

  await page.goto('http://localhost:8788/algo-test');
}

test.describe('algorithm.mjs — createAlgorithm', () => {
  test('returns a post and marks it seen', async ({ page }) => {
    await setupAlgorithmRoutes(page);

    const result = await page.evaluate(async () => {
      const { createAlgorithm } = await import('/algorithm.mjs');

      const pages = Array.from({ length: 50 }, (_: unknown, i: number) => ({
        id: i + 1,
        title: `Article ${i + 1}`,
        text: `Text ${i + 1}`,
        thumb: null,
        chunkId: 0,
        allCategories: new Set(['science', 'nature']),
      }));

      const context = {
        pagesArr: pages,
        categoryScores: { science: 100 },
        seenPostIds: new Set<number>(),
        categoryLastEngaged: {} as Record<string, number>,
        hiddenCategories: new Set<string>(),
        reducedCategories: new Set<string>(),
        boostedCategories: new Set<string>(),
        exploredCategories: new Set<string>(),
        algorithmAggressiveness: 50,
        exploreMode: false,
      };

      const algo = createAlgorithm(context);
      const post = algo.getNextPost();

      return {
        hasPost: !!post,
        seenSize: context.seenPostIds.size,
        postSeen: post?.seen,
        hasId: typeof post?.id === 'number',
      };
    });

    expect(result.hasPost).toBe(true);
    expect(result.seenSize).toBe(1);
    expect(result.postSeen).toBe(1);
    expect(result.hasId).toBe(true);
  });

  test('explore mode always returns Serendipity label', async ({ page }) => {
    await setupAlgorithmRoutes(page);

    const result = await page.evaluate(async () => {
      const { createAlgorithm } = await import('/algorithm.mjs');

      const pages = Array.from({ length: 50 }, (_: unknown, i: number) => ({
        id: i + 1, title: `Article ${i + 1}`, text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['science']),
      }));

      const context = {
        pagesArr: pages, categoryScores: { science: 9999 },
        seenPostIds: new Set<number>(), categoryLastEngaged: {} as Record<string, number>,
        hiddenCategories: new Set<string>(), reducedCategories: new Set<string>(),
        boostedCategories: new Set<string>(), exploredCategories: new Set<string>(),
        algorithmAggressiveness: 50, exploreMode: true,
      };

      const algo = createAlgorithm(context);
      return Array.from({ length: 10 }, () => algo.getNextPost().recommendedBecause);
    });

    for (const rb of result) {
      expect(rb).toEqual(['🎲 Serendipity']);
    }
  });

  test('aggressiveness 0 returns Serendipity label', async ({ page }) => {
    await setupAlgorithmRoutes(page);

    const result = await page.evaluate(async () => {
      const { createAlgorithm } = await import('/algorithm.mjs');

      const pages = Array.from({ length: 50 }, (_: unknown, i: number) => ({
        id: i + 1, title: `Article ${i + 1}`, text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['science']),
      }));

      const context = {
        pagesArr: pages, categoryScores: { science: 9999 },
        seenPostIds: new Set<number>(), categoryLastEngaged: {} as Record<string, number>,
        hiddenCategories: new Set<string>(), reducedCategories: new Set<string>(),
        boostedCategories: new Set<string>(), exploredCategories: new Set<string>(),
        algorithmAggressiveness: 0, exploreMode: false,
      };

      const algo = createAlgorithm(context);
      return Array.from({ length: 5 }, () => algo.getNextPost().recommendedBecause);
    });

    for (const rb of result) {
      expect(rb).toEqual(['🎲 Serendipity']);
    }
  });

  test('serendipity fires within 15 posts at high aggressiveness', async ({ page }) => {
    await setupAlgorithmRoutes(page);

    const result = await page.evaluate(async () => {
      const { createAlgorithm } = await import('/algorithm.mjs');

      const pages = Array.from({ length: 100 }, (_: unknown, i: number) => ({
        id: i + 1, title: `Article ${i + 1}`, text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['science']),
      }));

      const context = {
        pagesArr: pages, categoryScores: { science: 9999 },
        seenPostIds: new Set<number>(), categoryLastEngaged: {} as Record<string, number>,
        hiddenCategories: new Set<string>(), reducedCategories: new Set<string>(),
        boostedCategories: new Set<string>(), exploredCategories: new Set<string>(),
        algorithmAggressiveness: 100, exploreMode: false,
      };

      const algo = createAlgorithm(context);
      const posts = Array.from({ length: 15 }, () => algo.getNextPost());
      return posts.filter((p: any) =>
        Array.isArray(p.recommendedBecause) && p.recommendedBecause[0] === '🎲 Serendipity'
      ).length;
    });

    // Threshold is 5-10; at least 1 serendipity post expected in 15 draws
    expect(result).toBeGreaterThanOrEqual(1);
  });

  test('boosted category appears more often than neutral', async ({ page }) => {
    await setupAlgorithmRoutes(page);

    const result = await page.evaluate(async () => {
      const { createAlgorithm } = await import('/algorithm.mjs');

      const boostedPages = Array.from({ length: 20 }, (_: unknown, i: number) => ({
        id: i + 1, title: `Boosted ${i + 1}`, text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['boosted-cat']),
      }));
      const neutralPages = Array.from({ length: 20 }, (_: unknown, i: number) => ({
        id: i + 21, title: `Neutral ${i + 1}`, text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['neutral-cat']),
      }));

      const context = {
        pagesArr: [...boostedPages, ...neutralPages],
        categoryScores: {},
        seenPostIds: new Set<number>(), categoryLastEngaged: {} as Record<string, number>,
        hiddenCategories: new Set<string>(), reducedCategories: new Set<string>(),
        boostedCategories: new Set(['boosted-cat']),
        exploredCategories: new Set<string>(),
        algorithmAggressiveness: 100, exploreMode: false,
      };

      const algo = createAlgorithm(context);
      let boostedCount = 0, neutralCount = 0;
      for (let i = 0; i < 30; i++) {
        const post = algo.getNextPost() as any;
        if (post.allCategories.has('boosted-cat')) boostedCount++;
        if (post.allCategories.has('neutral-cat')) neutralCount++;
      }
      return { boostedCount, neutralCount };
    });

    expect(result.boostedCount).toBeGreaterThan(result.neutralCount);
  });

  test('never returns the same post twice within unique pool', async ({ page }) => {
    await setupAlgorithmRoutes(page);

    const result = await page.evaluate(async () => {
      const { createAlgorithm } = await import('/algorithm.mjs');

      const pages = Array.from({ length: 30 }, (_: unknown, i: number) => ({
        id: i + 1, title: `Article ${i + 1}`, text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['science']),
      }));

      const context = {
        pagesArr: pages, categoryScores: { science: 100 },
        seenPostIds: new Set<number>(), categoryLastEngaged: {} as Record<string, number>,
        hiddenCategories: new Set<string>(), reducedCategories: new Set<string>(),
        boostedCategories: new Set<string>(), exploredCategories: new Set<string>(),
        algorithmAggressiveness: 50, exploreMode: false,
      };

      const algo = createAlgorithm(context);
      const ids: number[] = [];
      for (let i = 0; i < 20; i++) {
        ids.push((algo.getNextPost() as any).id);
      }
      return { total: ids.length, unique: new Set(ids).size };
    });

    expect(result.unique).toBe(result.total);
  });

  test('onMarkSeen callback fires once per post', async ({ page }) => {
    await setupAlgorithmRoutes(page);

    const result = await page.evaluate(async () => {
      const { createAlgorithm } = await import('/algorithm.mjs');

      const pages = Array.from({ length: 20 }, (_: unknown, i: number) => ({
        id: i + 1, title: `Article ${i + 1}`, text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['science']),
      }));

      let callbackCount = 0;
      const context = {
        pagesArr: pages, categoryScores: {},
        seenPostIds: new Set<number>(), categoryLastEngaged: {} as Record<string, number>,
        hiddenCategories: new Set<string>(), reducedCategories: new Set<string>(),
        boostedCategories: new Set<string>(), exploredCategories: new Set<string>(),
        algorithmAggressiveness: 50, exploreMode: false,
      };

      const algo = createAlgorithm(context, { onMarkSeen: () => { callbackCount++; } });
      algo.getNextPost();
      algo.getNextPost();
      algo.getNextPost();
      return callbackCount;
    });

    expect(result).toBe(3);
  });

  test('reset() clears serendipity counter', async ({ page }) => {
    await setupAlgorithmRoutes(page);

    const result = await page.evaluate(async () => {
      const { createAlgorithm } = await import('/algorithm.mjs');

      const pages = Array.from({ length: 100 }, (_: unknown, i: number) => ({
        id: i + 1, title: `Article ${i + 1}`, text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['science']),
      }));

      const context = {
        pagesArr: pages, categoryScores: { science: 100 },
        seenPostIds: new Set<number>(), categoryLastEngaged: {} as Record<string, number>,
        hiddenCategories: new Set<string>(), reducedCategories: new Set<string>(),
        boostedCategories: new Set<string>(), exploredCategories: new Set<string>(),
        algorithmAggressiveness: 100, exploreMode: false,
      };

      const algo = createAlgorithm(context);

      // Exhaust serendipity counter past max threshold (10)
      for (let i = 0; i < 11; i++) algo.getNextPost();

      // Reset private state and seen tracking
      algo.reset();
      context.seenPostIds.clear();
      (pages as any[]).forEach(p => { delete p.seen; });

      // After reset, postsSinceRandom = 0; first post increments to 1, threshold 5-10
      // So first post should NOT be serendipity
      const firstPost = algo.getNextPost() as any;
      return firstPost.recommendedBecause;
    });

    expect(result).not.toEqual(['🎲 Serendipity']);
  });

  test('noPageMaps fallback used for unknown page category', async ({ page }) => {
    await setupAlgorithmRoutes(page);

    const result = await page.evaluate(async () => {
      const { createAlgorithm } = await import('/algorithm.mjs');

      // A post whose only category is a page ref (p:999) not in pagesArr
      const pagePost = {
        id: 1, title: 'Test Post', text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['p:999']),
      };

      // Mark p:999 as explored to prevent random roulette boost from adding 🎰 prefix
      const context = {
        pagesArr: [pagePost], categoryScores: { 'p:999': 500 },
        seenPostIds: new Set<number>(), categoryLastEngaged: {} as Record<string, number>,
        hiddenCategories: new Set<string>(), reducedCategories: new Set<string>(),
        boostedCategories: new Set<string>(), exploredCategories: new Set<string>(['p:999']),
        algorithmAggressiveness: 100, exploreMode: false,
      };

      const algo = createAlgorithm(context, { noPageMaps: { '999': 'Fallback Name' } });
      const post = algo.getNextPost() as any;
      return post.recommendedBecause;
    });

    expect(result).toEqual(['Fallback Name']);
  });

  // ===== SCORING INTERNALS =====

  test('category affinity weight — high-score category dominates selection', async ({ page }) => {
    await setupAlgorithmRoutes(page);

    const result = await page.evaluate(async () => {
      const { createAlgorithm } = await import('/algorithm.mjs');

      const highScorePages = Array.from({ length: 40 }, (_: unknown, i: number) => ({
        id: i + 1, title: `High ${i + 1}`, text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['high-score-cat']),
      }));
      const lowScorePages = Array.from({ length: 40 }, (_: unknown, i: number) => ({
        id: i + 41, title: `Low ${i + 1}`, text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['low-score-cat']),
      }));

      const context = {
        pagesArr: [...highScorePages, ...lowScorePages],
        categoryScores: { 'high-score-cat': 10000, 'low-score-cat': 10 },
        seenPostIds: new Set<number>(),
        categoryLastEngaged: {} as Record<string, number>,
        hiddenCategories: new Set<string>(),
        reducedCategories: new Set<string>(),
        boostedCategories: new Set<string>(),
        exploredCategories: new Set(['high-score-cat', 'low-score-cat']),
        algorithmAggressiveness: 100,
        exploreMode: false,
      };

      const algo = createAlgorithm(context);
      let highCount = 0;
      let lowCount = 0;
      for (let i = 0; i < 40; i++) {
        const post = algo.getNextPost() as any;
        if (post.allCategories.has('high-score-cat')) highCount++;
        else lowCount++;
      }
      return { highCount, lowCount };
    });

    // With 1000x score difference, high-score posts should dominate heavily
    expect(result.highCount).toBeGreaterThan(result.lowCount * 2);
  });

  test('time-based decay — recently engaged category beats stale one', async ({ page }) => {
    await setupAlgorithmRoutes(page);

    const result = await page.evaluate(async () => {
      const { createAlgorithm } = await import('/algorithm.mjs');

      const recentPages = Array.from({ length: 30 }, (_: unknown, i: number) => ({
        id: i + 1, title: `Recent ${i + 1}`, text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['recent-cat']),
      }));
      const stalePages = Array.from({ length: 30 }, (_: unknown, i: number) => ({
        id: i + 31, title: `Stale ${i + 1}`, text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['stale-cat']),
      }));

      const context = {
        pagesArr: [...recentPages, ...stalePages],
        // Equal base scores — decay factor determines the winner
        categoryScores: { 'recent-cat': 5000, 'stale-cat': 5000 },
        seenPostIds: new Set<number>(),
        categoryLastEngaged: {
          'recent-cat': Date.now(),                         // now → decay ≈ 1.0
          'stale-cat': Date.now() - 48 * 60 * 60 * 1000,  // 48h ago → decay = 0.25%
        } as Record<string, number>,
        hiddenCategories: new Set<string>(),
        reducedCategories: new Set<string>(),
        boostedCategories: new Set<string>(),
        exploredCategories: new Set(['recent-cat', 'stale-cat']),
        algorithmAggressiveness: 100,
        exploreMode: false,
      };

      const algo = createAlgorithm(context);
      let recentCount = 0;
      let staleCount = 0;
      for (let i = 0; i < 30; i++) {
        const post = algo.getNextPost() as any;
        if (post.allCategories.has('recent-cat')) recentCount++;
        else staleCount++;
      }
      return { recentCount, staleCount };
    });

    // recent-cat decay ≈ 1.0, stale-cat decay ≈ Math.pow(0.5,48) ≈ 0.
    // Effective scores: ~5000 vs ~0. Recent should dominate overwhelmingly.
    expect(result.recentCount).toBeGreaterThan(result.staleCount * 3);
  });

  test('view penalty decay — posts with seen > 0 are strongly penalized', async ({ page }) => {
    await setupAlgorithmRoutes(page);

    const result = await page.evaluate(async () => {
      const { createAlgorithm } = await import('/algorithm.mjs');

      // Unseen posts — no penalty
      const freshPages = Array.from({ length: 20 }, (_: unknown, i: number) => ({
        id: i + 1, title: `Fresh ${i + 1}`, text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['cat-a']),
      }));
      // Posts with seen=2 but NOT in seenPostIds (edge case the algorithm guards against)
      const stalePages = Array.from({ length: 20 }, (_: unknown, i: number) => ({
        id: i + 21, title: `Stale ${i + 1}`, text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['cat-a']),
        seen: 2,
      }));

      const context = {
        pagesArr: [...freshPages, ...stalePages],
        categoryScores: { 'cat-a': 1000 },
        seenPostIds: new Set<number>(),
        categoryLastEngaged: {} as Record<string, number>,
        hiddenCategories: new Set<string>(),
        reducedCategories: new Set<string>(),
        boostedCategories: new Set<string>(),
        exploredCategories: new Set(['cat-a']),
        algorithmAggressiveness: 100,
        exploreMode: false,
      };

      const algo = createAlgorithm(context);
      const selectedIds: number[] = [];
      for (let i = 0; i < 15; i++) {
        selectedIds.push((algo.getNextPost() as any).id);
      }
      // fresh page ids: 1-20, stale page ids: 21-40
      return {
        freshCount: selectedIds.filter(id => id <= 20).length,
        staleCount: selectedIds.filter(id => id > 20).length,
      };
    });

    // seen=2 penalty: (3^2 - 1) * -500000 = -4,000,000. Fresh posts score ~500.
    // Score-based paths strongly favour fresh; a ~18% "default" path picks potentialPosts[0]
    // randomly regardless of score, so a few stale posts may appear. The key invariant is
    // that fresh posts are selected significantly more often than stale ones.
    expect(result.freshCount).toBeGreaterThan(result.staleCount);
  });

  // ===== CATEGORY ROULETTE =====

  test('category roulette — unexplored category occasionally gets 🎰 boost', async ({ page }) => {
    await setupAlgorithmRoutes(page);

    const result = await page.evaluate(async () => {
      const { createAlgorithm } = await import('/algorithm.mjs');

      // All posts have the same unexplored category
      const pages = Array.from({ length: 100 }, (_: unknown, i: number) => ({
        id: i + 1, title: `Article ${i + 1}`, text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['unexplored-cat']),
      }));

      const context = {
        pagesArr: pages,
        categoryScores: { 'unexplored-cat': 500 },
        seenPostIds: new Set<number>(),
        categoryLastEngaged: {} as Record<string, number>,
        hiddenCategories: new Set<string>(),
        reducedCategories: new Set<string>(),
        boostedCategories: new Set<string>(),
        // 'unexplored-cat' is NOT in exploredCategories, making it eligible for roulette
        exploredCategories: new Set<string>(),
        algorithmAggressiveness: 100,
        exploreMode: false,
      };

      const algo = createAlgorithm(context);
      const labels = Array.from({ length: 80 }, () => {
        const post = algo.getNextPost() as any;
        return post.recommendedBecause?.[0] ?? null;
      });
      return labels.filter((l: string | null) => l?.startsWith('🎰')).length;
    });

    // 10% roulette chance per post × 80 draws: P(≥1) ≈ 99.99%
    // Post must also have the roulette category — here all do.
    expect(result).toBeGreaterThan(0);
  });

  // ===== VARIETY ENFORCEMENT =====

  test('variety enforcement — overexposed category is penalized after 2 consecutive posts', async ({ page }) => {
    await setupAlgorithmRoutes(page);

    const result = await page.evaluate(async () => {
      const { createAlgorithm } = await import('/algorithm.mjs');

      // Category A: score 200. With decay 0.5, effective ≈ 100.
      // After variety penalty: 100 - 5000 = -4900.
      // Category B: no score (0). B wins over penalized A.
      const aPosts = Array.from({ length: 30 }, (_: unknown, i: number) => ({
        id: i + 1, title: `A-${i}`, text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['dominant-cat']),
      }));
      const bPosts = Array.from({ length: 30 }, (_: unknown, i: number) => ({
        id: i + 31, title: `B-${i}`, text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['other-cat']),
      }));

      const context = {
        pagesArr: [...aPosts, ...bPosts],
        categoryScores: { 'dominant-cat': 200 },
        seenPostIds: new Set<number>(),
        categoryLastEngaged: {} as Record<string, number>,
        hiddenCategories: new Set<string>(),
        reducedCategories: new Set<string>(),
        boostedCategories: new Set<string>(),
        exploredCategories: new Set(['dominant-cat', 'other-cat']),
        algorithmAggressiveness: 100,
        exploreMode: false,
      };

      const algo = createAlgorithm(context);
      const posts = Array.from({ length: 25 }, () => algo.getNextPost() as any);
      return {
        aCount: posts.filter(p => p.allCategories.has('dominant-cat')).length,
        bCount: posts.filter(p => p.allCategories.has('other-cat')).length,
      };
    });

    // Without variety enforcement, dominant-cat (200 score) would always beat other-cat (0).
    // Variety enforcement kicks in after 2 consecutive dominant-cat posts,
    // making other-cat (0) beat penalized dominant-cat (100 - 5000 = -4900).
    expect(result.bCount).toBeGreaterThan(0);
  });

  // ===== EDGE CASES =====

  test('edge case: empty categoryScores map returns a post', async ({ page }) => {
    await setupAlgorithmRoutes(page);

    const result = await page.evaluate(async () => {
      const { createAlgorithm } = await import('/algorithm.mjs');

      const pages = Array.from({ length: 20 }, (_: unknown, i: number) => ({
        id: i + 1, title: `Article ${i + 1}`, text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['cat-a']),
      }));

      const context = {
        pagesArr: pages,
        categoryScores: {},  // No scores at all
        seenPostIds: new Set<number>(),
        categoryLastEngaged: {} as Record<string, number>,
        hiddenCategories: new Set<string>(),
        reducedCategories: new Set<string>(),
        boostedCategories: new Set<string>(),
        exploredCategories: new Set<string>(),
        algorithmAggressiveness: 50,
        exploreMode: false,
      };

      const algo = createAlgorithm(context);
      const posts = Array.from({ length: 5 }, () => algo.getNextPost());
      return posts.map(p => (p as any).id);
    });

    expect(result).toHaveLength(5);
    expect(result.every((id: number) => typeof id === 'number')).toBe(true);
  });

  test('edge case: all posts already seen falls back gracefully', async ({ page }) => {
    await setupAlgorithmRoutes(page);

    const result = await page.evaluate(async () => {
      const { createAlgorithm } = await import('/algorithm.mjs');

      const pages = Array.from({ length: 5 }, (_: unknown, i: number) => ({
        id: i + 1, title: `Article ${i + 1}`, text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['cat-a']),
      }));

      // Pre-populate seenPostIds with every post
      const seenPostIds = new Set<number>(pages.map(p => p.id));

      const context = {
        pagesArr: pages,
        categoryScores: { 'cat-a': 100 },
        seenPostIds,
        categoryLastEngaged: {} as Record<string, number>,
        hiddenCategories: new Set<string>(),
        reducedCategories: new Set<string>(),
        boostedCategories: new Set<string>(),
        exploredCategories: new Set<string>(),
        algorithmAggressiveness: 100,
        exploreMode: false,
      };

      const algo = createAlgorithm(context);
      // Should not throw even when all posts are seen
      const post = algo.getNextPost() as any;
      return { hasPost: !!post, hasId: typeof post?.id === 'number' };
    });

    expect(result.hasPost).toBe(true);
    expect(result.hasId).toBe(true);
  });

  test('edge case: single-category post pool — returns posts correctly', async ({ page }) => {
    await setupAlgorithmRoutes(page);

    const result = await page.evaluate(async () => {
      const { createAlgorithm } = await import('/algorithm.mjs');

      // All posts in a single category
      const pages = Array.from({ length: 50 }, (_: unknown, i: number) => ({
        id: i + 1, title: `Article ${i + 1}`, text: '', thumb: null, chunkId: 0,
        allCategories: new Set(['only-cat']),
      }));

      const context = {
        pagesArr: pages,
        categoryScores: { 'only-cat': 500 },
        seenPostIds: new Set<number>(),
        categoryLastEngaged: {} as Record<string, number>,
        hiddenCategories: new Set<string>(),
        reducedCategories: new Set<string>(),
        boostedCategories: new Set<string>(),
        exploredCategories: new Set<string>(),
        algorithmAggressiveness: 50,
        exploreMode: false,
      };

      const algo = createAlgorithm(context);
      const ids: number[] = [];
      for (let i = 0; i < 20; i++) {
        ids.push((algo.getNextPost() as any).id);
      }
      return { total: ids.length, unique: new Set(ids).size, allInRange: ids.every(id => id >= 1 && id <= 50) };
    });

    expect(result.total).toBe(20);
    expect(result.unique).toBe(20);  // no repeats
    expect(result.allInRange).toBe(true);
  });
});
