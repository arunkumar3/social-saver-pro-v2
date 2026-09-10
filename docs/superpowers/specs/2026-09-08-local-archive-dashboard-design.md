# Local Social Archive — Design

**Date:** 2026-09-08
**Status:** Draft for review
**Supersedes:** the Supabase + Vercel architecture described in `README.md`

## Context

`social-saver-pro-v2` captures tweets, threads, and articles from X into a
hosted Supabase database. Three roadmap items were never built: AI
categorization, action-item extraction, and the dashboard. Every `category`,
`action_item`, and `key_insights` column is empty.

The goal is a comprehensive dashboard over content saved from **both** X and
Instagram, serving four jobs equally: retrieving a specific item, working a
queue of actions, seeing patterns, and feeding downstream work.

Only the first is achievable on current data; the other three depend on
enrichment that does not exist. The dashboard is therefore the last thing
built, not the first.

## Decisions taken

| Decision | Choice |
|---|---|
| Hosting | Fully local. No cloud services. |
| Existing Supabase data | Discarded. Re-sync from source. |
| Database | SQLite via built-in `node:sqlite`, single file, `sqlite-vec` + FTS5 |
| Runtime | Node server on localhost, auto-started at logon |
| Instagram media | Downloaded out-of-browser via yt-dlp / gallery-dl |
| Transcription | faster-whisper on GPU, in a dedicated venv |
| Inference | LM Studio at `localhost:1234` |
| Licensing | Open source throughout |

## Non-goals

- Multi-user support or authentication. Single user, single machine.
- Remote access. The dashboard is reachable only from this machine.
- Cloud backup. The archive lives on local disk.
- Instagram Likes, Collections, Stories. Saved posts only.
- Real-time enrichment. Enrichment is a background queue, deliberately.

## Verified environment

Checked on this machine, 2026-09-08.

| Component | State |
|---|---|
| yt-dlp | 2026.08.19 |
| ffmpeg | 8.0.1 |
| Node | v24.14.0 |
| GPU | RTX 5070, 12 GB, **sm_120** (Blackwell) |
| LM Studio | installed; `lms` CLI at `~/.lmstudio/bin/lms` |
| qwen3-vl-8b | 6.19 GB, vision-language |
| qwen3.6-35b-a3b | 16.34 GB, MoE, ~3B active |
| nomic-embed-text-v1.5 | 84 MB, 768-dim |

### Python environments

Three environments carry relevant packages, and they differ in ways that
matter:

| Environment | torch | whisper | GPU capable |
|---|---|---|---|
| Global Python 3.12 | `2.5.1+cu121` | openai-whisper | No — no sm_120 kernels |
| `MyProjects\recipe-app\venv` | `2.10.0+cpu` | openai-whisper | No — CPU-only build |
| `Documents\ComfyUI\.venv` | `2.10.0+cu130` | — | **Yes** — sm_120 present |

Global torch fails decisively on this GPU:

```
RuntimeError: CUDA error: no kernel image is available for execution on the device
```

Existing Whisper usage on this machine runs in `recipe-app` against a
**CPU-only** torch build. It works correctly; it has never used the GPU.

ComfyUI demonstrates that `torch 2.10.0+cu130` runs on this card. This project
therefore creates its own venv on that known-good version rather than
modifying any existing environment.

## Architecture

```
   X / Twitter                      Instagram
  [content script]              [content script]
   full extraction               URL COLLECTION ONLY
        |                              |
        +----------> POST localhost <--+
                          |
                  [ingest server]  Node + SQLite
                     writes item, returns immediately
                          |
                  [worker] staged queue
                          |
              +-----------+-----------+
              |                       |
        yt-dlp / gallery-dl     LM Studio :1234
        ffmpeg / whisper        qwen3-vl / qwen3.6 / nomic
                          |
                  archive.db  (relational + FTS5 + vec0)
                  media/      (images, video, audio)
                  pdf/        (durable per-item copy)
                          |
                  [dashboard @ localhost]
```

The browser does only what a browser uniquely can: read a logged-in page's
DOM. Everything else happens in processes we control, at a pace we choose.

## Components

### 1. Extension (existing, modified)

Sheds responsibility rather than gaining it. Deleted: `offscreen.html`,
`offscreen.js`, `libs/jspdf.umd.min.js`. Removed from the manifest:
`downloads`, `offscreen`, and the `pbs.twimg.com` host permission. PDF
rendering moves server-side, which also fixes the documented emoji and
non-Latin text loss — jsPDF's WinAnsi fonts cannot represent them.

Saves POST to `http://127.0.0.1:8787/ingest`. If the server is unreachable,
items queue in `chrome.storage` and flush on next contact. The user sees
`Saved ✓` either way; a save must never fail because a background service had
not started yet.

### 2. Twitter sync (existing, fixed)

`background.js:475` opens every bookmark with `active: true`, stealing focus
for roughly 3.5 seconds per item. Two hundred bookmarks is about twelve
minutes of tab-flashing at 9 AM.

Three changes:

- Open tabs in a dedicated **unfocused** window
  (`chrome.windows.create({focused: false})`) rather than the user's current
  window. Unfocused rather than minimized: minimized windows are aggressively
  timer-throttled and X will not finish rendering.
- **Dedup before opening.** Query the local server for known URLs and open
  tabs only for genuinely new bookmarks. On a steady-state archive this turns
  a full sync from hundreds of tabs into a handful.
- Media and PDF work moved server-side, so the tab only needs text.
  `TAB_LOAD_WAIT` drops and 2–3 tabs process concurrently.

The daily 9 AM alarm stays. X tolerates this pattern.

### 3. Instagram capture (new)

Deliberately unlike the Twitter sync.

**Manual trigger only.** No alarm. The user clicks "Sync Instagram" and
watches it run in a visible tab. If Meta presents a checkpoint the user sees
it immediately, rather than discovering an action-block days later.

**URL collection only.** The content script scrolls the Saved grid at human
pace and collects permalinks, `external_id`, and whatever caption text the
grid exposes. It does not open individual posts, fetch media, or touch
`scontent.cdninstagram.com`. Its DOM footprint is indistinguishable from a
person scrolling their own saved page.

Media resolution happens afterward, out of process:

- `yt-dlp --cookies <file>` for Reels and video posts
- `gallery-dl` for image posts and carousels, which yt-dlp handles poorly

**Cookies come from the extension, not from the cookie store.** Spike B
established that `--cookies-from-browser chrome` fails on this machine: Chrome
152 uses app-bound encryption and holds a lock on the cookie database, so
external tools cannot read it (`Could not copy Chrome cookie database`,
yt-dlp issue 7271).

Instead the extension calls `chrome.cookies.getAll({domain: 'instagram.com'})`
and posts the result to the server, which writes a Netscape `cookies.txt` for
the downloaders. Chrome grants its own extension the access it denies external
processes, so this sidesteps both the lock and the encryption. It costs one
`cookies` permission and a `https://*.instagram.com/*` host permission.

Cookies are refreshed on every manual sync, since Instagram rotates them.

Downloads are rate-limited and serialized. This is a background queue with no
deadline.

### 4. Worker pipeline (new)

Per-item state machine, persisted on the row:

```
pending -> media -> transcribed -> described -> enriched -> embedded
                                                              |
                                                           failed
```

Every stage is resumable. A crash at item 340 of 500 resumes at 340 without
re-downloading or re-transcribing. Given the queue runs for hours, a pipeline
that cannot resume is one the user runs once and abandons.

Stages run **batched by stage, not per item**: transcribe everything, then
describe everything, then enrich everything. Model load and unload dominates
cost when only one model fits in 12 GB at a time, so per-item round-robin
across models would be dramatically slower.

| Stage | Tool | Produces |
|---|---|---|
| media | yt-dlp / gallery-dl | files on disk, `media` rows |
| transcribed | ffmpeg → faster-whisper | `items.transcript` |
| described | qwen3-vl-8b | `items.visual_description` |
| enriched | qwen3.6-35b-a3b | category, action item, insights, summary |
| embedded | nomic-embed-text-v1.5 | `chunks` + `vec_chunks` |

The assembled `document` — caption plus transcript plus visual description —
is what gets enriched and embedded. A Reel with an emoji-only caption still
becomes searchable text, which is the entire point of the transcription path.

PDF rendering happens after enrichment so the durable copy includes the
summary.

### 5. Dashboard (new)

Served by the same Node process at `127.0.0.1:8787`. Because the server owns
the media directory, images render inline from disk — no expired-CDN
placeholders — and each item links to its local PDF.

Four views matching the four stated jobs: **Browse/Search**, **Action queue**,
**Insights**, **Export**. Export writes Markdown with local media references,
suitable for Obsidian.

The dashboard also surfaces pipeline health: last successful sync per
platform, queue depth, and failed items with their errors. Without this a
stalled server or an expired Instagram cookie stays invisible until the
archive has silently stopped growing.

## Data model

Single file, `archive.db`. Relational metadata, keyword index, and vectors in
one database, so a filtered semantic query is one SQL statement rather than a
fan-out across two stores with reconciliation between them.

```sql
CREATE TABLE items (
  id            INTEGER PRIMARY KEY,
  platform      TEXT NOT NULL CHECK (platform IN ('twitter','instagram')),
  kind          TEXT NOT NULL,   -- tweet|thread|article|post|reel|carousel
  url           TEXT NOT NULL UNIQUE,
  external_id   TEXT,
  author        TEXT DEFAULT '',
  author_handle TEXT DEFAULT '',
  title         TEXT DEFAULT '',

  caption            TEXT DEFAULT '',  -- from the platform
  transcript         TEXT DEFAULT '',  -- from whisper
  visual_description TEXT DEFAULT '',  -- from the VLM
  document           TEXT DEFAULT '',  -- assembled, enriched and embedded

  category      TEXT,
  subcategory   TEXT,
  summary       TEXT,
  action_item   TEXT,
  action_status TEXT DEFAULT 'pending'
                CHECK (action_status IN ('pending','done','skipped')),
  key_insights  TEXT,               -- JSON array

  state         TEXT NOT NULL DEFAULT 'pending',
  state_error   TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,

  pdf_path      TEXT,
  source_date   TEXT,
  saved_at      TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE media (
  id         INTEGER PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,   -- image|video|audio|thumb
  path       TEXT NOT NULL,
  bytes      INTEGER,
  width      INTEGER,
  height     INTEGER,
  duration_s REAL,
  sha256     TEXT,
  downloader TEXT             -- yt-dlp|gallery-dl
);

CREATE TABLE chunks (
  id       INTEGER PRIMARY KEY,
  item_id  INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  ord      INTEGER NOT NULL,
  text     TEXT NOT NULL
);

CREATE VIRTUAL TABLE vec_chunks USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding FLOAT[768]
);

CREATE VIRTUAL TABLE items_fts USING fts5(
  title, caption, transcript, visual_description,
  content='items', content_rowid='id'
);

CREATE TABLE job_runs (
  id      INTEGER PRIMARY KEY,
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  stage   TEXT NOT NULL,
  status  TEXT NOT NULL,   -- ok|error
  error   TEXT,
  ms      INTEGER,
  ran_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
```

A long thread produces several chunks, so one item maps to many vectors.
Embedding a whole thread as a single vector loses the specific paragraph the
user is trying to find.

`nomic-embed-text-v1.5` requires task prefixes: `search_document: ` when
embedding chunks, `search_query: ` when embedding a query. Omitting them
measurably degrades retrieval.

## Search

Hybrid, because neither mode alone suffices. Keyword search finds a remembered
handle or an exact phrase. Semantic search finds "that thing about retrieval
latency" when the item never used those words.

Both run, then merge by Reciprocal Rank Fusion:

```
score(d) = sum over rankers of 1 / (60 + rank(d))
```

RRF needs no score calibration between BM25 and cosine distance, which is what
makes it robust here. Filters — platform, category, action status, date —
apply as SQL predicates before fusion.

## HTTP interface

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness, for the extension's queue flush |
| POST | `/ingest` | batch item upsert from the extension |
| POST | `/known-urls` | dedup check before the sync opens tabs |
| GET | `/api/items` | list with filters and pagination |
| GET | `/api/search` | hybrid, keyword, or semantic |
| GET | `/api/stats` | aggregates for the insights view |
| GET | `/api/queue` | pipeline health and failures |
| PATCH | `/api/items/:id` | action status changes |
| POST | `/api/sync/instagram` | trigger a manual Instagram sync |
| GET | `/media/:id` | serve a file from disk |

The server listens on `127.0.0.1:8787` only. Not reachable from the network.

## Error handling

The governing principle: **a failure in an optional stage must never lose the
item**. Ingest is the only operation that must succeed. Media download,
transcription, description, and enrichment are best-effort and retryable.

- Ingest writes the row and returns before any heavy work begins.
- Stage failures increment `attempts`, record `state_error`, and log to
  `job_runs`. After three attempts an item parks in `failed` and stops
  consuming queue time.
- Failed items remain fully visible in the dashboard with caption and
  permalink. A Reel that would not transcribe is still a saved Reel.
- Expired Instagram cookies are the expected recurring failure. They surface
  as a distinct, named error in the queue view rather than a generic download
  failure, because the fix is specific: log back into Instagram in Chrome.

## Operations

Two services start at logon via one Task Scheduler task:

1. `lms server start` — LM Studio's headless API on `:1234`
2. the ingest server

The ingest server tolerates LM Studio being absent: ingest, media download,
and transcription all work without it. Only description, enrichment, and
embedding require it, and they wait rather than fail.

## Phasing

**Phase 0 — Environment.** Create a project venv on `torch 2.10.0+cu130` (the
version ComfyUI already proves works on this GPU) with `faster-whisper` and
`gallery-dl`. No existing environment is modified. Log in `INSTALLED.md`.
(Both spikes are already complete — see *Risks and spikes*.)

**Phase 1 — Database and capture.** Schema, ingest server, auto-start,
extension repointed at localhost, Twitter sync fixed, Instagram URL
collection, yt-dlp and gallery-dl media resolution. Ends with a populated
archive of both platforms, media on disk, no enrichment.

**Phase 2 — Enrichment.** Whisper, VLM description, LLM enrichment,
embeddings, server-side PDF. Ends with a fully searchable archive.

**Phase 3 — Dashboard.** The four views, over data that is already complete.

Phase 1 is the stated priority and stands alone: even without enrichment it
produces a durable local archive that the current cloud setup does not.

**Scope of the implementation plan that follows this spec: Phases 0 and 1
only.** Phases 2 and 3 are described here so the Phase 1 data model is built
to serve them, but each gets its own plan once Phase 1 has run against real
data. Planning enrichment in detail before seeing what the archive actually
contains would be guesswork.

## Risks and spikes

Both spikes were run on 2026-09-08. Results below.

**Spike A — `sqlite-vec` on Windows x64 / Node 24: PASS.** The
`sqlite-vec-windows-x64` prebuild loads into Node 24's built-in `node:sqlite`
via `enableLoadExtension` — no `better-sqlite3`, and therefore no native
compiled dependency anywhere in the project. Verified with a `vec0` table of
500 x 768-dim vectors: KNN returned in 0.9 ms with the query vector ranked
first. LanceDB fallback is not needed.

One binding detail: `node:sqlite` requires `BigInt` for `INTEGER PRIMARY KEY`
values on a `vec0` table. A plain JavaScript number raises
`Only integers are allowed for primary key values`.

**Spike B — Instagram media retrieval: the original approach failed; a better
one was found.** `--cookies-from-browser chrome` does not work on this
machine — Chrome 152's app-bound encryption plus a file lock produce
`Could not copy Chrome cookie database`. The design now sources cookies from
the extension instead (see *Instagram capture*), and `yt-dlp --cookies <file>`
was confirmed to parse a Netscape cookie file and reach Instagram's API.

**Spike B residual closed, 2026-09-10.** A real exported Chrome session was
exercised end to end. The extension's `chrome.cookies.getAll` returned 10
Instagram cookies including `sessionid`; the server wrote them to a Netscape
file; `yt-dlp --cookies` authenticated against a saved Reel and the media stage
downloaded it unattended (VP9 1080x1920, AAC, 43.4 s, 18.2 MB) with the `items`
row advancing `pending -> media` and a `media` row recorded. The Instagram media
path is proven.

Two findings from that verification change later phases:

1. **`gallery-dl` is close to dead weight for this archive.** Paging 42 saved
   posts returned reels exclusively — no image posts, no carousels. The
   downloader routing stays (a saved image post would still work), but the
   gallery-dl branch is effectively untravelled in practice.

2. **Whisper, not the vision model, is the critical path for Phase 2.** An
   all-video archive is searchable only to the extent its audio is transcribed.
   `qwen3-vl-8b` matters far less than this spec assumed when it weighted
   vision description equally with transcription.

Standing risks:

- **Meta changes the Saved-grid DOM.** Not if, but when. The X extractor has
  needed this twice already (`47bb6f7`, `782272e`). Selectors live in one
  module so repair stays contained.
- **Single copy of the archive.** Local-only was chosen deliberately; a failed
  drive is a lost archive. The media directory should sit somewhere backed up.
- **12 GB VRAM ceiling.** qwen3.6-35b exceeds it and runs partly offloaded.
  Acceptable for a background queue, unacceptable for interactive use — which
  is why nothing in the request path calls it.

## Testing

- **Extraction** is tested against saved HTML fixtures of real X and Instagram
  pages. Fixtures make DOM breakage a failing test rather than a silent
  regression, and they can be refreshed when the platforms change.
- **Pipeline stages** are tested independently against a fake LM Studio and a
  fake downloader. Every stage must be provably resumable: kill mid-run,
  restart, assert no duplicated work.
- **Search** is tested on a seeded corpus with known expected hits for
  keyword, semantic, and hybrid modes, including the nomic prefix behaviour.
- **The offline path** is tested explicitly: server down, extension queues,
  server returns, queue flushes, nothing lost.
