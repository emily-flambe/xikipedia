#!/usr/bin/env node
/**
 * Quick Data Update Script
 * 
 * Downloads the latest smoldata.json from the original xikipedia.org
 * and uploads it to our R2 bucket.
 * 
 * This is the fast option - uses rebane2001's pre-generated data.
 * For custom data generation, use generate-data.mjs instead.
 * 
 * Usage: node scripts/update-from-source.mjs
 * 
 * Requires: wrangler CLI configured with Cloudflare credentials
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_BR = path.join(__dirname, '..', 'temp-smoldata.json.br');
const TEMP_JSON = path.join(__dirname, '..', 'temp-smoldata.json');
const SOURCE_URL = 'https://xikipedia.org/smoldata.json';
const R2_BUCKET = 'xikipedia-data';
const R2_KEY = 'smoldata.json';

async function downloadFile(url, destPath) {
  console.log(`Downloading from ${url}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }
  
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
  console.log(`Downloaded ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
  return buffer.length;
}

async function main() {
  console.log('=== Xikipedia Data Updater ===\n');
  
  try {
    // Download latest data from xikipedia.org
    const size = await downloadFile(SOURCE_URL, TEMP_JSON);
    
    // Verify it's valid JSON
    console.log('Verifying JSON...');
    const content = fs.readFileSync(TEMP_JSON, 'utf8');
    const data = JSON.parse(content);
    console.log(`  Articles: ${data.pages?.length || 'unknown'}`);
    console.log(`  Categories: ${Object.keys(data.subCategories || {}).length}`);
    
    // Upload to R2
    console.log('\nUploading to R2...');
    execSync(
      `npx wrangler r2 object put ${R2_BUCKET}/${R2_KEY} --file "${TEMP_JSON}" --content-type "application/json" --remote`,
      { stdio: 'inherit' }
    );
    
    // Cleanup
    fs.unlinkSync(TEMP_JSON);
    
    console.log('\n✅ Data updated successfully!');
    console.log(`   Uploaded ${(size / 1024 / 1024).toFixed(2)} MB to R2`);
    
  } catch (err) {
    console.error('Error:', err.message);
    
    // Cleanup on error
    if (fs.existsSync(TEMP_JSON)) fs.unlinkSync(TEMP_JSON);
    if (fs.existsSync(TEMP_BR)) fs.unlinkSync(TEMP_BR);
    
    process.exit(1);
  }
}

main();
