-- ============================================================
-- STATION ISSUES TABLE
-- Tracks issues/complaints for stations
-- ============================================================
CREATE TABLE IF NOT EXISTS station_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'open',  -- open, in_progress, resolved, unresolvable
    priority TEXT DEFAULT 'medium',  -- low, medium, high, critical
    assigned_to TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT,
    
    FOREIGN KEY (station_id) REFERENCES stations(station_id) ON DELETE CASCADE
);

-- ============================================================
-- ISSUE CALLS TABLE
-- Tracks each call attempt made for an issue
-- ============================================================
CREATE TABLE IF NOT EXISTS issue_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL,
    station_id TEXT NOT NULL,
    caller_name TEXT NOT NULL,
    contact_person TEXT,
    call_time TEXT DEFAULT (datetime('now')),
    duration_minutes INTEGER,
    outcome TEXT DEFAULT 'no_answer',  -- answered, no_answer, busy, voicemail, callback_scheduled
    notes TEXT,
    
    FOREIGN KEY (issue_id) REFERENCES station_issues(id) ON DELETE CASCADE,
    FOREIGN KEY (station_id) REFERENCES stations(station_id) ON DELETE CASCADE
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_issues_station ON station_issues(station_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON station_issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_created ON station_issues(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_assigned ON station_issues(assigned_to);

CREATE INDEX IF NOT EXISTS idx_calls_issue ON issue_calls(issue_id);
CREATE INDEX IF NOT EXISTS idx_calls_station ON issue_calls(station_id);
CREATE INDEX IF NOT EXISTS idx_calls_time ON issue_calls(call_time DESC);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON issue_calls(caller_name);
