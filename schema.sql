-- Davis WeatherLink Monitor - Database Schema
-- schema.sql

-- ============================================================
-- STATIONS TABLE
-- Stores metadata for all weather stations
-- ============================================================
CREATE TABLE IF NOT EXISTS stations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id TEXT UNIQUE NOT NULL,
    station_name TEXT NOT NULL,
    location TEXT,
    latitude REAL,
    longitude REAL,
    install_date TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- STATUS LOGS TABLE
-- Records every status check (every 30 minutes)
-- ============================================================
CREATE TABLE IF NOT EXISTS status_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now')),
    is_online INTEGER DEFAULT 1,  -- 1 = online, 0 = offline
    
    -- Weather data
    temperature REAL,
    humidity REAL,
    pressure REAL,
    wind_speed REAL,
    wind_direction INTEGER,
    rainfall REAL,
    solar_radiation INTEGER,
    
    -- Performance metrics
    response_time_ms INTEGER,
    
    -- Error tracking
    error_message TEXT,
    error_code TEXT,
    
    FOREIGN KEY (station_id) REFERENCES stations(station_id) ON DELETE CASCADE
);

-- ============================================================
-- DOWNTIME RECORDS TABLE
-- Tracks when stations go offline and come back online
-- ============================================================
CREATE TABLE IF NOT EXISTS downtime_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT,
    duration_minutes INTEGER,
    status TEXT DEFAULT 'active',  -- 'active' or 'resolved'
    
    -- Optional: reason tracking
    reason TEXT,
    resolved_by TEXT,
    notes TEXT,
    
    created_at TEXT DEFAULT (datetime('now')),
    
    FOREIGN KEY (station_id) REFERENCES stations(station_id) ON DELETE CASCADE
);

-- ============================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================

-- Status logs indexes
CREATE INDEX IF NOT EXISTS idx_status_logs_station 
    ON status_logs(station_id);

CREATE INDEX IF NOT EXISTS idx_status_logs_timestamp 
    ON status_logs(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_status_logs_online 
    ON status_logs(is_online, timestamp);

CREATE INDEX IF NOT EXISTS idx_status_logs_station_timestamp 
    ON status_logs(station_id, timestamp DESC);

-- Downtime records indexes
CREATE INDEX IF NOT EXISTS idx_downtime_station 
    ON downtime_records(station_id);

CREATE INDEX IF NOT EXISTS idx_downtime_status 
    ON downtime_records(status);

CREATE INDEX IF NOT EXISTS idx_downtime_start_time 
    ON downtime_records(start_time DESC);

CREATE INDEX IF NOT EXISTS idx_downtime_active 
    ON downtime_records(station_id, status) 
    WHERE status = 'active';

-- Stations index
CREATE INDEX IF NOT EXISTS idx_stations_location 
    ON stations(location);

-- ============================================================
-- VIEWS FOR COMMON QUERIES
-- ============================================================

-- Current station status view
CREATE VIEW IF NOT EXISTS current_station_status AS
SELECT 
    s.station_id,
    s.station_name,
    s.location,
    s.latitude,
    s.longitude,
    sl.is_online,
    sl.temperature,
    sl.humidity,
    sl.pressure,
    sl.wind_speed,
    sl.timestamp as last_seen,
    CASE 
        WHEN sl.is_online = 1 THEN 'online'
        ELSE 'offline'
    END as status
FROM stations s
LEFT JOIN (
    SELECT 
        station_id,
        is_online,
        temperature,
        humidity,
        pressure,
        wind_speed,
        timestamp,
        ROW_NUMBER() OVER (PARTITION BY station_id ORDER BY timestamp DESC) as rn
    FROM status_logs
) sl ON s.station_id = sl.station_id AND sl.rn = 1;

-- Active downtime view
CREATE VIEW IF NOT EXISTS active_downtime AS
SELECT 
    s.station_id,
    s.station_name,
    s.location,
    d.start_time,
    ROUND((julianday('now') - julianday(d.start_time)) * 24 * 60) as downtime_minutes,
    CASE 
        WHEN (julianday('now') - julianday(d.start_time)) * 24 * 60 < 60 
        THEN ROUND((julianday('now') - julianday(d.start_time)) * 24 * 60) || ' min'
        WHEN (julianday('now') - julianday(d.start_time)) * 24 < 24
        THEN ROUND((julianday('now') - julianday(d.start_time)) * 24, 1) || ' hr'
        ELSE ROUND((julianday('now') - julianday(d.start_time)), 1) || ' days'
    END as downtime_formatted
FROM downtime_records d
JOIN stations s ON d.station_id = s.station_id
WHERE d.status = 'active'
ORDER BY d.start_time ASC;

-- Station uptime percentage (last 24 hours)
CREATE VIEW IF NOT EXISTS station_uptime_24h AS
SELECT 
    station_id,
    COUNT(*) as total_checks,
    SUM(is_online) as online_checks,
    ROUND(SUM(is_online) * 100.0 / COUNT(*), 2) as uptime_percentage
FROM status_logs
WHERE timestamp > datetime('now', '-24 hours')
GROUP BY station_id;

-- ============================================================
-- STATION SAMPLES TABLE
-- Periodic aggregated samples for charting (hourly by default)
-- ============================================================
CREATE TABLE IF NOT EXISTS station_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id TEXT NOT NULL,
    sample_time TEXT NOT NULL, -- UTC timestamp of the sample (e.g. 2025-12-24 14:00:00)
    uptime_pct REAL,
    checks INTEGER DEFAULT 0,
    avg_temp REAL,
    source TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(station_id, sample_time)
);

CREATE INDEX IF NOT EXISTS idx_station_samples_station_time ON station_samples(station_id, sample_time DESC);

-- ============================================================
-- TRIGGER FOR UPDATED_AT
-- ============================================================

CREATE TRIGGER IF NOT EXISTS update_stations_timestamp 
AFTER UPDATE ON stations
BEGIN
    UPDATE stations 
    SET updated_at = datetime('now') 
    WHERE id = NEW.id;
END;

-- ============================================================
-- SAMPLE DATA INSERTION
-- ============================================================

-- Example: Insert a test station
-- INSERT INTO stations (station_id, station_name, location, latitude, longitude, install_date) 
-- VALUES ('123456', 'Test Station', 'Lahore, Pakistan', 31.5204, 74.3587, '2024-01-01');

-- ============================================================
-- CLEANUP QUERIES (Run periodically to manage database size)
-- ============================================================

-- Delete status logs older than 90 days (keep database small)
-- DELETE FROM status_logs WHERE timestamp < datetime('now', '-90 days');

-- Delete resolved downtime records older than 180 days
-- DELETE FROM downtime_records WHERE status = 'resolved' AND end_time < datetime('now', '-180 days');

-- ============================================================
-- USEFUL QUERIES FOR MONITORING
-- ============================================================

-- Get stations offline for more than 1 hour
-- SELECT * FROM active_downtime WHERE downtime_minutes > 60;

-- Get stations with lowest uptime in last 24 hours
-- SELECT s.station_name, u.uptime_percentage 
-- FROM station_uptime_24h u
-- JOIN stations s ON u.station_id = s.station_id
-- ORDER BY u.uptime_percentage ASC LIMIT 10;

-- Count total status checks
-- SELECT COUNT(*) as total_checks FROM status_logs;

-- Database size check (approximate)
-- SELECT page_count * page_size as size_bytes FROM pragma_page_count(), pragma_page_size();
