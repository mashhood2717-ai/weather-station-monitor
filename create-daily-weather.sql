-- Daily weather extremes table
-- One row per station, overwritten every sync (12am-12am PKT window)
-- Resets at midnight PKT

CREATE TABLE IF NOT EXISTS daily_weather (
  station_id TEXT PRIMARY KEY,
  date_pkt TEXT NOT NULL,          -- Current PKT date, e.g. '2026-03-11'
  min_temp REAL,
  max_temp REAL,
  total_rainfall REAL DEFAULT 0,
  max_wind_speed REAL DEFAULT 0,
  last_updated TEXT DEFAULT (datetime('now'))
);
