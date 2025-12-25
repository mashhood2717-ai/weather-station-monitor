-- Create station_samples table for storing hourly aggregated data for charts
CREATE TABLE IF NOT EXISTS station_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id TEXT NOT NULL,
  sample_time TEXT NOT NULL,  -- UTC hour bucket, e.g. '2025-12-23T14:00:00Z'
  uptime_pct REAL,            -- uptime percentage for this hour
  checks INTEGER DEFAULT 0,   -- number of checks in this hour
  avg_temp REAL,              -- average temperature in this hour
  source TEXT DEFAULT 'ingest', -- 'ingest' or 'backfill'
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(station_id, sample_time)
);

-- Index for fast queries by station and time range
CREATE INDEX IF NOT EXISTS idx_station_samples_station_time ON station_samples(station_id, sample_time);
