-- count-stations-basic.sql
SELECT COUNT(*) AS total_rows FROM stations;
SELECT COUNT(DISTINCT station_id) AS unique_ids FROM stations;
