#!/usr/bin/env node
/**
 * Xikipedia Chunked Data Generator
 * 
 * Processes English Wikipedia dumps to generate:
 * 1. index.json - Lightweight article index (~80-100MB compressed)
 * 2. articles/chunk-NNNNNN.json - Chunked article content files
 * 
 * Usage: 
 *   node scripts/generate-chunked-data.mjs --dump /path/to/enwiki-pages-articles.xml.bz2
 *   node scripts/generate-chunked-data.mjs --resume  # Resume from checkpoint
 *   node scripts/generate-chunked-data.mjs --test    # Test with 10K articles
 * 
 * Prerequisites:
 *   - Download enwiki-latest-pages-articles.xml.bz2 from dumps.wikimedia.org (~21GB)
 *   - Install bzip2/bunzip2 for decompression (usually pre-installed on Linux/Mac)
 *   - ~50GB free disk space for output
 * 
 * Output:
 *   public/full-wiki/index.json
 *   public/full-wiki/articles/chunk-000000.json
 *   public/full-wiki/articles/chunk-000001.json
 *   ...
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createBrotliCompress, constants as zlibConstants } from 'zlib';

import {
  WikiDumpParser,
  createDecompressStream,
  extractPlainText,
  extractThumbnail,
  extractCategories,
  hashThumbFilename,
  ProgressReporter
} from './lib/wiki-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'public', 'full-wiki');
const ARTICLES_DIR = path.join(OUTPUT_DIR, 'articles');
const CHECKPOINT_PATH = path.join(OUTPUT_DIR, 'checkpoint.json');
const INDEX_PATH = path.join(OUTPUT_DIR, 'index.json');

// Configuration
const CHUNK_SIZE = 10000;  // Articles per chunk
const VERSION = '2.0.0';
const MAX_ARTICLES = null; // Set to number for testing (e.g., 10000)
const TEXT_MAX_LENGTH = 500;

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  dump: null,
  resume: false,
  test: false,
  testLimit: 10000,
  compress: true,
  compressionLevel: 6 // Brotli level for chunks (11 for index)
};

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--dump':
    case '-d':
      options.dump = args[++i];
      break;
    case '--resume':
    case '-r':
      options.resume = true;
      break;
    case '--test':
    case '-t':
      options.test = true;
      break;
    case '--test-limit':
      options.testLimit = parseInt(args[++i], 10);
      break;
    case '--no-compress':
      options.compress = false;
      break;
    case '--help':
    case '-h':
      printUsage();
      process.exit(0);
  }
}

function printUsage() {
  console.log(`
Xikipedia Chunked Data Generator

Usage:
  node generate-chunked-data.mjs --dump <path>   Process Wikipedia dump file
  node generate-chunked-data.mjs --resume        Resume from checkpoint
  node generate-chunked-data.mjs --test          Process only ${options.testLimit} articles

Options:
  --dump, -d <path>     Path to Wikipedia dump file (xml.bz2)
  --resume, -r          Resume from last checkpoint
  --test, -t            Test mode (limit to ${options.testLimit} articles)
  --test-limit <n>      Set test mode article limit
  --no-compress         Skip Brotli compression
  --help, -h            Show this help

Example:
  # Download dump (21GB)
  wget https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-pages-articles.xml.bz2

  # Generate data (takes several hours)
  node generate-chunked-data.mjs --dump enwiki-latest-pages-articles.xml.bz2

  # Test with small subset
  node generate-chunked-data.mjs --dump enwiki-dump.xml.bz2 --test
`);
}

/**
 * State management for checkpoint/resume
 */
class GeneratorState {
  constructor() {
    this.pages = [];           // [title, pageId, chunkId, thumbHash, categories]
    this.chunks = new Map();   // chunkId → { articles: { pageId: {text, thumb} } }
    this.subCategories = {};   // category → [subcategories]
    this.noPageMaps = {};      // pageId → lowercase title
    this.categorySet = new Set();
    
    this.articleCount = 0;
    this.lastPageId = 0;
    this.writtenChunks = new Set();
  }
  
  /**
   * Save checkpoint to disk
   */
  saveCheckpoint() {
    const checkpoint = {
      timestamp: new Date().toISOString(),
      articleCount: this.articleCount,
      lastPageId: this.lastPageId,
      writtenChunks: Array.from(this.writtenChunks),
      pagesLength: this.pages.length,
      categoriesCount: this.categorySet.size
    };
    
    writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2));
    console.log(`Checkpoint saved: ${this.articleCount} articles processed`);
  }
  
  /**
   * Load checkpoint from disk
   */
  loadCheckpoint() {
    if (!existsSync(CHECKPOINT_PATH)) {
      return null;
    }
    
    try {
      const checkpoint = JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8'));
      console.log(`Loaded checkpoint from ${checkpoint.timestamp}`);
      console.log(`  Articles: ${checkpoint.articleCount}, Last pageId: ${checkpoint.lastPageId}`);
      
      this.articleCount = checkpoint.articleCount;
      this.lastPageId = checkpoint.lastPageId;
      this.writtenChunks = new Set(checkpoint.writtenChunks);
      
      return checkpoint;
    } catch (err) {
      console.error('Failed to load checkpoint:', err.message);
      return null;
    }
  }
  
  /**
   * Add a processed article
   */
  addArticle(page) {
    const { title, pageId, wikitext } = page;
    
    // Extract data from wikitext
    const text = extractPlainText(wikitext, TEXT_MAX_LENGTH);
    if (!text || text.length < 50) return false; // Skip very short articles
    
    const thumb = extractThumbnail(wikitext);
    const categories = extractCategories(wikitext);
    const chunkId = Math.floor(pageId / CHUNK_SIZE);
    const thumbHash = hashThumbFilename(thumb);
    
    // Add to index (tuple format)
    this.pages.push([title, pageId, chunkId, thumbHash, categories]);
    
    // Add to chunk data
    if (!this.chunks.has(chunkId)) {
      this.chunks.set(chunkId, { articles: {} });
    }
    const chunk = this.chunks.get(chunkId);
    chunk.articles[pageId] = { text };
    if (thumb) chunk.articles[pageId].thumb = thumb;
    
    // Track categories
    for (const cat of categories) {
      this.categorySet.add(cat);
    }
    
    // Add to noPageMaps
    this.noPageMaps[pageId] = title.toLowerCase();
    
    this.articleCount++;
    this.lastPageId = pageId;
    
    return true;
  }
  
  /**
   * Build category hierarchy (subcategories)
   * This is a simplified version - full hierarchy would require category dump
   */
  buildCategoryHierarchy() {
    // Group categories by common prefixes/patterns
    const categories = Array.from(this.categorySet).sort();
    
    // For now, create simple parent-child relationships based on naming patterns
    // e.g., "american physicists" → parent: "physicists", "american people"
    for (const cat of categories) {
      const parts = cat.split(' ');
      if (parts.length >= 2) {
        // Last word often is the broader category
        const lastWord = parts[parts.length - 1];
        if (this.categorySet.has(lastWord)) {
          if (!this.subCategories[lastWord]) {
            this.subCategories[lastWord] = [];
          }
          if (!this.subCategories[lastWord].includes(cat)) {
            this.subCategories[lastWord].push(cat);
          }
        }
        
        // Also try without first adjective
        const withoutFirst = parts.slice(1).join(' ');
        if (this.categorySet.has(withoutFirst)) {
          if (!this.subCategories[withoutFirst]) {
            this.subCategories[withoutFirst] = [];
          }
          if (!this.subCategories[withoutFirst].includes(cat)) {
            this.subCategories[withoutFirst].push(cat);
          }
        }
      }
    }
    
    console.log(`Built category hierarchy with ${Object.keys(this.subCategories).length} parent categories`);
  }
  
  /**
   * Get chunk IDs that need to be written
   */
  getChunksToWrite() {
    return Array.from(this.chunks.keys())
      .filter(chunkId => !this.writtenChunks.has(chunkId));
  }
}

/**
 * Write a chunk file to disk
 */
async function writeChunk(state, chunkId, compress = true) {
  const chunkData = state.chunks.get(chunkId);
  if (!chunkData) return;
  
  const chunk = {
    chunkId,
    articleCount: Object.keys(chunkData.articles).length,
    articles: chunkData.articles
  };
  
  const filename = `chunk-${String(chunkId).padStart(6, '0')}.json`;
  const filePath = path.join(ARTICLES_DIR, filename);
  
  const json = JSON.stringify(chunk);
  
  if (compress) {
    const brotliPath = filePath + '.br';
    await compressFile(json, brotliPath, options.compressionLevel);
    console.log(`  Written: ${filename}.br (${chunk.articleCount} articles)`);
  } else {
    writeFileSync(filePath, json);
    console.log(`  Written: ${filename} (${chunk.articleCount} articles)`);
  }
  
  // Clear chunk from memory after writing
  state.chunks.delete(chunkId);
  state.writtenChunks.add(chunkId);
}

/**
 * Compress data with Brotli
 */
async function compressFile(data, outputPath, level = 6) {
  return new Promise((resolve, reject) => {
    const brotli = createBrotliCompress({
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: level
      }
    });
    
    const output = createWriteStream(outputPath);
    
    brotli.pipe(output);
    brotli.write(data);
    brotli.end();
    
    output.on('finish', resolve);
    output.on('error', reject);
  });
}

/**
 * Write the index file
 */
async function writeIndex(state, compress = true) {
  console.log('\nBuilding category hierarchy...');
  state.buildCategoryHierarchy();
  
  const chunkCount = state.pages.length === 0
    ? 0
    : Math.max(...state.pages.map(p => p[2])) + 1;
  
  const index = {
    version: VERSION,
    articleCount: state.pages.length,
    chunkSize: CHUNK_SIZE,
    chunkCount: chunkCount,
    pages: state.pages,
    subCategories: state.subCategories,
    noPageMaps: state.noPageMaps
  };
  
  console.log(`\nWriting index.json (${state.pages.length.toLocaleString()} articles)...`);
  
  const json = JSON.stringify(index);
  const rawSize = json.length;
  console.log(`  Raw size: ${(rawSize / 1024 / 1024).toFixed(1)} MB`);
  
  if (compress) {
    // Use high compression (level 11) for index since it's fetched once
    const brotliPath = INDEX_PATH + '.br';
    await compressFile(json, brotliPath, 11);
    const compressedSize = fs.statSync(brotliPath).size;
    console.log(`  Compressed size: ${(compressedSize / 1024 / 1024).toFixed(1)} MB`);
    console.log(`  Compression ratio: ${(compressedSize / rawSize * 100).toFixed(1)}%`);
  } else {
    writeFileSync(INDEX_PATH, json);
  }
  
  // Also write uncompressed for local dev
  writeFileSync(INDEX_PATH, json);
  console.log(`  Written: index.json`);
}

/**
 * Main processing function
 */
async function processWikipediaDump(dumpPath, state, limit = null) {
  console.log(`\nProcessing Wikipedia dump: ${dumpPath}`);
  
  if (!existsSync(dumpPath)) {
    console.error(`Error: Dump file not found: ${dumpPath}`);
    process.exit(1);
  }
  
  const stats = fs.statSync(dumpPath);
  console.log(`  File size: ${(stats.size / 1024 / 1024 / 1024).toFixed(2)} GB`);
  
  // Estimate total articles (rough: ~6.8M for full English Wikipedia)
  const estimatedTotal = limit || 6800000;
  const progress = new ProgressReporter(estimatedTotal);
  
  // Track chunks that fill up during processing
  let fullChunks = [];
  const CHUNK_WRITE_THRESHOLD = CHUNK_SIZE; // Write when chunk is full
  
  return new Promise((resolve, reject) => {
    const decompressStream = createDecompressStream(dumpPath);
    const parser = new WikiDumpParser({ skipRedirects: true });
    
    decompressStream.pipe(parser);
    
    parser.on('data', (page) => {
      // Skip if resuming and already processed
      if (options.resume && page.pageId <= state.lastPageId) {
        return;
      }
      
      // Add article to state
      if (state.addArticle(page)) {
        progress.increment();
        
        // Check if any chunks are full and should be written
        const chunkId = Math.floor(page.pageId / CHUNK_SIZE);
        const chunk = state.chunks.get(chunkId);
        if (chunk && Object.keys(chunk.articles).length >= CHUNK_WRITE_THRESHOLD) {
          fullChunks.push(chunkId);
        }
        
        // Checkpoint every 100K articles
        if (state.articleCount % 100000 === 0) {
          state.saveCheckpoint();
          
          // Write full chunks to free memory
          console.log(`\nWriting ${fullChunks.length} full chunks to disk...`);
          for (const id of fullChunks) {
            writeChunk(state, id, options.compress).catch(console.error);
          }
          fullChunks = [];
        }
        
        // Stop if limit reached
        if (limit && state.articleCount >= limit) {
          parser.destroy();
          decompressStream.destroy?.();
          resolve();
        }
      }
    });
    
    parser.on('error', (err) => {
      console.error('Parser error:', err);
      reject(err);
    });
    
    parser.on('end', () => {
      progress.finish();
      resolve();
    });
    
    decompressStream.on('error', (err) => {
      // Ignore premature close (happens when we destroy stream early)
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error('Decompress error:', err);
        reject(err);
      }
    });
  });
}

/**
 * Generate test data without a dump file
 */
async function generateTestData(state, count = 100) {
  console.log(`\nGenerating ${count} test articles...`);
  
  const categories = ['science', 'history', 'technology', 'art', 'sports', 'music', 'geography', 'biology'];
  const adjectives = ['american', 'british', 'modern', 'ancient', 'famous', '21st-century'];
  
  for (let i = 1; i <= count; i++) {
    const cat1 = categories[i % categories.length];
    const cat2 = categories[(i * 3) % categories.length];
    const adj = adjectives[i % adjectives.length];
    
    const page = {
      title: `Test Article ${i}`,
      pageId: i * 100, // Spread across chunks
      wikitext: `This is '''test article ${i}''' about ${cat1} and ${cat2}. ` +
                `It contains sample text for testing the xikipedia chunked data system. ` +
                `The article discusses various aspects of ${adj} ${cat1} topics. ` +
                `[[File:Test${i}.jpg|thumb|A test image]] ` +
                `[[Category:${cat1}]] [[Category:${adj} ${cat2}]]`
    };
    
    state.addArticle(page);
  }
  
  console.log(`Generated ${state.articleCount} test articles across ${state.chunks.size} chunks`);
}

/**
 * Main entry point
 */
async function main() {
  console.log('=== Xikipedia Chunked Data Generator ===\n');
  
  // Create output directories
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  if (!existsSync(ARTICLES_DIR)) {
    mkdirSync(ARTICLES_DIR, { recursive: true });
  }
  
  const state = new GeneratorState();
  
  // Handle resume
  if (options.resume) {
    const checkpoint = state.loadCheckpoint();
    if (!checkpoint) {
      console.log('No checkpoint found. Starting fresh.');
    }
  }
  
  // Determine limit
  const limit = options.test ? options.testLimit : MAX_ARTICLES;
  
  try {
    if (options.dump) {
      // Process Wikipedia dump
      await processWikipediaDump(options.dump, state, limit);
    } else if (options.test) {
      // Generate test data
      await generateTestData(state, options.testLimit);
    } else {
      console.log('No dump file specified. Use --dump <path> or --test for test data.');
      printUsage();
      process.exit(1);
    }
    
    // Write remaining chunks
    console.log('\nWriting remaining chunks...');
    const remainingChunks = state.getChunksToWrite();
    for (const chunkId of remainingChunks) {
      await writeChunk(state, chunkId, options.compress);
    }
    
    // Write index
    await writeIndex(state, options.compress);
    
    // Final checkpoint
    state.saveCheckpoint();
    
    // Summary
    console.log('\n=== Generation Complete ===');
    console.log(`Articles: ${state.articleCount.toLocaleString()}`);
    console.log(`Chunks: ${state.writtenChunks.size}`);
    console.log(`Categories: ${state.categorySet.size.toLocaleString()}`);
    console.log(`Output: ${OUTPUT_DIR}`);
    
    // List output files
    console.log('\nOutput files:');
    const files = fs.readdirSync(OUTPUT_DIR);
    for (const file of files) {
      if (!file.startsWith('.') && file !== 'articles') {
        const stat = fs.statSync(path.join(OUTPUT_DIR, file));
        console.log(`  ${file}: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
      }
    }
    
    const chunkFiles = fs.readdirSync(ARTICLES_DIR);
    console.log(`  articles/: ${chunkFiles.length} chunk files`);
    
  } catch (err) {
    console.error('\nFatal error:', err);
    state.saveCheckpoint();
    process.exit(1);
  }
}

main().catch(console.error);
