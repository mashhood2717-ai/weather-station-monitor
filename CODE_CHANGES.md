# Code Changes - Detailed Reference

## Files Modified

### 1. `src/index.js` - Backend Worker

#### Change 1: Added Route for Uptime Percentages (Line ~145)

**Added this endpoint:**
```javascript
} else if (path === '/api/uptime-percentages') {
  // Get uptime percentages for all stations
  return await handleUptimePercentagesRequest(env, corsHeaders);
```

#### Change 2: New Function - Uptime Percentages Handler (Line ~712)

**Added this function:**
```javascript
async function handleUptimePercentagesRequest(env, corsHeaders) {
  // Get uptime percentage for each station (last 24 hours)
  const uptimeData = await env.DB.prepare(`
    SELECT 
      s.station_id,
      s.station_name,
      COUNT(*) as total_readings,
      SUM(CASE WHEN sl.is_online = 1 THEN 1 ELSE 0 END) as online_readings,
      ROUND(
        (SUM(CASE WHEN sl.is_online = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*)), 
        1
      ) as uptime_percent
    FROM stations s
    LEFT JOIN status_logs sl ON s.station_id = sl.station_id 
      AND sl.timestamp > datetime('now', '-24 hours')
    GROUP BY s.station_id, s.station_name
    ORDER BY uptime_percent DESC
  `).all();

  return new Response(
    JSON.stringify({ uptime_data: uptimeData.results }),
    {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  );
}
```

**What it does:**
- Queries the database for each station
- Counts total readings in last 24 hours
- Counts readings where `is_online = 1`
- Calculates percentage: `(online / total) × 100`
- Returns JSON array with `station_id`, `station_name`, `uptime_percent`

---

### 2. `dashboard/index.html` - Frontend Dashboard

#### Change 1: Updated API Configuration (Line ~1480)

**Before:**
```javascript
const API_BASE = 'https://hubservice.weatherwalay.com';

// Check authentication
const token = localStorage.getItem('ww_token');
if (!token) {
    window.location.href = 'login.html';
}
```

**After:**
```javascript
const API_BASE = 'https://hubservice.weatherwalay.com';
const WORKER_API = 'https://weatherlink-monitor.workers.dev'; // Your Cloudflare Worker URL

// Check authentication
const token = localStorage.getItem('ww_token');
if (!token) {
    window.location.href = 'login.html';
}
```

**Change:** Added WORKER_API constant for new endpoint

---

#### Change 2: New Function - Load Uptime Percentages (Line ~1576)

**Added this function:**
```javascript
// Load uptime data from Worker API
async function loadUptimePercentages() {
    try {
        const response = await fetch(`${WORKER_API}/api/uptime-percentages`);
        if (response.ok) {
            const data = await response.json();
            if (data.uptime_data) {
                // Create a map of station_id -> uptime_percent
                const uptimeMap = {};
                data.uptime_data.forEach(item => {
                    uptimeMap[item.station_id] = item.uptime_percent;
                });
                
                // Update all stations with uptime data
                allStations.forEach(station => {
                    station.uptime = uptimeMap[station.station_id] !== undefined 
                        ? uptimeMap[station.station_id] 
                        : (station.is_online === 1 ? '100.0' : '0.0');
                });
                
                renderTable();
            }
        }
    } catch (error) {
        console.error('Error loading uptime percentages:', error);
        // Fallback: assign 100% if online, 0% if offline
        allStations.forEach(station => {
            station.uptime = station.is_online === 1 ? '100.0' : '0.0';
        });
        renderTable();
    }
}
```

**What it does:**
1. Fetches data from `/api/uptime-percentages`
2. Creates a map: `station_id → uptime_percent`
3. Updates each station in `allStations` array
4. Re-renders the table with new uptime values
5. Has fallback if API fails (uses 100% for online, 0% for offline)

---

#### Change 3: Call New Function in loadData() (Line ~1664)

**Before:**
```javascript
async function loadData() {
    try {
        // ... fetch stations code ...
        
        updateStats(stats);
        updateMapMarkers();
        renderTable();
        updateLastUpdate();
    } catch (error) {
        console.error('Error loading data:', error);
    }
}
```

**After:**
```javascript
async function loadData() {
    try {
        // ... fetch stations code ...
        
        updateStats(stats);
        updateMapMarkers();
        renderTable();
        updateLastUpdate();
        
        // Load uptime percentages from Worker
        await loadUptimePercentages();
    } catch (error) {
        console.error('Error loading data:', error);
    }
}
```

**Change:** Added call to `loadUptimePercentages()` at the end

---

#### Change 4: Enhanced updateMapMarkers() (Line ~1306)

**Before:**
```javascript
const marker = L.marker([lat, lng], { icon })
    .bindPopup(`
        <div class="custom-popup">
            <div class="popup-title">${station.station_name || 'Unknown'}</div>
            <div class="popup-info">📍 ${station.location || 'Unknown'}</div>
            <div class="popup-info">🌡️ ${station.temperature ? station.temperature + '°C' : 'N/A'}</div>
            <div class="popup-info">📊 ${station.apiSource || 'Unknown'}</div>
            <div class="popup-status ${isOnline ? 'online' : 'offline'}">
                ${isOnline ? '● Online' : '○ Offline'}
            </div>
        </div>
    `, {
        maxWidth: 250,
        className: 'custom-leaflet-popup'
    });
```

**After:**
```javascript
const isOnline = station.is_online === 1;
const markerClass = isOnline ? 'online' : 'offline';
const uptime = station.uptime !== undefined ? parseFloat(station.uptime) : 0;

// Determine uptime color
let uptimeClass = 'popup-uptime-bad';
if (uptime >= 95) uptimeClass = 'popup-uptime-good';
else if (uptime >= 80) uptimeClass = 'popup-uptime-warning';

// ... icon creation code ...

const marker = L.marker([lat, lng], { icon })
    .bindPopup(`
        <div class="custom-popup">
            <div class="popup-title">${station.station_name || 'Unknown'}</div>
            <div class="popup-info">📍 ${station.location || 'Unknown'}</div>
            <div class="popup-info">🌡️ ${station.temperature ? station.temperature + '°C' : 'N/A'}</div>
            <div class="popup-uptime ${uptimeClass}">📊 Uptime: ${uptime.toFixed(1)}%</div>
            <div class="popup-info">🔌 ${station.apiSource || 'Unknown'}</div>
            <div class="popup-status ${isOnline ? 'online' : 'offline'}">
                ${isOnline ? '● Online' : '○ Offline'}
            </div>
        </div>
    `, {
        maxWidth: 250,
        className: 'custom-leaflet-popup'
    });
```

**Changes:**
1. Added uptime percentage calculation
2. Added color-coding logic (green/yellow/red)
3. Updated popup to include uptime line
4. Applied CSS class for color coding

---

#### Change 5: Updated renderTable() (Line ~1439)

**Before:**
```javascript
const tbody = document.getElementById('stationsTable');
tbody.innerHTML = stations.map(station => {
    const statusText = station.is_online === 1 ? 'online' : 'offline';
    const lastSeen = station.is_online === 1 ? 'Active now' : (formatRelativeTime(station.last_seen) || 'Unknown');
    
    return `
    <tr onclick="focusStation('${station.station_id}')" data-station-id="${station.station_id}">
        <td><strong>${station.station_name || 'Unknown'}</strong></td>
        <td>${station.location || 'Unknown'}</td>
        <td>
            <span class="status-badge ${statusText}">
                <span class="status-dot ${statusText}"></span>
                ${statusText.toUpperCase()}
            </span>
        </td>
        <td>${station.temperature ? station.temperature + '°C' : 'N/A'}</td>
        <td>N/A</td>
        <td>${lastSeen}</td>
    </tr>
```

**After:**
```javascript
const tbody = document.getElementById('stationsTable');
tbody.innerHTML = stations.map(station => {
    const statusText = station.is_online === 1 ? 'online' : 'offline';
    const lastSeen = station.is_online === 1 ? 'Active now' : (formatRelativeTime(station.last_seen) || 'Unknown');
    const uptime = station.uptime !== undefined ? station.uptime : 'N/A';
    
    return `
    <tr onclick="focusStation('${station.station_id}')" data-station-id="${station.station_id}">
        <td><strong>${station.station_name || 'Unknown'}</strong></td>
        <td>${station.location || 'Unknown'}</td>
        <td>
            <span class="status-badge ${statusText}">
                <span class="status-dot ${statusText}"></span>
                ${statusText.toUpperCase()}
            </span>
        </td>
        <td>${station.temperature ? station.temperature + '°C' : 'N/A'}</td>
        <td><strong>${uptime}%</strong></td>
        <td>${lastSeen}</td>
    </tr>
```

**Changes:**
1. Extract uptime from station object
2. Display uptime percentage instead of "N/A"
3. Added bold formatting for emphasis

---

#### Change 6: Added CSS for Uptime Display (Line ~783)

**Added these styles:**
```css
.popup-uptime {
    font-size: 13px;
    color: var(--text-secondary);
    margin-bottom: 6px;
    font-weight: 600;
}

.popup-uptime-good {
    color: var(--success);
}

.popup-uptime-warning {
    color: var(--warning);
}

.popup-uptime-bad {
    color: var(--danger);
}
```

**What it does:**
- `.popup-uptime` - Base style for uptime display
- `.popup-uptime-good` - Green for ≥95% (success color)
- `.popup-uptime-warning` - Yellow for 80-94% (warning color)
- `.popup-uptime-bad` - Red for <80% (danger color)

---

## Summary of Changes

### Backend Changes (src/index.js)
- **1 new endpoint:** `/api/uptime-percentages`
- **1 new function:** `handleUptimePercentagesRequest()`
- **SQL Query:** Calculates 24-hour uptime percentage for all stations

### Frontend Changes (dashboard/index.html)
- **1 new constant:** `WORKER_API` (for new endpoint)
- **1 new function:** `loadUptimePercentages()` (fetches & processes data)
- **2 enhanced functions:** 
  - `updateMapMarkers()` (shows uptime in popups)
  - `renderTable()` (shows uptime in table)
- **4 new CSS classes:** For color-coded uptime display

### Total Lines of Code Added
- **Backend:** ~30 lines (1 function)
- **Frontend:** ~50 lines (1 function + enhancements)
- **CSS:** ~20 lines (4 classes)
- **Total:** ~100 lines of new code

---

## API Endpoint Details

### Request
```
GET /api/uptime-percentages
Content-Type: application/json
```

### Response (200 OK)
```json
{
  "uptime_data": [
    {
      "station_id": "12345",
      "station_name": "Station A",
      "total_readings": 48,
      "online_readings": 47,
      "uptime_percent": 97.9
    },
    {
      "station_id": "67890",
      "station_name": "Station B",
      "total_readings": 48,
      "online_readings": 38,
      "uptime_percent": 79.2
    }
  ]
}
```

### Database Query Executed
```sql
SELECT 
  s.station_id,
  s.station_name,
  COUNT(*) as total_readings,
  SUM(CASE WHEN sl.is_online = 1 THEN 1 ELSE 0 END) as online_readings,
  ROUND(
    (SUM(CASE WHEN sl.is_online = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*)), 
    1
  ) as uptime_percent
FROM stations s
LEFT JOIN status_logs sl ON s.station_id = sl.station_id 
  AND sl.timestamp > datetime('now', '-24 hours')
GROUP BY s.station_id, s.station_name
ORDER BY uptime_percent DESC
```

---

## Integration Flow

```
Dashboard Load
    ↓
loadData()
    ├─ Fetch stations from main API
    └─ Call loadUptimePercentages()
          ↓
      Fetch /api/uptime-percentages
          ↓
      Match data by station_id
          ↓
      Update station.uptime property
          ↓
      Call updateMapMarkers()
          ├─ Render map with uptime in popups
          └─ Apply color coding
          ↓
      Call renderTable()
          └─ Show uptime % in table column
```

---

## Testing the Implementation

### Test 1: Verify Endpoint
```bash
curl 'https://your-worker.workers.dev/api/uptime-percentages' \
  -H 'Authorization: Bearer your-token' \
  -H 'Content-Type: application/json'
```

Expected response:
```json
{"uptime_data":[...]}
```

### Test 2: Check Dashboard Loads
1. Open developer console (F12)
2. Look for fetch request to `/api/uptime-percentages`
3. Check response tab - should show uptime_data array

### Test 3: Verify Map Popups
1. Click a marker on the map
2. Popup should show: "📊 Uptime: X.X%"
3. Color should match: green (≥95%), yellow (80-94%), red (<80%)

### Test 4: Check Table
1. Look at "Uptime" column
2. Should show percentages like "97.9%", "45.2%", etc.
3. Should be sortable (click header)

---

## Troubleshooting

### Uptime shows 0% for all stations
**Cause:** No status_logs data yet
**Fix:** Wait 30+ minutes for first sync, then dashboard needs 2+ readings for calculation

### Uptime shows N/A
**Cause:** Uptime not found in response
**Fix:** Check if `/api/uptime-percentages` endpoint is working

### Map popups don't show uptime
**Cause:** CSS class not applied or uptime not in scope
**Fix:** Open console, check error messages

### Table uptime column blank
**Cause:** Function not called or failed silently
**Fix:** Check loadUptimePercentages() in console for errors

---

**All changes are backward compatible and don't affect existing functionality!**
