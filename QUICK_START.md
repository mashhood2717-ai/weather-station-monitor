# Implementation Checklist & Quick Start

## ✅ What's Done

### Backend (Worker)
- [x] New endpoint: `/api/uptime-percentages`
  - Calculates 24-hour uptime % for all stations
  - Returns: `station_id, station_name, uptime_percent`
  - Uses database query with group by and avg calculations

### Frontend (Dashboard)
- [x] Leaflet map with marker clustering
  - Color-coded markers (green=online, red=offline)
  - Popups show temperature, uptime %, status
  
- [x] Temperature display
  - Shows latest reading from each station
  - Fahrenheit to Celsius conversion included
  - Displayed in: table, map popups

- [x] Uptime percentages
  - 24-hour calculation from status_logs table
  - Shown as: % in table, % in map popup, color-coded
  - Fetches from `/api/uptime-percentages` endpoint

- [x] Dashboard statistics
  - Online/Offline count cards
  - Uptime % and Downtime % display
  - Animated ring chart visualization

- [x] Additional features
  - Search box (by name, location, ID)
  - Filter buttons (All, Online, Offline)
  - Sortable table columns
  - Hide WU Stations checkbox
  - Dark/Light theme toggle
  - Recent offline panel

---

## 🚀 Quick Deployment Steps

### Step 1: Update Worker URL in Dashboard
Open `dashboard/index.html` and find this line (around line 1480):
```javascript
const WORKER_API = 'https://weatherlink-monitor.workers.dev';
```

Replace with your actual Worker URL:
```javascript
const WORKER_API = 'https://your-worker-name.workers.dev';
```

### Step 2: Ensure Worker is Deployed
```bash
cd d:\weather-monitor
wrangler publish
```

### Step 3: Access Dashboard
Once deployed, access:
```
https://yourdomain.com/dashboard/index.html
```

The dashboard will:
1. Check authentication (token in localStorage)
2. Fetch stations from your main API
3. Fetch uptime percentages from Worker
4. Display everything on an interactive Leaflet map

---

## 📊 Data Flow Diagram

```
┌─────────────────────────────────────────────────┐
│   Weather Station Monitor Dashboard             │
├─────────────────────────────────────────────────┤
│                                                  │
│  1. Load Stations (from Main API)               │
│     └─> GET /wms/stations (pages 1-6)           │
│                                                  │
│  2. Load Uptime Data (from Worker)              │
│     └─> GET /api/uptime-percentages             │
│         └─> SQL: SELECT uptime_percent          │
│             FROM status_logs (last 24h)         │
│                                                  │
│  3. Merge Data                                  │
│     └─> station ← uptime_data[station_id]       │
│                                                  │
│  4. Render                                      │
│     ├─> Map markers with uptime in popup        │
│     ├─> Table with temperature & uptime cols   │
│     ├─> Statistics cards                        │
│     └─> Ring chart + trend chart                │
│                                                  │
└─────────────────────────────────────────────────┘
```

---

## 🗄️ Database Queries

### Uptime Calculation Query (in Worker)
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

**What this does:**
- For each station, counts total readings in last 24 hours
- Counts how many of those readings were "online" (is_online = 1)
- Calculates percentage: (online count / total count) × 100
- Returns sorted by highest uptime first

---

## 🎨 Visual Elements

### Map Markers
```javascript
// Green (Online) - Pulsing effect
<div class="pulse-marker online"></div>

// Red (Offline) - Ripple effect  
<div class="pulse-marker offline"></div>
```

### Uptime Color Coding (in popups)
```
≥95%  → 🟢 Green   (popup-uptime-good)
80-94% → 🟡 Yellow  (popup-uptime-warning)
<80%  → 🔴 Red    (popup-uptime-bad)
```

### Table Display
```
┌─────────────┬──────────┬────────┬──────┬─────────┬──────────────┐
│ Station     │ Location │ Status │ Temp │ Uptime  │ Last Seen    │
├─────────────┼──────────┼────────┼──────┼─────────┼──────────────┤
│ Station A   │ Karachi  │ ● ONLINE│ 28°C│ 97.9%   │ Active now   │
│ Station B   │ Lahore   │ ○ OFFLINE│ N/A │ 45.2%   │ 2 hours ago  │
│ Station C   │ Islamabad│ ● ONLINE│ 22°C│ 100.0%  │ Active now   │
└─────────────┴──────────┴────────┴──────┴─────────┴──────────────┘
```

---

## 🔧 Configuration Customization

### Change Uptime Thresholds
In `dashboard/index.html`, find `updateMapMarkers()` function:
```javascript
let uptimeClass = 'popup-uptime-bad';
if (uptime >= 95) uptimeClass = 'popup-uptime-good';      // Change 95
else if (uptime >= 80) uptimeClass = 'popup-uptime-warning'; // Change 80
```

### Change Map Tiles
In `initMap()` function:
```javascript
// Current: Dark CartoDB
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png')

// Options:
// Light: https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png
// Satellite: https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}
```

### Change Auto-Refresh Interval
Currently every 30 minutes. Change in `init()` function:
```javascript
setInterval(loadData, 30 * 60 * 1000);  // Change 30
```

### Change Map Initial View
In `initMap()` function:
```javascript
.setView([30.3753, 69.3451], 6);  // [lat, lng], zoom
```

---

## 📈 Expected Results

### What You Should See:

**After 1 hour:**
- ✅ All stations displayed on map
- ✅ Temperature showing for each station
- ✅ Uptime % should show (might be preliminary)
- ✅ Online/offline status correct

**After 24 hours:**
- ✅ Full 24-hour uptime data complete
- ✅ All trends visible in charts
- ✅ Accurate percentages (based on 48 readings)

**After 1 week:**
- ✅ Reliable uptime patterns visible
- ✅ Downtime events clearly marked
- ✅ Temperature trends in uptime chart

---

## 🐛 Debugging

### Check if Endpoint is Working
```javascript
// In browser console:
fetch('https://your-worker-url/api/uptime-percentages')
  .then(r => r.json())
  .then(d => console.log(d))
```

### Check Database Data
```sql
-- Check latest status logs
SELECT station_id, is_online, temperature, timestamp 
FROM status_logs 
ORDER BY timestamp DESC 
LIMIT 10;

-- Check uptime for specific station
SELECT station_id, COUNT(*) as total,
       SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) as online
FROM status_logs 
WHERE station_id = 'YOUR_STATION_ID'
  AND timestamp > datetime('now', '-24 hours')
GROUP BY station_id;
```

### Check Browser Console
Open DevTools (F12) → Console → Look for errors

Common errors:
- `401 Unauthorized` → Check token in localStorage
- `404 Not Found` → Check API URLs
- `CORS error` → Check CORS headers in Worker

---

## ✨ Features at a Glance

| Feature | Location | Data Source |
|---------|----------|-------------|
| Map with markers | Center | Main API (coordinates) |
| Temperature | Map popup, Table | status_logs.temperature |
| Uptime % | Map popup, Table | API endpoint (calculated) |
| Online/Offline | Status badge | Main API (status field) |
| Last seen time | Table | status_logs.timestamp |
| Statistics cards | Top | Calculated from all stations |
| Ring chart | Left | Online/offline count |
| 24h trend chart | Right | status_logs (hourly) |
| Station table | Bottom left | All merged data |
| Offline alerts | Bottom right | status_logs (is_online = 0) |

---

## 📝 Notes

- **Uptime is calculated over last 24 hours**, so new stations may show 0% initially
- **Sync happens every 30 minutes**, so data updates every 30 mins
- **All times shown are in Pakistan Time (PKT)** - adjust in code if needed
- **Celsius conversion** happens automatically from Fahrenheit
- **Map clustering** helps performance with 100+ stations

---

**Everything is ready!** 🎉

Just update the Worker URL, deploy, and access your dashboard!
