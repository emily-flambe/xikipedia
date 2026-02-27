"""
Xikipedia Data Pipeline

Dagster pipeline to keep Wikipedia data fresh:
1. Fetches data from Simple Wikipedia API (or syncs from xikipedia.org)
2. Processes into smoldata.json format
3. Uploads to Cloudflare R2

Schedule: Monthly on the 1st
"""

import brotli
import json
import os
from datetime import datetime
from pathlib import Path

from dagster import (
    asset,
    define_asset_job,
    schedule,
    Definitions,
    AssetExecutionContext,
    Config,
    EnvVar,
    MetadataValue,
    DefaultScheduleStatus,
)

import requests

# Constants
WIKI_API = "https://simple.wikipedia.org/w/api.php"
SOURCE_URL = "https://xikipedia.org/smoldata.json.br"  # Brotli compressed
R2_BUCKET = "xikipedia-data"
R2_KEY = "smoldata.json"


class SyncConfig(Config):
    """Configuration for data sync."""
    source: str = "xikipedia.org"  # or "wikipedia-api"


@asset(
    description="Downloads the latest Wikipedia data from xikipedia.org",
    compute_kind="download",
)
def raw_wikipedia_data(context: AssetExecutionContext) -> dict:
    """
    Fetch the pre-generated data from xikipedia.org.
    This is the fast path - uses rebane2001's processed data.
    Downloads Brotli-compressed file and decompresses it.
    """
    context.log.info(f"Downloading data from {SOURCE_URL}...")
    
    response = requests.get(SOURCE_URL, timeout=300)
    response.raise_for_status()
    
    # Decompress Brotli
    context.log.info(f"Downloaded {len(response.content) / 1024 / 1024:.2f} MB compressed, decompressing...")
    decompressed = brotli.decompress(response.content)
    context.log.info(f"Decompressed to {len(decompressed) / 1024 / 1024:.2f} MB")
    
    data = json.loads(decompressed)
    
    article_count = len(data.get("pages", []))
    category_count = len(data.get("subCategories", {}))
    
    context.log.info(f"Loaded {article_count} articles, {category_count} categories")
    
    context.add_output_metadata({
        "article_count": article_count,
        "category_count": category_count,
        "compressed_size_mb": round(len(response.content) / 1024 / 1024, 2),
        "decompressed_size_mb": round(len(decompressed) / 1024 / 1024, 2),
        "source": SOURCE_URL,
        "download_time": datetime.now().isoformat(),
    })
    
    return data


@asset(
    description="Validates and processes the Wikipedia data",
    compute_kind="transform",
)
def processed_wikipedia_data(
    context: AssetExecutionContext,
    raw_wikipedia_data: dict,
) -> dict:
    """
    Validate and optionally transform the data.
    Currently passes through, but could add:
    - Data validation
    - Filtering unwanted categories
    - Adding custom metadata
    """
    pages = raw_wikipedia_data.get("pages", [])
    sub_categories = raw_wikipedia_data.get("subCategories", {})
    no_page_maps = raw_wikipedia_data.get("noPageMaps", {})
    
    # Validation
    if not pages:
        raise ValueError("No pages found in data")
    
    # Log some stats about the data
    articles_with_images = sum(1 for p in pages if p[3])  # p[3] is thumb
    
    context.log.info(f"Validated {len(pages)} articles")
    context.log.info(f"  - With images: {articles_with_images}")
    context.log.info(f"  - Categories: {len(sub_categories)}")
    
    context.add_output_metadata({
        "total_articles": len(pages),
        "articles_with_images": articles_with_images,
        "articles_without_images": len(pages) - articles_with_images,
        "category_count": len(sub_categories),
        "preview": MetadataValue.json([p[0] for p in pages[:10]]),  # First 10 titles
    })
    
    return raw_wikipedia_data


@asset(
    description="Uploads processed data to Cloudflare R2",
    compute_kind="upload",
)
def r2_wikipedia_data(
    context: AssetExecutionContext,
    processed_wikipedia_data: dict,
) -> str:
    """
    Upload the processed data to Cloudflare R2 bucket.
    Uses the S3-compatible R2 API directly via requests.
    Requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN env vars.
    """
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    api_token = os.environ.get("CLOUDFLARE_API_TOKEN")

    if not account_id or not api_token:
        context.log.error(f"CLOUDFLARE_ACCOUNT_ID set: {bool(account_id)}")
        context.log.error(f"CLOUDFLARE_API_TOKEN set: {bool(api_token)}")
        raise RuntimeError(
            "Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN env vars"
        )

    data_bytes = json.dumps(processed_wikipedia_data).encode("utf-8")
    context.log.info(f"Uploading {len(data_bytes) / 1024 / 1024:.2f} MB to R2...")

    url = (
        f"https://api.cloudflare.com/client/v4/accounts/{account_id}"
        f"/r2/buckets/{R2_BUCKET}/objects/{R2_KEY}"
    )

    response = requests.put(
        url,
        headers={
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
        },
        data=data_bytes,
        timeout=600,
    )

    if response.status_code not in (200, 201):
        context.log.error(f"R2 upload failed: {response.status_code} {response.text[:500]}")
        raise RuntimeError(f"R2 upload failed: {response.status_code} {response.text[:500]}")

    context.log.info("Upload complete!")

    context.add_output_metadata({
        "bucket": R2_BUCKET,
        "key": R2_KEY,
        "size_mb": round(len(data_bytes) / 1024 / 1024, 2),
        "upload_time": datetime.now().isoformat(),
    })

    return f"r2://{R2_BUCKET}/{R2_KEY}"


# Define the job
xikipedia_update_job = define_asset_job(
    name="xikipedia_update_job",
    selection=[raw_wikipedia_data, processed_wikipedia_data, r2_wikipedia_data],
    description="Full pipeline to update Xikipedia data from source to R2",
)


# Monthly schedule - runs on the 1st at 6am
@schedule(
    job=xikipedia_update_job,
    cron_schedule="0 6 1 * *",  # 6am on the 1st of each month
    default_status=DefaultScheduleStatus.RUNNING,  # Enabled by default
)
def monthly_data_update_schedule():
    """Monthly schedule to refresh Wikipedia data."""
    return {}


# Definitions export
defs = Definitions(
    assets=[
        raw_wikipedia_data,
        processed_wikipedia_data,
        r2_wikipedia_data,
    ],
    jobs=[xikipedia_update_job],
    schedules=[monthly_data_update_schedule],
)
