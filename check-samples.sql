-- Check station_samples table
SELECT COUNT(*) as total_samples FROM station_samples;
SELECT station_id, sample_time, uptime_pct, checks FROM station_samples LIMIT 10;
