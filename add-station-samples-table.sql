-- Create station_samples table for persisted chart data (24h, 7d, 30d, yearly)
CREATE TABLE IF NOT EXISTS station_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id TEXT NOT NULL,
    sample_time TEXT NOT NULL,        -- UTC hour bucket, e.g. '2025-12-23T14:00:00Z'
    uptime_pct REAL,                  -- Uptime percentage for that hour
    checks INTEGER DEFAULT 0,         -- Number of checks in that hour
    avg_temp REAL,                    -- Average temperature
    source TEXT DEFAULT 'ingest',     -- 'ingest' or 'backfill'
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(station_id, sample_time)
);

-- Index for fast lookups by station and time range
CREATE INDEX IF NOT EXISTS idx_station_samples_station_time 
ON station_samples(station_id, sample_time);
