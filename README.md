# Social Saver Pro

> Save, categorize, and extract action items from Twitter/X content — powered by AI.

Social Saver Pro is a Chrome extension that captures tweets, threads, and articles from X (formerly Twitter), stores them in Supabase, and uses Claude AI to automatically categorize content and extract actionable next steps.

## Features

- **One-click save** — Floating save button on any tweet, thread, or article page
- **Smart thread detection** — Automatically detects and captures full threads with all tweets
- **Bookmark sync** — Syncs your X bookmarks on a daily schedule (or on-demand)
- **AI categorization** — Claude API auto-categorizes saved content and extracts key insights
- **Action items** — AI extracts actionable tasks from saved content with status tracking
- **Full-text search** — Search across all saved content from the dashboard
- **Intelligent upsert** — Re-saving content upgrades existing records with richer data

## Architecture

```
Twitter/X Page
    |
    v
[Content Script]  ──>  [Service Worker]  ──>  [Supabase PostgreSQL]
 Detects page type       Saves via REST API      Stores bookmarks
 Extracts content        Dedup + upsert           Full-text search
 Auto-scrolls            Triggers AI              RLS enabled
    |                        |
    v                        v
[Floating UI]          [Edge Function]  ──>  [Claude API]
 Save button            Categorize              AI processing
 Status feedback        Extract actions
                        Key insights
    |
    v
[Next.js Dashboard]  (Vercel)
 Browse & search saved content
 Filter by type, category, action status
 Track action items
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension | Chrome Manifest V3 |
| Backend | Supabase (PostgreSQL + Edge Functions) |
| AI | Claude API via Supabase Edge Functions |
| Dashboard | Next.js on Vercel |

## Quick Start

### 1. Set Up Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. Open **SQL Editor** and run the contents of [`supabase-schema.sql`](supabase-schema.sql)
3. Copy your **Project URL** and **anon/public key** from **Settings > API**

### 2. Install the Extension

1. Clone this repo:
   ```bash
   git clone https://github.com/ArunKarthik05/social-saver-pro-v2.git
   ```
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the cloned folder
5. Click the extension icon and go to **Settings**
6. Paste your Supabase URL and anon key, then click **Save & Test**

### 3. Start Saving

- Navigate to any tweet, thread, or article on X
- Click the floating **Save** button
- Open the dashboard to browse your saved content

## How It Works

### Content Detection

The content script detects four page types on X:

| Page Type | Detection | Extraction |
|-----------|-----------|------------|
| **Tweet** | URL matches `/status/\d+`, single visible tweet | Focal tweet text, author, images |
| **Thread** | URL matches `/status/\d+`, 3+ tweets from ≤2 authors | All tweets from thread author, concatenated |
| **Article** | URL contains `/article/` or page has "Article"/"Notes" heading | Title + full body text with cascading fallbacks |
| **Bookmarks** | URL contains `/i/bookmarks` | Scroll-and-collect with DOM virtualization handling |

### Save Flow

1. **Extract** — Content script detects page type and extracts structured data
2. **Auto-scroll** — For threads/articles, scrolls the page to load all lazy-loaded content
3. **Send** — Extracted data sent to background service worker via `chrome.runtime.sendMessage`
4. **Dedup** — Service worker checks Supabase for existing URL
5. **Upsert** — If existing record found, updates only if new data is richer (type upgrade or longer text)
6. **Save** — Inserts/updates record in Supabase via REST API
7. **AI** — Fires Edge Function to categorize and extract action items (async)

### Bookmark Sync

- Runs daily at a configurable time (default: midnight)
- Opens X bookmarks page, auto-scrolls to collect all bookmarks
- Handles X's DOM virtualization by accumulating items in a Map during scroll
- Saves each bookmark with dedup/upsert logic
- Can also be triggered manually from the extension popup

## Project Structure

```
social-saver-pro-v2/
├── manifest.json          # Chrome extension manifest (MV3)
├── background.js          # Service worker: Supabase ops, sync, alarms
├── content.js             # Content script: page detection, extraction, UI
├── content.css            # Floating save button styles
├── config.js              # Default config (credentials set via popup)
├── popup.html             # Extension popup UI
├── popup.js               # Popup logic: status, sync, settings
├── supabase-schema.sql    # Database schema (run in Supabase SQL Editor)
└── icons/                 # Extension icons (16, 48, 128px)
```

## Configuration

All configuration is done through the extension popup — no need to edit files.

| Setting | Description | Default |
|---------|-------------|---------|
| Supabase URL | Your project's REST API URL | — |
| Supabase Anon Key | Public anon key for client access | — |
| Sync Hour | Hour for daily bookmark sync (0-23) | 0 (midnight) |

## Database Schema

The `bookmarks` table stores all saved content:

| Column | Type | Description |
|--------|------|-------------|
| `url` | `TEXT UNIQUE` | Source URL (dedup key) |
| `type` | `TEXT` | `tweet`, `thread`, or `article` |
| `title` | `TEXT` | Auto-generated title |
| `full_text` | `TEXT` | Complete extracted text |
| `author` / `author_handle` | `TEXT` | Content author |
| `category` / `subcategory` | `TEXT` | AI-assigned categories |
| `action_item` | `TEXT` | AI-extracted next step |
| `action_status` | `TEXT` | `pending`, `done`, or `skipped` |
| `key_insights` | `TEXT[]` | AI bullet-point takeaways |

See [`supabase-schema.sql`](supabase-schema.sql) for the full schema with indexes and RLS policies.

## Roadmap

- [x] Chrome extension with floating save button
- [x] Tweet, thread, and article extraction
- [x] Supabase backend with full-text search
- [x] Automated bookmark sync with scroll handling
- [x] Smart upsert (upgrade existing records with richer data)
- [ ] Supabase Edge Function for AI categorization
- [ ] Claude API integration for action item extraction
- [ ] Next.js dashboard with filters and search
- [ ] Multi-user auth support
- [ ] Export to Notion / Obsidian

## License

MIT
