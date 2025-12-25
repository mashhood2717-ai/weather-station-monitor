-- Check sample data and station_id types
SELECT station_id, sample_time, uptime_pct FROM station_samples ORDER BY sample_time DESC LIMIT 5;
SELECT DISTINCT station_id FROM station_samples LIMIT 10;
