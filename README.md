# Xikipedia

A recreation of [xikipedia.org](https://xikipedia.org/) - Wikipedia as a social media feed.

**🌐 Live Demo: [xikipedia.emily-cogsdill.workers.dev](https://xikipedia.emily-cogsdill.workers.dev)**

## Attribution

**Original project by [rebane2001 (Lyra Rebane)](https://github.com/rebane2001)**

- Original repository: https://github.com/rebane2001/xikipedia
- Original site: https://xikipedia.org/

This is a learning project that recreates the original with modifications. All credit for the concept and algorithm design goes to rebane2001.

## What is Xikipedia?

Xikipedia presents Simple Wikipedia articles in an infinite-scroll feed (like TikTok or Twitter). A basic engagement-tracking algorithm learns what you like - no machine learning, no data collection, 100% client-side.

## Features

- 📱 Algorithmically curated Wikipedia content
- 🔒 Privacy-first: all data stays in your browser
- ☁️ Zero backend: runs entirely client-side
- 🧠 No ML required: simple weighted scoring

## Tech Stack

| Component | Technology |
|-----------|------------|
| Hosting | Cloudflare Workers |
| Data Storage | Cloudflare R2 |
| Frontend | Vanilla JavaScript |
| Styling | CSS (no frameworks) |
| Testing | Playwright |

## Architecture

```
┌─────────────────────────────────────────┐
│         Cloudflare Workers              │
├─────────────────────────────────────────┤
│  ┌────────────┐    ┌──────────────────┐ │
│  │ Static     │    │ Worker (src/)    │ │
│  │ Assets     │    │ Proxies R2 data  │ │
│  │ (public/)  │    │                  │ │
│  └────────────┘    └──────────────────┘ │
│         │                  │            │
│         ▼                  ▼            │
│  index.html,        smoldata.json       │
│  favicon.ico        (215MB from R2)     │
└─────────────────────────────────────────┘
```

## Development

```bash
# Install dependencies
npm install

# Run type check
npm run typecheck

# Deploy to Cloudflare Workers
npm run deploy

# Run tests against production
npm test
```

### Local Development

Note: Local development requires the R2 bucket with the data file. For most changes, test against the production URL:

```bash
PLAYWRIGHT_BASE_URL=https://xikipedia.emily-cogsdill.workers.dev npm test
```

## Data Updates

Data is refreshed automatically via a **Dagster pipeline** running on a local WSL2 instance.

### Schedule
- **Monthly** on the 1st at 6:00 AM (Mountain Time)
- Syncs from [xikipedia.org](https://xikipedia.org) (~2 min)

### Pipeline Flow
```
raw_wikipedia_data         Download from xikipedia.org (~40MB compressed)
        ↓
processed_wikipedia_data   Validate & transform (~270K articles)
        ↓
r2_wikipedia_data         Upload to Cloudflare R2 (~215MB)
```

### Manual Update
- **Dagster UI**: http://pceus:3000 → Jobs → `xikipedia_update_job` → Launch Run
- **CLI**: `dagster job launch -j xikipedia_update_job -f dagster_definitions/definitions.py`

### Setup
See [dagster_definitions/SETUP.md](./dagster_definitions/SETUP.md) for installation and configuration.

## License

This recreation follows the original project's licensing. Wikipedia content is CC BY-SA.

## See Also

- [DESIGN.md](./DESIGN.md) - Technical architecture and implementation details
