/**
 * Wikipedia Dump Parser Utilities
 * 
 * Provides streaming XML parsing and WikiText to plain text conversion
 * for processing Wikipedia database dumps.
 */

import { createReadStream } from 'fs';
import { createBrotliDecompress, createGunzip } from 'zlib';
import { Transform } from 'stream';
import { spawn } from 'child_process';

/**
 * Extracts plain text intro from WikiText markup.
 * Simplified parser that handles common cases without full WikiText grammar.
 * 
 * @param {string} wikitext - Raw WikiText content
 * @param {number} maxLength - Maximum output length (default 500)
 * @returns {string} Plain text excerpt
 */
export function extractPlainText(wikitext, maxLength = 500) {
  if (!wikitext) return '';
  
  let text = wikitext;
  
  // Remove everything before first paragraph (infoboxes, templates at top)
  // Find first actual content paragraph
  const lines = text.split('\n');
  let startIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Skip empty lines, templates, infoboxes, tables
    if (line === '' || 
        line.startsWith('{{') || 
        line.startsWith('|') ||
        line.startsWith('{|') ||
        line.startsWith('[[File:') ||
        line.startsWith('[[Image:') ||
        line.startsWith('__')) {
      continue;
    }
    // Found first content line
    startIndex = i;
    break;
  }
  text = lines.slice(startIndex).join('\n');
  
  // Remove templates {{...}} (can be nested)
  let prevLength = -1;
  while (text.length !== prevLength) {
    prevLength = text.length;
    text = text.replace(/\{\{[^{}]*\}\}/g, '');
  }
  
  // Remove remaining unmatched template starts/ends
  text = text.replace(/\{\{[^}]*$/g, '');
  text = text.replace(/^[^{]*\}\}/g, '');
  
  // Remove references <ref>...</ref> and <ref ... />
  text = text.replace(/<ref[^>]*\/>/gi, '');
  text = text.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, '');
  
  // Remove categories [[Category:...]]
  text = text.replace(/\[\[Category:[^\]]+\]\]/gi, '');
  
  // Remove files/images [[File:...]] [[Image:...]]
  text = text.replace(/\[\[(?:File|Image):[^\]]+\]\]/gi, '');
  
  // Convert links [[Target|Display]] → Display, [[Target]] → Target
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  text = text.replace(/\[\[([^\]]+)\]\]/g, '$1');
  
  // Remove external links [http://... text] → text
  text = text.replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/g, '$1');
  text = text.replace(/\[https?:\/\/[^\]]+\]/g, '');
  
  // Remove bold/italic markers
  text = text.replace(/'{2,5}/g, '');
  
  // Remove section headers
  text = text.replace(/^=+[^=]+=+$/gm, '');
  
  // Remove magic words
  text = text.replace(/__[A-Z]+__/g, '');
  
  // Remove tables
  text = text.replace(/\{\|[\s\S]*?\|\}/g, '');
  text = text.replace(/^\|.*$/gm, '');
  text = text.replace(/^!.*$/gm, '');
  
  // Clean up whitespace
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/\s+/g, ' ');
  text = text.trim();
  
  // Take first portion up to maxLength, try to end at sentence
  if (text.length > maxLength) {
    text = text.slice(0, maxLength);
    // Try to end at a sentence boundary
    const lastSentence = text.search(/[.!?]\s+[^.!?]*$/);
    if (lastSentence > maxLength * 0.5) {
      text = text.slice(0, lastSentence + 1);
    }
  }
  
  return text.trim();
}

/**
 * Extracts the first image/thumbnail from WikiText.
 * Looks for [[File:...]] or [[Image:...]] patterns.
 * 
 * @param {string} wikitext - Raw WikiText content
 * @returns {string|null} Image filename or null
 */
export function extractThumbnail(wikitext) {
  if (!wikitext) return null;
  
  // Match [[File:Name.ext|...]] or [[Image:Name.ext|...]]
  const match = wikitext.match(/\[\[(?:File|Image):([^|\]]+)/i);
  if (match) {
    return match[1].trim();
  }
  
  return null;
}

/**
 * Extracts categories from WikiText.
 * 
 * @param {string} wikitext - Raw WikiText content
 * @returns {string[]} Array of category names (lowercase)
 */
export function extractCategories(wikitext) {
  if (!wikitext) return [];
  
  const categories = [];
  const regex = /\[\[Category:([^\]|]+)/gi;
  let match;
  
  while ((match = regex.exec(wikitext)) !== null) {
    const cat = match[1].trim().toLowerCase();
    // Filter out maintenance categories
    if (!cat.includes('stub') && 
        !cat.includes('disambiguation') &&
        !cat.includes('articles ') && // "Articles needing...", "Articles with..."
        !cat.includes('pages ') &&    // "Pages with..."
        !cat.includes('use dmy') &&
        !cat.includes('use mdy') &&
        !cat.includes('cs1 ') &&      // Citation style
        !cat.includes('webarchive') &&
        !cat.includes('wikipedia')) {
      categories.push(cat);
    }
  }
  
  // Limit to top 10 categories to save space
  return categories.slice(0, 10);
}

/**
 * Creates a decompression stream for bz2, gz, or br files.
 * Falls back to raw stream for uncompressed files.
 * 
 * @param {string} filePath - Path to compressed file
 * @returns {ReadableStream} Decompressed stream
 */
export function createDecompressStream(filePath) {
  const readStream = createReadStream(filePath);
  
  if (filePath.endsWith('.bz2')) {
    // bz2 requires external tool (bzip2 or lbzip2)
    // Node.js doesn't have native bz2 support
    // We'll use a child process
    const bunzip2 = spawn('bunzip2', ['-c'], {
      stdio: ['pipe', 'pipe', 'inherit']
    });
    readStream.pipe(bunzip2.stdin);
    return bunzip2.stdout;
  } else if (filePath.endsWith('.gz')) {
    return readStream.pipe(createGunzip());
  } else if (filePath.endsWith('.br')) {
    return readStream.pipe(createBrotliDecompress());
  }
  
  return readStream;
}

/**
 * SAX-like XML parser that emits page objects.
 * Designed for streaming large Wikipedia dumps.
 */
export class WikiDumpParser extends Transform {
  constructor(options = {}) {
    super({ objectMode: true, ...options });
    
    this.buffer = '';
    this.inPage = false;
    this.currentPage = null;
    this.currentTag = null;
    this.pageCount = 0;
    this.skipRedirects = options.skipRedirects !== false;
  }
  
  _transform(chunk, encoding, callback) {
    this.buffer += chunk.toString('utf8');
    
    // Process complete pages
    let pageStart, pageEnd;
    while ((pageStart = this.buffer.indexOf('<page>')) !== -1 &&
           (pageEnd = this.buffer.indexOf('</page>')) !== -1 &&
           pageEnd > pageStart) {
      
      const pageXml = this.buffer.slice(pageStart, pageEnd + 7);
      this.buffer = this.buffer.slice(pageEnd + 7);
      
      const page = this.parsePage(pageXml);
      if (page) {
        this.pageCount++;
        this.push(page);
      }
    }
    
    // Keep buffer manageable (keep last 1MB for partial pages)
    if (this.buffer.length > 2 * 1024 * 1024) {
      const lastPageStart = this.buffer.lastIndexOf('<page>');
      if (lastPageStart > 0) {
        this.buffer = this.buffer.slice(lastPageStart);
      }
    }
    
    callback();
  }
  
  _flush(callback) {
    // Process any remaining page in buffer
    const pageStart = this.buffer.indexOf('<page>');
    const pageEnd = this.buffer.indexOf('</page>');
    
    if (pageStart !== -1 && pageEnd !== -1 && pageEnd > pageStart) {
      const pageXml = this.buffer.slice(pageStart, pageEnd + 7);
      const page = this.parsePage(pageXml);
      if (page) {
        this.push(page);
      }
    }
    
    callback();
  }
  
  parsePage(xml) {
    // Quick check for redirect
    if (this.skipRedirects && xml.includes('<redirect')) {
      return null;
    }
    
    // Extract namespace - only process ns=0 (main articles)
    const nsMatch = xml.match(/<ns>(\d+)<\/ns>/);
    if (!nsMatch || nsMatch[1] !== '0') {
      return null;
    }
    
    // Extract title
    const titleMatch = xml.match(/<title>([^<]+)<\/title>/);
    if (!titleMatch) return null;
    const title = this.decodeXmlEntities(titleMatch[1]);
    
    // Skip certain titles
    if (title.includes(':') || // Any namespace prefix
        title.startsWith('List of ') ||
        title.startsWith('Lists of ')) {
      return null;
    }
    
    // Extract page ID
    const idMatch = xml.match(/<id>(\d+)<\/id>/);
    if (!idMatch) return null;
    const pageId = parseInt(idMatch[1], 10);
    
    // Extract text content
    const textMatch = xml.match(/<text[^>]*>([^]*?)<\/text>/);
    if (!textMatch) return null;
    const wikitext = this.decodeXmlEntities(textMatch[1]);
    
    // Skip if text is too short or is a redirect/disambiguation
    if (wikitext.length < 100 ||
        wikitext.toLowerCase().startsWith('#redirect') ||
        wikitext.includes('{{disambiguation}}') ||
        wikitext.includes('{{Disambiguation}}')) {
      return null;
    }
    
    return {
      title,
      pageId,
      wikitext
    };
  }
  
  decodeXmlEntities(str) {
    return str
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }
}

/**
 * Hash a thumbnail filename to 8 characters for compact storage.
 * Uses simple FNV-1a hash.
 * 
 * @param {string} filename - Thumbnail filename
 * @returns {string} 8-character hash
 */
export function hashThumbFilename(filename) {
  if (!filename) return null;
  
  // FNV-1a hash
  let hash = 2166136261;
  for (let i = 0; i < filename.length; i++) {
    hash ^= filename.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  
  // Convert to base36 and pad/truncate to 8 chars
  return hash.toString(36).padStart(8, '0').slice(0, 8);
}

/**
 * Progress reporter for long-running operations
 */
export class ProgressReporter {
  constructor(total, reportInterval = 10000) {
    this.total = total;
    this.current = 0;
    this.startTime = Date.now();
    this.reportInterval = reportInterval;
    this.lastReport = 0;
  }
  
  increment(amount = 1) {
    this.current += amount;
    
    if (this.current - this.lastReport >= this.reportInterval) {
      this.report();
      this.lastReport = this.current;
    }
  }
  
  report() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    const rate = this.current / elapsed;
    const percent = this.total ? (this.current / this.total * 100).toFixed(1) : '?';
    const eta = this.total ? ((this.total - this.current) / rate / 60).toFixed(1) : '?';
    
    console.log(`Progress: ${this.current.toLocaleString()} / ${this.total?.toLocaleString() || '?'} (${percent}%) - ${rate.toFixed(0)}/sec - ETA: ${eta} min`);
  }
  
  finish() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    console.log(`Completed: ${this.current.toLocaleString()} items in ${(elapsed / 60).toFixed(1)} minutes`);
  }
}
