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
