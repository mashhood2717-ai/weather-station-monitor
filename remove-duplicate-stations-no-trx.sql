-- remove-duplicate-stations-no-trx.sql
-- Deletes duplicate rows in `stations`, keeping the first (lowest ROWID) per station_id
DELETE FROM stations
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM stations GROUP BY station_id
);

-- Report counts after dedupe
SELECT (SELECT COUNT(*) FROM stations) AS total_rows, (SELECT COUNT(DISTINCT station_id) FROM stations) AS unique_ids;
