-- rain_gauge_logs: one row per gauge per poll, recording only the online/offline
-- bit. Rain totals (24h, 7d, 30d, 1y, all-time) are NOT stored here — those come
-- live from the upstream rain-gauge-backend API on every dashboard fetch.

CREATE TABLE IF NOT EXISTS rain_gauge_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    gauge_id    TEXT NOT NULL,
    timestamp   DATETIME NOT NULL DEFAULT (datetime('now')),
    is_online   INTEGER NOT NULL,  -- 1 = online, 0 = offline
    UNIQUE (gauge_id, timestamp)
);

-- Covering index for the uptime aggregation query
--   WHERE timestamp >= datetime('now', '-24 hours') GROUP BY gauge_id
-- Order matters: timestamp first so SQLite can short-circuit the range scan,
-- gauge_id second so GROUP BY can use the index, is_online last so SUM(...) is
-- index-only (no table lookup needed).
CREATE INDEX IF NOT EXISTS idx_rgl_ts_gauge_online
    ON rain_gauge_logs (timestamp, gauge_id, is_online);

-- Per-gauge most-recent-row lookup (for "last seen online" queries)
CREATE INDEX IF NOT EXISTS idx_rgl_gauge_ts
    ON rain_gauge_logs (gauge_id, timestamp DESC);

-- ──────────────────────────────────────────────────────────────────────
-- weather_station_readings: full meteorological snapshot for each weather
-- station on every poll (15 min). Unlike rain gauges (which only store the
-- online bit) we capture the sensor values too because we DO want a
-- historical chart of temperature/humidity/wind/pressure for these.
--
-- Rolling 1-year window — the Worker cron runs a DELETE every tick to
-- evict rows older than 1 year. Storage stays bounded forever.
--
-- Per-device per-15-min volume at 3 WS:
--   3 × 96 = 288 rows/day  →  ~105K rows/year  →  ~10 MB/year (with
--   indexes). Trivial against D1's 5 GB free tier.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS weather_station_readings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT NOT NULL,
    timestamp       DATETIME NOT NULL DEFAULT (datetime('now')),
    temperature     REAL,
    humidity        REAL,
    wind_direction  REAL,
    wind_speed      REAL,
    pressure        REAL,
    heat_index      REAL,
    UNIQUE (device_id, timestamp)
);

-- Per-device history queries (24h / 7d / 30d / 1y charts)
CREATE INDEX IF NOT EXISTS idx_wsr_device_ts
    ON weather_station_readings (device_id, timestamp DESC);

-- Cleanup query: DELETE WHERE timestamp < datetime('now', '-1 year').
-- Standalone timestamp index so the rolling-window evict short-circuits
-- through the index instead of full-scanning the table.
CREATE INDEX IF NOT EXISTS idx_wsr_ts
    ON weather_station_readings (timestamp);
