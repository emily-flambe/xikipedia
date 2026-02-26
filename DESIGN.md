# Xikipedia Recreation - Design Document

## Attribution

This project is a recreation/fork of [Xikipedia](https://xikipedia.org/) by **rebane2001 (Lyra Rebane)**.

- **Original Repository**: https://github.com/rebane2001/xikipedia
- **Original Author**: [rebane2001](https://github.com/rebane2001)
- **License**: Check original repo for licensing terms

All credit for the original concept, algorithm design, and implementation goes to rebane2001.

---

## Project Overview

Xikipedia is a pseudo social media feed that presents Simple Wikipedia articles in an infinite-scroll TikTok-like interface. It demonstrates how a basic non-ML algorithm can learn user preferences through engagement tracking - all running 100% client-side with zero data collection.

### Core Philosophy

- **Privacy-first**: All data stays in browser, deleted on tab close
- **No ML required**: Simple engagement-weighted scoring beats complex models
- **Zero backend**: Entire application runs client-side
- **Transparency**: Algorithm is simple and understandable

---

## Technical Architecture

### Stack

| Component | Technology |
|-----------|------------|
| Language | Vanilla JavaScript (ES6+) |
| Styling | Inline CSS (no preprocessors) |
| Framework | None |
| Build System | None (static files) |
| Data Format | JSON with Brotli compression |
| Hosting | Static file hosting |

### File Structure

```
xikipedia/
├── index.html          # Single-file application (HTML + CSS + JS)
├── favicon.ico         # Site icon
├── smoldata.json.br    # Compressed Wikipedia dataset (~40MB)
└── README.md           # Documentation
```

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                               │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  Start Modal │───▶│  Feed Engine │───▶│ Stats Sidebar│  │
│  │  (Category   │    │  (Algorithm  │    │ (Top/Bottom  │  │
│  │   Selection) │    │   + Render)  │    │  Categories) │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│           │                  │                   │          │
│           ▼                  ▼                   ▼          │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              In-Memory State                          │  │
│  │  • categoryScores: Map<string, number>                │  │
│  │  • pagesArr: Article[]                                │  │
│  │  • recursiveCache: Map<string, Set<string>>           │  │
│  └──────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                    smoldata.json.br                         │
│               (Static Wikipedia Dataset)                    │
└─────────────────────────────────────────────────────────────┘
```

---

## Data Model

### Article Object

```typescript
interface Article {
  title: string;           // Article title
  id: number;              // Unique identifier
  text: string;            // Article excerpt/summary
  thumb: string | null;    // Thumbnail image URL
  categories: string[];    // Direct categories
  links: number[];         // Backlink page IDs

  // Computed at runtime:
  allCategories: Set<string>;  // Recursive category expansion
  score: number;               // Current ranking score
  seen: number;                // View count
}
```

### Category Score Map

```typescript
// Maps category name to engagement score
const categoryScores: Record<string, number> = {
  "nature": 5000,
  "science": 2500,
  "animals": 3000,
  // ... dynamically updated based on engagement
};
```

### Data Source

The dataset (`smoldata.json.br`) contains:
- ~40MB of Simple Wikipedia articles
- Pre-processed to include titles, excerpts, thumbnails, and category mappings
- Brotli-compressed for efficient transfer
- Loaded once at startup with progress indicator

---

## Algorithm Design

### Scoring Formula

```javascript
function calculateScore(article) {
  // Base score
  let score = 0;

  // Image bonus: articles with thumbnails rank higher
  if (article.thumb) score += 5;

  // View penalty: exponential decay discourages repeat content
  // 1st view: 0, 2nd view: -50000, 3rd view: -400000
  score += (Math.pow(3, article.seen - 1) - 1) * -50000;

  // Category affinity: sum scores of all article's categories
  for (const cat of article.allCategories) {
    score += categoryScores[cat] ?? 0;
  }

  // Diversity penalty: -5 per post shown (encourages variety)
  score -= postsShown * 5;

  return score;
}
```

### Selection Mechanism

```javascript
function getNextPost() {
  // Sample 10,000 random articles
  const sample = randomSample(pagesArr, 10000);

  // Calculate scores
  const scored = sample.map(a => ({ article: a, score: calculateScore(a) }));

  // 40% random selection, 60% highest score
  if (Math.random() < 0.4) {
    return randomChoice(scored).article;
  } else {
    return scored.reduce((best, curr) =>
      curr.score > best.score ? curr : best
    ).article;
  }
}
```

### Engagement Tracking

| Action | Score Change | Notes |
|--------|--------------|-------|
| View post | -5 to categories | Baseline decay |
| Click article | +75 to categories | Opens Wikipedia |
| Like button | +50 + streak bonus | Streak: 4 × posts without like |
| Click thumbnail | +100 to categories | Full-size image view |

### Category Expansion

Categories are expanded recursively to capture hierarchical relationships:

```javascript
function getRecursiveCategories(category, visited = new Set()) {
  // Check cache
  if (recursiveCache.has(category)) {
    return recursiveCache.get(category);
  }

  // Prevent cycles
  if (visited.has(category)) return new Set();
  visited.add(category);

  const result = new Set([category]);
  const parentCategories = categoryMap.get(category) ?? [];

  for (const parent of parentCategories) {
    const parentCats = getRecursiveCategories(parent, visited);
    for (const cat of parentCats) {
      result.add(cat);
    }
  }

  recursiveCache.set(category, result);
  return result;
}
```

---

## UI Components

### 1. Start Modal (`#startScreen`)

```
┌────────────────────────────────────────┐
│              Xikipedia                  │
│                                        │
│  Select categories to personalize:     │
│  ┌────────┐ ┌────────┐ ┌────────┐     │
│  │ Nature │ │Science │ │Animals │     │
│  └────────┘ └────────┘ └────────┘     │
│  ┌────────┐ ┌────────┐ ┌────────┐     │
│  │History │ │ Tech   │ │Medicine│     │
│  └────────┘ └────────┘ └────────┘     │
│                                        │
│  Search: [________________] ▼          │
│                                        │
│         [ Continue ]                   │
└────────────────────────────────────────┘
```

**Features**:
- Pre-selected default categories
- Search dropdown to add custom categories
- Single "Continue" CTA button

### 2. Feed Container (`.posts`)

```
┌─────────────────────────────────────┐
│  Article Title                       │
│  ┌─────────────┐                    │
│  │   Image     │                    │
│  │  Thumbnail  │                    │
│  └─────────────┘                    │
│  Article text excerpt continues     │
│  here with the summary...           │
│                                     │
│  ❤️ Like                            │
├─────────────────────────────────────┤
│  Another Article                     │
│  No image for this one              │
│  ❤️ Like                            │
├─────────────────────────────────────┤
│  ...infinite scroll...              │
└─────────────────────────────────────┘
```

**Features**:
- Card-based layout (max-width: 600px)
- Optional thumbnail images (16px border-radius)
- Click anywhere to open Wikipedia article
- Like button with heart icon toggle

### 3. Stats Sidebar (`.stats`)

```
┌─────────────────┐
│  Top Categories │
│  ───────────────│
│  Nature    5420 │
│  Animals   4890 │
│  Science   4200 │
│  ...           │
│                 │
│  Bottom         │
│  ───────────────│
│  Politics  -340 │
│  Wars     -520 │
│  ...           │
└─────────────────┘
```

**Features**:
- Fixed position on desktop
- Shows top 10 and bottom 10 categories
- Updates in real-time on engagement

---

## Styling

### Color Palette

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-primary` | `#15202B` | Page background |
| `--bg-secondary` | `#1C2732` | Card hover state |
| `--text-primary` | `#FFFFFF` | Main text |
| `--accent` | `#2cafff` | Buttons, links |
| `--overlay-dark` | `#0008` | Hover overlays |
| `--overlay-light` | `#FFF2` | Button hover |

### Typography

- Font: `system-ui, sans-serif`
- No explicit font sizes (browser defaults)
- No font weights specified

### Spacing

Uses 4px base unit:
- Post padding: `12px 24px`
- Button padding: `4px`
- Stats padding: `8px`
- Button margin: `12px`

### Animations

```css
button {
  transition: background 0.2s, scale 0.2s cubic-bezier(.15,.67,0,1);
}

button:hover:not([data-liked]) {
  background: #FFF2;
  scale: 1.1;
}

button:active {
  scale: 0.9;
}
```

---

## Performance Optimizations

### 1. Lazy Rendering

Posts only render when user scrolls within 1500px of bottom:

```javascript
function render() {
  if (document.documentElement.scrollHeight <
      window.scrollY + window.innerHeight + 1500) {
    createNextPost();
  }
  requestAnimationFrame(render);
}
```

### 2. Batched Processing

Large data operations yield to browser:

```javascript
for (let i = 0; i < articles.length; i++) {
  processArticle(articles[i]);

  if (i % 1000 === 0 && Date.now() - lastFrame > 20) {
    await new Promise(r => requestAnimationFrame(r));
    lastFrame = Date.now();
  }
}
```

### 3. Memoized Category Expansion

```javascript
const recursiveCache = new Map();

function getCategories(cat) {
  if (recursiveCache.has(cat)) return recursiveCache.get(cat);
  // ... compute and cache
}
```

### 4. Streaming Data Load

```javascript
async function loadData(url) {
  const response = await fetch(url, { cache: "force-cache" });
  const reader = response.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    updateProgressUI(loaded / total);
    // ... accumulate chunks
  }
}
```

---

## Implementation Plan

### Phase 1: Core Infrastructure

1. [ ] Set up project structure
2. [ ] Create index.html with basic layout
3. [ ] Implement CSS styling (dark theme)
4. [ ] Add start modal with category selection

### Phase 2: Data Layer

1. [ ] Design article data structure
2. [ ] Create/source Wikipedia dataset
3. [ ] Implement Brotli decompression loading
4. [ ] Add progress indicator UI

### Phase 3: Algorithm Engine

1. [ ] Implement scoring formula
2. [ ] Build category expansion with memoization
3. [ ] Create post selection mechanism (40/60 split)
4. [ ] Add engagement tracking

### Phase 4: Rendering

1. [ ] Build post card component
2. [ ] Implement infinite scroll with lazy loading
3. [ ] Add like button with toggle state
4. [ ] Create stats sidebar

### Phase 5: Polish

1. [ ] Add animations and transitions
2. [ ] Optimize performance (batching, caching)
3. [ ] Test on mobile devices
4. [ ] Add favicon and meta tags

---

## Potential Enhancements

These are ideas for extending beyond the original:

### Content
- [ ] Support full Wikipedia (not just Simple)
- [ ] Add article summaries via Wikipedia API
- [ ] Include article images/media gallery

### Algorithm
- [x] Adjustable algorithm aggressiveness slider (PR #23)
- [x] "Explore mode" that ignores preferences (PR #19)
- [ ] Time-based decay for category scores

### UX
- [x] Dark/light theme toggle
- [x] Save preferences to localStorage (via auth/D1)
- [x] Share article functionality
- [x] Keyboard shortcuts (J/K/L/M/N/R/S/?)
- [x] Reading history (PR #21)

### Technical
- [ ] Service worker for offline support
- [ ] Incremental dataset updates
- [ ] WebWorker for algorithm processing

---

## Open Questions

1. **Dataset generation**: How to create/update `smoldata.json`?
   - Need a script to fetch from Wikipedia dumps
   - Or use Wikipedia API to build incrementally

2. **Licensing**: What license applies to the dataset?
   - Wikipedia content is CC BY-SA
   - Need to include attribution

3. **Hosting**: Where to host the ~40MB data file?
   - GitHub LFS?
   - CDN?
   - Self-hosted?

---

## References

- [Original Xikipedia](https://xikipedia.org/)
- [rebane2001's GitHub](https://github.com/rebane2001)
- [Simple Wikipedia](https://simple.wikipedia.org/)
- [Wikipedia API Documentation](https://www.mediawiki.org/wiki/API:Main_page)
- [Brotli Compression](https://github.com/google/brotli)
