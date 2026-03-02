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

      const context = {
        pagesArr: [pagePost], categoryScores: { 'p:999': 500 },
        seenPostIds: new Set<number>(), categoryLastEngaged: {} as Record<string, number>,
        hiddenCategories: new Set<string>(), reducedCategories: new Set<string>(),
        boostedCategories: new Set<string>(), exploredCategories: new Set<string>(),
        algorithmAggressiveness: 100, exploreMode: false,
      };

      const algo = createAlgorithm(context, { noPageMaps: { '999': 'Fallback Name' } });
      const post = algo.getNextPost() as any;
      return post.recommendedBecause;
    });

    expect(result).toEqual(['Fallback Name']);
  });
});
