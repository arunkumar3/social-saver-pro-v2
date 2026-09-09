# Social Saver Pro

> Save and archive content from X (Twitter) and Instagram locally — no cloud, no subscriptions.

Social Saver Pro is a Chrome extension that captures tweets, threads, and saved Instagram posts to a local SQLite archive running on your machine. All data stays on disk; all processing happens locally or via APIs you control.

## Features

- **One-click save** — Floating save button on any tweet, thread, or article page
- **Smart thread detection** — Automatically detects and captures full threads with all tweets
- **Bookmark sync** — Syncs your X bookmarks once daily at 9 AM (or on-demand)
- **Instagram saved posts** — Manually triggered export of saved posts with captions
- **Full-text search** — Search across title, caption, transcript, and visual descriptions via FTS5
- **Local archive** — SQLite database on disk with automatic WAL recovery and integrity checks
- **Out-of-browser downloads** — yt-dlp and gallery-dl handle media, ffmpeg for transcoding
- **Vector search ready** — 768-dimensional embeddings with sqlite-vec (Phase 2)
- **Intelligent upsert** — Re-saving content upgrades existing records with richer data

## Architecture

```
Extension              Server                    Storage
────────              ──────                    ───────
Content Script        POST /ingest              ┌──────────────┐
 Detect page type  ────────────────────────>   │ items table  │
 Extract content       POST /cookies            │ (with FTS5)  │
 Auto-scroll           GET /health              └──────────────┘
    ↓                                                  ↑
Floating UI          Node 24 HTTP                     ↓
 Save button        (127.0.0.1:8787)        ┌──────────────────┐
 Status feedback     ├─ /health               │ media/ (on disk) │
 Sync trigger        ├─ /ingest               │ yt-dlp, ffmpeg   │
                     ├─ /cookies              └──────────────────┘
                     └─ /known-urls
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension | Chrome Manifest V3 |
| Server | Node 24, built-in `node:http` and `node:sqlite` |
| Database | SQLite + `sqlite-vec` (768-dim) + FTS5, one file |
| Media | yt-dlp, gallery-dl, ffmpeg |
| AI | LM Studio (qwen3-vl-8b, qwen3.6-35b-a3b, nomic-embed-text-v1.5) |

## Quick Start

### 1. Create the Python Virtual Environment

```bash
cd .venv
python -m venv . --upgrade-deps
. Scripts/activate          # on Windows Git Bash
# or: . venv\Scripts\activate  on Windows PowerShell
pip install torch fastwhisper gallery-dl
```

The venv includes `torch`, `faster-whisper`, and `gallery-dl` for Phase 2 enrichment.

### 2. Install and Start the Server

```bash
cd server
npm install
npm start
```

The server binds to `http://127.0.0.1:8787` and is only reachable from your local machine. On Windows, to auto-start at logon:

```powershell
powershell -ExecutionPolicy Bypass -File bin/install-task.ps1
```

### 3. Load the Extension

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the repository root folder

### 4. Export Instagram Cookies (if syncing Instagram)

1. Log in to Instagram in Chrome
2. Click the extension icon → **Export Instagram Cookies**
3. Cookies are written to `server/data/cookies.txt` in Netscape format
   - This is the only way to sync Instagram: the extension reads `chrome.cookies` (encrypted by the browser) and downloaders read the plaintext Netscape file
   - `yt-dlp --cookies-from-browser chrome` does **not** work on Chrome 127+ due to app-bound encryption

### 5. Start Syncing

- **Twitter**: Click **Sync Bookmarks** in the extension popup to pull in bookmarks from the last 30 days. Syncs automatically daily at 9 AM.
- **Instagram**: Click **Sync Saved Posts** in the extension popup. There is no automatic schedule — manual only — to avoid action-blocks from scripted scrolling.

Check the server logs for ingestion progress. Bookmarked content now appears in the local archive.

## How It Works

### Content Detection

The content script detects page types on X and Instagram:

| Platform | Page Type | Detection | What's captured |
|----------|-----------|-----------|-----------------|
| **X** | Tweet | URL matches `/status/\d+` | Text, author, images, source date |
| **X** | Thread | 3+ tweets from ≤2 authors | All tweets, concatenated |
| **X** | Article | URL contains `/article/` | Title + full body text |
| **X** | Bookmarks page | `/i/bookmarks` URL | Batch scroll-and-collect |
| **Instagram** | Saved posts | Custom popup trigger | Captions, images, videos |

### Save and Sync Flow

1. **Extract** — Content script detects page type and extracts text, metadata, and media URLs
2. **Send** — Data sent to service worker via `chrome.runtime.sendMessage`
3. **POST /ingest** — Service worker sends JSON batch to local server at `http://127.0.0.1:8787/ingest`
4. **Dedup** — Server checks `items` table for existing URL
5. **Upsert** — If found, updates only if new data is richer (type upgrade from `tweet` to `thread`, or longer caption)
6. **Insert** — New items land in `items` table with `state = 'pending'`
7. **Media stage** — Server polls every 30 seconds, moving items from `pending` to `media` state and downloading via yt-dlp/gallery-dl

### Bookmark and Saved-Post Sync

- **Twitter bookmarks**: Opens unfocused window, auto-scrolls to collect all bookmarks, only pulls items from the last `SYNC_MAX_AGE_DAYS` (default: 30 days), stops scrolling after 3 consecutive older items. Runs daily at 9 AM or on-demand.
- **Instagram**: Manual trigger only. Extension exports encrypted browser cookies to `server/data/cookies.txt`; Instagram downloader reads the plaintext file. No automatic schedule to avoid account action-blocks.

## Project Structure

```
social-saver-pro-v2/
├── manifest.json              # Chrome extension manifest (MV3)
├── background.js              # Service worker: ingest, sync, alarms
├── content.js                 # Content script: X page detection, extraction, floating UI
├── instagram.js               # Instagram saved-post exporter
├── content.css                # Floating save button styles
├── config.js                  # Config constants (SYNC_HOUR, SYNC_MAX_AGE_DAYS, etc.)
├── popup.html                 # Extension popup UI
├── popup.js                   # Popup logic: sync trigger, status display
├── icons/                     # Extension icons (16, 48, 128px)
│
├── server/
│   ├── package.json           # Node dependencies (sqlite-vec only)
│   ├── bin/
│   │   ├── start.cmd          # Windows batch file to start server
│   │   └── install-task.ps1   # PowerShell script to register Windows Task Scheduler
│   ├── src/
│   │   ├── server.js          # HTTP server: route dispatch, error handling
│   │   ├── http.js            # send() and readJson() utilities
│   │   ├── config.js          # Server config (HOST, PORT, paths)
│   │   ├── db.js              # SQLite connection and schema init
│   │   ├── schema.sql         # Tables: items, media, chunks, vec_chunks, items_fts, job_runs
│   │   ├── routes/
│   │   │   ├── health.js      # GET /health
│   │   │   ├── ingest.js      # POST /ingest, POST /known-urls
│   │   │   └── cookies.js     # POST /cookies (Instagram cookie export)
│   │   ├── cookies/           # Instagram Netscape-format cookie file
│   │   ├── media/             # Media download worker (yt-dlp, gallery-dl)
│   │   └── worker/
│   │       └── media-stage.js # Runs every 30s: moves items to media, downloads
│   │
│   ├── data/                  # Archive storage (created at runtime)
│   │   ├── archive.db         # SQLite database
│   │   ├── archive.db-wal     # Write-ahead log (auto-created)
│   │   ├── cookies.txt        # Instagram cookies (Netscape format)
│   │   └── media/             # Downloaded images, videos, etc.
│   │
│   └── test/                  # Node test files (run with: npm test)
│
└── docs/                      # Phase 2+ planning and research
```

## Configuration

Configuration is read from `config.js` at the extension root and `server/src/config.js` on the server.

### Extension (`config.js`)

| Setting | Default | Notes |
|---------|---------|-------|
| `SYNC_HOUR` | 9 | Hour for daily X bookmark sync (0-23, UTC) |
| `SYNC_MINUTE` | 0 | Minute for bookmark sync |
| `SYNC_MAX_AGE_DAYS` | 30 | Only pull bookmarks from the last N days; older items are skipped |
| `MIN_TWEET_LENGTH` | 30 | Ignore tweets shorter than this |
| `MAX_SCROLL_TIME` | 60000 ms | Timeout for bookmark page auto-scroll |
| `SYNC_CONCURRENCY` | 2 | How many bookmark items to open at once |

### Server (`server/src/config.js`)

| Setting | Default | Notes |
|---------|---------|-------|
| `HOST` | `127.0.0.1` | Bind address; not reachable from the network |
| `PORT` | `8787` | Can override with `SSP_PORT` env var |
| `DB_PATH` | `server/data/archive.db` | SQLite database file |
| `COOKIES_PATH` | `server/data/cookies.txt` | Instagram cookies in Netscape format |
| `MEDIA_DIR` | `server/data/media` | Where yt-dlp and gallery-dl write downloads |

### Permissions

The extension requires:

| Permission | Why |
|-----------|-----|
| `activeTab`, `scripting`, `tabs` | Navigate, read pages, detect page type |
| `storage` | Store config and state (unused in Phase 1) |
| `alarms` | Schedule daily bookmark sync |
| `notifications` | Show sync status |
| `cookies` | Export Instagram cookies |
| Host permissions: `x.com`, `twitter.com`, `instagram.com`, `127.0.0.1:8787` | Access pages and local server |

## Database Schema

All data lives in `server/data/archive.db`, a single SQLite file with WAL journaling and foreign key constraints.

### `items` table (core archive)

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment row ID |
| `platform` | TEXT | `twitter` or `instagram` |
| `kind` | TEXT | `tweet`, `thread`, or `article` |
| `url` | TEXT UNIQUE | Source URL (dedup key) |
| `external_id` | TEXT | Tweet ID or Instagram post ID |
| `author`, `author_handle` | TEXT | Original poster |
| `title`, `caption` | TEXT | Extracted text |
| `transcript` | TEXT | Whisper output (Phase 2, currently NULL) |
| `visual_description` | TEXT | VLM description (Phase 2, currently NULL) |
| `document` | TEXT | OCR or full-text extraction (Phase 2, currently NULL) |
| `category`, `subcategory` | TEXT | AI tags (Phase 2, currently NULL) |
| `summary` | TEXT | AI summary (Phase 2, currently NULL) |
| `action_item` | TEXT | Extracted task (Phase 2, currently NULL) |
| `action_status` | TEXT | `pending`, `done`, or `skipped` |
| `key_insights` | TEXT | Bullet-point notes (Phase 2, currently NULL) |
| `state` | TEXT | `pending`, `media`, `enriched`, `error` |
| `state_error` | TEXT | Error message if state=error |
| `attempts` | INTEGER | Retry count for failed stages |
| `pdf_path` | TEXT | Unused (PDF export removed) |
| `source_date` | TEXT | Original post date (ISO 8601) |
| `saved_at`, `updated_at` | TEXT | Timestamps |

### `media` table (downloaded files)

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `item_id` | INTEGER FK | Reference to `items.id` |
| `kind` | TEXT | `image`, `video`, `audio` |
| `path` | TEXT | File path under `server/data/media/` |
| `bytes`, `width`, `height`, `duration_s` | INTEGER/REAL | File metadata |
| `sha256` | TEXT | Content hash (for dedup) |
| `downloader` | TEXT | Tool used: `yt-dlp`, `gallery-dl`, `ffmpeg` |

### `chunks` table (text fragmentation for embeddings)

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `item_id` | INTEGER FK | Reference to `items.id` |
| `ord` | INTEGER | Chunk sequence number |
| `text` | TEXT | Chunk content (~512 tokens) |

### Full-Text Search

`items_fts` is a **virtual FTS5 table** (external-content index) that indexes `title`, `caption`, `transcript`, and `visual_description`. Queries run automatically via triggers on INSERT/UPDATE/DELETE.

### Vector Search (Phase 2)

`vec_chunks` is a **virtual vec0 table** using `sqlite-vec` for 768-dimensional embeddings. Empty until Phase 2 fills it via `nomic-embed-text-v1.5`.

### Job Tracking

`job_runs` logs each processing stage: which `item_id` entered which stage, status (success/error), duration.

See [`server/src/schema.sql`](server/src/schema.sql) for the complete DDL with indexes and triggers.

## Roadmap

**Phase 1: Capture & Storage** (✅ Complete)
- [x] Chrome extension with floating save button
- [x] Tweet, thread, and article extraction
- [x] Automated X bookmark sync with scroll handling (9 AM daily)
- [x] Instagram saved-post capture (manual trigger)
- [x] Local SQLite archive with FTS5 and vector-ready schema
- [x] Out-of-browser media download via yt-dlp and gallery-dl
- [x] Smart upsert (upgrade `tweet` to `thread`, extend captions)

**Phase 2: Enrichment** (🚧 In Progress)
- [ ] Whisper v3 transcription for video audio
- [ ] QwenVL vision descriptions for images
- [ ] LLM categorization and action-item extraction
- [ ] 768-dimensional embeddings via nomic-embed-text
- [ ] Hybrid keyword + vector search

**Phase 3: Discovery & Export** (⏳ Planned)
- [ ] Local search dashboard (HTML/JS, no backend)
- [ ] Export to Obsidian (markdown + attached media)
- [ ] Tag and note synthesis
- [ ] Periodic archive backups

## Important Notes

### Server Access
- The server binds to `127.0.0.1:8787` **only** and is unreachable from the network or other machines.
- The extension and server must run on the same machine.

### Instagram Sync & Cookies
- Instagram cookies come from the extension's `chrome.cookies` access (encrypted by the browser).
- The extension exports cookies to `server/data/cookies.txt` in **Netscape format** (plaintext).
- Downloaders (`gallery-dl`) read the plaintext Netscape file.
- ❌ `yt-dlp --cookies-from-browser chrome` does **not** work on Chrome 127+ due to app-bound encryption. Do not try to "fix" this back to browser-based cookie reading.

### X Bookmark Sync
- Pulls bookmarks only from the last `SYNC_MAX_AGE_DAYS` (default: 30 days).
- **Older bookmarks will not be archived**, even if they exist in your X bookmarks folder.
- Bookmarking an old tweet after the archive is created will not pull it in.
- Sync stops scrolling after finding 3 consecutive items older than the cutoff.

### Instagram Saved-Post Sync
- **Manual trigger only**. There is no automatic schedule.
- This is intentional: automated scrolling on a timer risks account action-blocks from Instagram's bot-detection.

## License

MIT
