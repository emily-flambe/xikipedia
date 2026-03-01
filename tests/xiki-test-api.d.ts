/**
 * TypeScript interface for the xikipedia test API.
 * Only available on localhost (dev/test environments).
 * Gated behind `if (location.hostname === 'localhost')` in index.html.
 */
interface XikiTestAPI {
  readonly categoryScores: Record<string, number>;
  readonly hiddenCategories: Set<string>;
  readonly pagesArr: Array<{
    title: string;
    id: number;
    seen: number;
    categories: string[];
    [key: string]: unknown;
  }>;
  readonly seenPostIds: Set<number>;
  readonly isChunkedFormat: boolean;
  readonly chunkCache: {
    get(chunkId: number): unknown;
    set(chunkId: number, data: unknown): void;
    has(chunkId: number): boolean;
    getArticleText(pageId: number | string, chunkId: number): string | undefined;
    getStats(): { chunksLoaded: number; maxChunks: number; totalArticlesCached: number };
    reduceSize(targetChunks?: number): void;
  } | null;
  readonly chunkFetcher: {
    fetchChunk(chunkId: number): Promise<void>;
    getArticleText(pageId: number | string, chunkId: number): Promise<string | undefined>;
  } | null;
  getDataFormat(): string;
  algorithmAggressiveness: number;
  clearSeenPosts(): void;
  readonly postsWithoutLike: number;
  refreshFeed(): void;
  readonly viewedHistory: unknown[];
  exploreMode: boolean;
  readonly algorithmWorker: Worker | null;
  readonly useWorkerAlgorithm: boolean;
  convertCat(cat: string): string;
  updateEngagement(): void;
}

declare global {
  interface Window {
    __xikiTest?: XikiTestAPI;
  }
}

export {};
