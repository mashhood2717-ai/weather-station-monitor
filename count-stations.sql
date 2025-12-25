-- count-stations.sql
SELECT COUNT(*) AS total_rows FROM stations;
SELECT COUNT(DISTINCT station_id) AS unique_ids FROM stations;
SELECT COUNT(*) AS samples_count FROM station_samples;
