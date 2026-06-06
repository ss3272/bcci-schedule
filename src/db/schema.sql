-- Matches table for Men's team
CREATE TABLE IF NOT EXISTS matches_men (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT UNIQUE NOT NULL,
  series_name TEXT,
  team_home TEXT,
  team_away TEXT,
  venue TEXT,
  city TEXT,
  match_date TEXT,           -- ISO 8601 UTC
  match_date_ist TEXT,       -- Human-readable IST
  match_type TEXT,           -- Test, ODI, T20I, T20, Women's T20I, etc.
  status TEXT DEFAULT 'upcoming', -- upcoming, live, completed
  result TEXT,               -- Match result summary
  score_home TEXT,
  score_away TEXT,
  winner TEXT,
  series_id TEXT,
  raw_data TEXT,             -- JSON blob of scraped fields
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Matches table for Women's team
CREATE TABLE IF NOT EXISTS matches_women (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT UNIQUE NOT NULL,
  series_name TEXT,
  team_home TEXT,
  team_away TEXT,
  venue TEXT,
  city TEXT,
  match_date TEXT,
  match_date_ist TEXT,
  match_type TEXT,
  status TEXT DEFAULT 'upcoming',
  result TEXT,
  score_home TEXT,
  score_away TEXT,
  winner TEXT,
  series_id TEXT,
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Sync log
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_type TEXT NOT NULL,   -- 'cron', 'manual'
  team TEXT NOT NULL,        -- 'men', 'women', 'both'
  status TEXT NOT NULL,      -- 'success', 'partial', 'failed'
  records_inserted INTEGER DEFAULT 0,
  records_updated INTEGER DEFAULT 0,
  records_total INTEGER DEFAULT 0,
  error_message TEXT,
  duration_ms INTEGER,
  snapshot_path TEXT,
  synced_at TEXT DEFAULT (datetime('now'))
);

-- AI usage log
CREATE TABLE IF NOT EXISTS ai_usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reason TEXT NOT NULL,      -- 'fallback_parser', 'series_summary', 'auto_categorize'
  model TEXT DEFAULT 'claude-haiku-3-5',
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  team TEXT,
  series_id TEXT,
  success INTEGER DEFAULT 1,
  error_message TEXT,
  called_at TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_men_status ON matches_men(status);
CREATE INDEX IF NOT EXISTS idx_men_date ON matches_men(match_date);
CREATE INDEX IF NOT EXISTS idx_men_series ON matches_men(series_id);
CREATE INDEX IF NOT EXISTS idx_women_status ON matches_women(status);
CREATE INDEX IF NOT EXISTS idx_women_date ON matches_women(match_date);
CREATE INDEX IF NOT EXISTS idx_women_series ON matches_women(series_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_date ON sync_log(synced_at);
