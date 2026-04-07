-- Covering index for the most common query pattern:
-- WHERE timestamp >= X GROUP BY station_id with SUM(is_online)
-- This enables index-only scans, avoiding table lookups entirely
CREATE INDEX IF NOT EXISTS idx_status_logs_ts_station_online 
ON status_logs(timestamp, station_id, is_online);
