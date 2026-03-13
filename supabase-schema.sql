-- ═══════════════════════════════════════════════════════════════
-- Social Saver Pro v2 — Supabase Schema
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- ═══════════════════════════════════════════════════════════════

-- Bookmarks table: stores all saved content
CREATE TABLE IF NOT EXISTS bookmarks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  
  -- Content
  url TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('tweet', 'thread', 'article')),
  title TEXT DEFAULT '',
  author TEXT DEFAULT '',
  author_handle TEXT DEFAULT '',
  full_text TEXT DEFAULT '',
  images TEXT[] DEFAULT '{}',
  
  -- Dates
  source_date TIMESTAMPTZ,  -- when the tweet/article was originally posted
  saved_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- AI-generated fields (populated by Edge Function)
  category TEXT,            -- e.g. 'AI/ML', 'Trading', 'AI Projects'
  subcategory TEXT,         -- more specific grouping
  action_item TEXT,         -- extracted next step
  action_status TEXT DEFAULT 'pending' CHECK (action_status IN ('pending', 'done', 'skipped')),
  key_insights TEXT[],      -- bullet-point takeaways
  ai_processed BOOLEAN DEFAULT FALSE,
  ai_processed_at TIMESTAMPTZ,
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_bookmarks_url ON bookmarks(url);
CREATE INDEX IF NOT EXISTS idx_bookmarks_category ON bookmarks(category);
CREATE INDEX IF NOT EXISTS idx_bookmarks_action_status ON bookmarks(action_status);
CREATE INDEX IF NOT EXISTS idx_bookmarks_saved_at ON bookmarks(saved_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookmarks_ai_processed ON bookmarks(ai_processed);

-- Full-text search index
CREATE INDEX IF NOT EXISTS idx_bookmarks_fulltext ON bookmarks 
  USING GIN (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(full_text, '')));

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_bookmarks_updated_at
  BEFORE UPDATE ON bookmarks
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ═══════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY (RLS)
-- ═══════════════════════════════════════════════════════════════
-- For now, using anon key with permissive policies.
-- When we add auth later, we'll tighten these per-user.

ALTER TABLE bookmarks ENABLE ROW LEVEL SECURITY;

-- Allow anon key full access (single-user for now)
CREATE POLICY "Allow all access for anon" ON bookmarks
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- HELPER: Search function for the dashboard
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION search_bookmarks(search_query TEXT)
RETURNS SETOF bookmarks AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM bookmarks
  WHERE to_tsvector('english', coalesce(title, '') || ' ' || coalesce(full_text, ''))
    @@ plainto_tsquery('english', search_query)
  ORDER BY saved_at DESC;
END;
$$ LANGUAGE plpgsql;
