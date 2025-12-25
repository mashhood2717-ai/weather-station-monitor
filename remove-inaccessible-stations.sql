-- Remove inaccessible stations that return 404 errors
-- These stations exist in WeatherLink but we don't have API access

-- Delete status logs first (foreign key constraint)
DELETE FROM status_logs WHERE station_id IN (
  SELECT station_id FROM stations 
  WHERE station_name IN ('Chakwal City WW', 'Comsats University Vehari', 'Chichawatni')
);

-- Delete downtime records
DELETE FROM downtime_records WHERE station_id IN (
  SELECT station_id FROM stations 
  WHERE station_name IN ('Chakwal City WW', 'Comsats University Vehari', 'Chichawatni')
);

-- Delete the stations
DELETE FROM stations 
WHERE station_name IN ('Chakwal City WW', 'Comsats University Vehari', 'Chichawatni');
