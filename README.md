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

## Data File

The `smoldata.json` (~215MB) contains Simple Wikipedia article data and is stored in Cloudflare R2 for efficient delivery. This file is not stored in the repository.

To regenerate the data file, see the original repository for the data generation scripts.

## License

This recreation follows the original project's licensing. Wikipedia content is CC BY-SA.

## See Also

- [DESIGN.md](./DESIGN.md) - Technical architecture and implementation details
