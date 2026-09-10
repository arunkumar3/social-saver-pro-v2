CREATE TABLE IF NOT EXISTS items (
  id            INTEGER PRIMARY KEY,
  platform      TEXT NOT NULL CHECK (platform IN ('twitter','instagram')),
  kind          TEXT NOT NULL,
  url           TEXT NOT NULL UNIQUE,
  external_id   TEXT,
  author        TEXT DEFAULT '',
  author_handle TEXT DEFAULT '',
  title         TEXT DEFAULT '',
  caption            TEXT DEFAULT '',
  transcript         TEXT DEFAULT '',
  visual_description TEXT DEFAULT '',
  document           TEXT DEFAULT '',
  category      TEXT,
  subcategory   TEXT,
  summary       TEXT,
  action_item   TEXT,
  action_status TEXT DEFAULT 'pending'
                CHECK (action_status IN ('pending','done','skipped')),
  key_insights  TEXT,
  state         TEXT NOT NULL DEFAULT 'pending',
  state_error   TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  pdf_path      TEXT,
  source_date   TEXT,
  saved_at      TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media (
  id         INTEGER PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  path       TEXT NOT NULL,
  bytes      INTEGER,
  width      INTEGER,
  height     INTEGER,
  duration_s REAL,
  sha256     TEXT,
  downloader TEXT
);

CREATE TABLE IF NOT EXISTS chunks (
  id      INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  ord     INTEGER NOT NULL,
  text    TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding FLOAT[768]
);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, caption, transcript, visual_description,
  content='items', content_rowid='id'
);

CREATE TABLE IF NOT EXISTS job_runs (
  id      INTEGER PRIMARY KEY,
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  stage   TEXT NOT NULL,
  status  TEXT NOT NULL,
  error   TEXT,
  ms      INTEGER,
  ran_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

-- items_fts is an external-content table: it stores no text of its own and
-- must be told about every write, or search silently returns nothing.
CREATE TRIGGER IF NOT EXISTS items_fts_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, caption, transcript, visual_description)
  VALUES (new.id, new.title, new.caption, new.transcript, new.visual_description);
END;

CREATE TRIGGER IF NOT EXISTS items_fts_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, caption, transcript, visual_description)
  VALUES ('delete', old.id, old.title, old.caption, old.transcript, old.visual_description);
END;

CREATE TRIGGER IF NOT EXISTS items_fts_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, caption, transcript, visual_description)
  VALUES ('delete', old.id, old.title, old.caption, old.transcript, old.visual_description);
  INSERT INTO items_fts(rowid, title, caption, transcript, visual_description)
  VALUES (new.id, new.title, new.caption, new.transcript, new.visual_description);
END;

CREATE INDEX IF NOT EXISTS idx_items_state    ON items(state);
CREATE INDEX IF NOT EXISTS idx_items_platform ON items(platform);
CREATE INDEX IF NOT EXISTS idx_items_saved_at ON items(saved_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_action   ON items(action_status);
CREATE INDEX IF NOT EXISTS idx_media_item     ON media(item_id);
CREATE INDEX IF NOT EXISTS idx_chunks_item    ON chunks(item_id);
