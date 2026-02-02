#!/usr/bin/env node
/**
 * Xikipedia Data Generator
 * 
 * Fetches Simple Wikipedia data and generates smoldata.json
 * Uses Wikipedia API to get articles, categories, and thumbnails.
 * 
 * Usage: node scripts/generate-data.mjs
 * 
 * Note: This takes several hours to run due to API rate limits.
 * For a full refresh, consider using Wikipedia dumps instead.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, '..', 'public', 'smoldata.json');

const WIKI_API = 'https://simple.wikipedia.org/w/api.php';
const BATCH_SIZE = 50;
const RATE_LIMIT_MS = 100; // Be nice to Wikipedia

// Track progress
let articlesProcessed = 0;
let totalArticles = 0;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }
  return response.json();
}

async function getAllArticleTitles() {
  console.log('Fetching all article titles...');
  const titles = [];
  let continueToken = '';
  
  while (true) {
    const url = new URL(WIKI_API);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'allpages');
    url.searchParams.set('aplimit', '500');
    url.searchParams.set('apnamespace', '0'); // Main namespace only
    url.searchParams.set('format', 'json');
    if (continueToken) {
      url.searchParams.set('apcontinue', continueToken);
    }
    
    const data = await fetchJson(url);
    
    for (const page of data.query.allpages) {
      titles.push(page.title);
    }
    
    console.log(`  Fetched ${titles.length} titles...`);
    
    if (data.continue?.apcontinue) {
      continueToken = data.continue.apcontinue;
      await sleep(RATE_LIMIT_MS);
    } else {
      break;
    }
  }
  
  totalArticles = titles.length;
  console.log(`Found ${totalArticles} articles total.`);
  return titles;
}

async function getArticleDetails(titles) {
  const url = new URL(WIKI_API);
  url.searchParams.set('action', 'query');
  url.searchParams.set('titles', titles.join('|'));
  url.searchParams.set('prop', 'extracts|pageimages|categories|links');
  url.searchParams.set('exintro', '1');
  url.searchParams.set('explaintext', '1');
  url.searchParams.set('exsentences', '5');
  url.searchParams.set('piprop', 'original');
  url.searchParams.set('cllimit', '500');
  url.searchParams.set('pllimit', '100');
  url.searchParams.set('format', 'json');
  
  const data = await fetchJson(url);
  return data.query?.pages || {};
}

async function getAllCategories() {
  console.log('Fetching category hierarchy...');
  const categoryMap = {};
  let continueToken = '';
  
  while (true) {
    const url = new URL(WIKI_API);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'allcategories');
    url.searchParams.set('aclimit', '500');
    url.searchParams.set('format', 'json');
    if (continueToken) {
      url.searchParams.set('accontinue', continueToken);
    }
    
    const data = await fetchJson(url);
    
    for (const cat of data.query.allcategories) {
      categoryMap[cat['*'].toLowerCase()] = [];
    }
    
    console.log(`  Fetched ${Object.keys(categoryMap).length} categories...`);
    
    if (data.continue?.accontinue) {
      continueToken = data.continue.accontinue;
      await sleep(RATE_LIMIT_MS);
    } else {
      break;
    }
  }
  
  // Now get parent categories for each
  console.log('Building category hierarchy...');
  const categories = Object.keys(categoryMap);
  
  for (let i = 0; i < categories.length; i += BATCH_SIZE) {
    const batch = categories.slice(i, i + BATCH_SIZE);
    const titles = batch.map(c => `Category:${c}`);
    
    const url = new URL(WIKI_API);
    url.searchParams.set('action', 'query');
    url.searchParams.set('titles', titles.join('|'));
    url.searchParams.set('prop', 'categories');
    url.searchParams.set('cllimit', '500');
    url.searchParams.set('format', 'json');
    
    const data = await fetchJson(url);
    
    for (const page of Object.values(data.query?.pages || {})) {
      if (page.categories) {
        const catName = page.title.replace('Category:', '').toLowerCase();
        categoryMap[catName] = page.categories
          .map(c => c.title.replace('Category:', '').toLowerCase())
          .filter(c => c !== catName);
      }
    }
    
    if (i % 500 === 0) {
      console.log(`  Processed ${i}/${categories.length} categories...`);
    }
    
    await sleep(RATE_LIMIT_MS);
  }
  
  return categoryMap;
}

function extractThumbName(imageUrl) {
  if (!imageUrl) return null;
  // Extract filename from Commons URL
  const match = imageUrl.match(/\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function processArticles(titles) {
  const pages = [];
  const noPageMaps = {};
  let pageIdCounter = 1;
  
  console.log('Processing articles...');
  
  for (let i = 0; i < titles.length; i += BATCH_SIZE) {
    const batch = titles.slice(i, i + BATCH_SIZE);
    
    try {
      const details = await getArticleDetails(batch);
      
      for (const page of Object.values(details)) {
        if (page.pageid && page.extract) {
          const categories = (page.categories || [])
            .map(c => c.title.replace('Category:', '').toLowerCase())
            .filter(c => !c.includes('stub') && !c.includes('disambiguation'));
          
          const links = (page.links || [])
            .map(l => l.title)
            .slice(0, 20); // Limit links
          
          const thumb = page.original?.source ? extractThumbName(page.original.source) : null;
          
          // Store as array for compactness: [title, id, text, thumb, categories, linkIds]
          pages.push([
            page.title,
            page.pageid,
            page.extract.slice(0, 500), // Limit text length
            thumb,
            categories,
            [] // Will populate link IDs after all pages are processed
          ]);
          
          noPageMaps[page.pageid] = page.title.toLowerCase();
        }
      }
      
      articlesProcessed = i + batch.length;
      if (articlesProcessed % 500 === 0) {
        console.log(`  Processed ${articlesProcessed}/${totalArticles} articles (${(articlesProcessed/totalArticles*100).toFixed(1)}%)`);
      }
      
    } catch (err) {
      console.error(`Error processing batch at ${i}:`, err.message);
    }
    
    await sleep(RATE_LIMIT_MS);
  }
  
  // Create title -> pageId map for link resolution
  const titleToId = {};
  for (const page of pages) {
    titleToId[page[0].toLowerCase()] = page[1];
  }
  
  // Resolve links to page IDs
  console.log('Resolving links...');
  for (const page of pages) {
    // page[5] is the links array placeholder
    // We need to go back and populate it
    // For now, leave empty as link resolution requires additional API calls
  }
  
  return { pages, noPageMaps };
}

async function main() {
  console.log('=== Xikipedia Data Generator ===\n');
  console.log('This will fetch data from Simple Wikipedia API.');
  console.log('Note: Full generation takes several hours.\n');
  
  try {
    // Get all article titles
    const titles = await getAllArticleTitles();
    
    // Get category hierarchy
    const subCategories = await getAllCategories();
    
    // Process all articles
    const { pages, noPageMaps } = await processArticles(titles);
    
    // Build final output
    const output = {
      pages,
      subCategories,
      noPageMaps
    };
    
    // Write to file
    console.log('\nWriting output file...');
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output));
    
    const stats = fs.statSync(OUTPUT_PATH);
    console.log(`\n✅ Done! Generated ${OUTPUT_PATH}`);
    console.log(`   Articles: ${pages.length}`);
    console.log(`   Categories: ${Object.keys(subCategories).length}`);
    console.log(`   File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
