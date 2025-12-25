# Weather Station Dashboard - Complete Setup

## What's Been Implemented ✅

Your weather station monitoring dashboard now includes:

### 1. **Interactive Leaflet Map**
- Shows all weather stations as markers on the map
- Color-coded markers: 🟢 Online (green) | 🔴 Offline (red)
- **Marker Clustering**: Automatically groups nearby stations for better performance
- **Clickable Popups**: Each marker shows:
  - Station name
  - Location
  - Current temperature (°C)
  - **24-Hour Uptime %** 📊
  - Current status (Online/Offline)
  - API Source
- **Click-to-zoom**: Click any marker to zoom in and view details
- **Responsive**: Works on all screen sizes

### 2. **Uptime & Downtime Percentages** 📊
- **Real-time Uptime Calculation**: Each station shows 24-hour uptime percentage
- **Data Source**: Pulled from your Worker API database (`status_logs` table)
- **Formula**: `(Online readings / Total readings) × 100%` over last 24 hours
- **Color-coded Display**:
  - 🟢 ≥95% = Green (Excellent)
  - 🟡 80-94% = Yellow (Good)
  - 🔴 <80% = Red (Poor)

### 3. **Temperature Display**
- **Real-time Temperature**: Shows latest temperature reading for each station
- **Celsius Conversion**: All temperatures automatically converted from Fahrenheit
- **Display Locations**:
  - Station table (sortable column)
  - Map popups
  - Last seen column shows "Active now" if online

### 4. **Dashboard Features**
- **4 Key Statistics**:
  - Total Online Stations (count)
  - Total Offline Stations (count)
  - Uptime Percentage (%)
  - Downtime Percentage (%)

- **Visual Ring Chart**:
  - Shows online/offline distribution
  - Animated percentages
  - Live legend

- **24-Hour Uptime Trend Chart**:
  - Line chart showing uptime trend over last 24 hours
  - Interactive tooltips

- **Station List Table**:
  - Sortable by Station, Location, Status, Temperature, Uptime, Last Seen
  - Search functionality (by name, location, station ID)
  - Filter buttons: All, Online, Offline
  - Hide WU Stations checkbox
  - Row highlighting on selection

- **Recent Offline Panel**:
  - Shows currently offline stations
  - Displays time since going offline
  - "All stations online!" message when no issues

- **Theme Toggle**: Dark/Light mode with localStorage persistence

---

## API Endpoints

### New Endpoint: GET `/api/uptime-percentages`
Returns 24-hour uptime percentages for all stations.

**Response:**
```json
{
  "uptime_data": [
    {
      "station_id": "12345",
      "station_name": "Station Name",
      "total_readings": 48,
      "online_readings": 47,
      "uptime_percent": 97.9
    },
    ...
  ]
}
```

### Existing Endpoints (Already Available):
- `GET /api/stations` - All stations with current status
- `GET /api/stats` - Overall statistics
- `GET /api/alerts` - Currently offline stations & alerts
- `GET /api/station?id=<stationId>` - Specific station details
- `GET /api/uptime-trend` - 24-hour trend data

---

## How It Works

### 1. Data Flow
```
Weather Station Data
        ↓
   WeatherLink API
        ↓
   Cloudflare Worker (sync every 30 mins)
        ↓
   D1 Database (status_logs table)
        ↓
   Dashboard (fetches every 30 mins)
        ↓
   Beautiful Visualizations
```

### 2. Uptime Calculation
- Every 30 minutes, your Worker checks each station's status
- Stores reading in `status_logs` table with `is_online` flag (1 = online, 0 = offline)
- Dashboard queries last 24 hours of readings
- Calculates: `(COUNT where is_online=1) / COUNT(*) * 100%`

### 3. Map Integration
- Leaflet.js renders the map
- Leaflet.markercluster provides grouping
- Each marker is a station
- All popups include uptime % and temperature
- Markers update when you refresh the page

---

## Configuration

### Environment Variables
In your `wrangler.toml`:
```toml
[vars]
ENVIRONMENT = "production"

# Your secrets (set via: wrangler secret put SECRET_NAME)
# WEATHERLINK_API_KEY=your_key
# WEATHERLINK_API_SECRET=your_secret
```

### Dashboard Settings
Edit in `dashboard/index.html`:
```javascript
const API_BASE = 'https://hubservice.weatherwalay.com'; // Your main API
const WORKER_API = 'https://weatherlink-monitor.workers.dev'; // Your Worker URL (CHANGE THIS!)
```

**⚠️ IMPORTANT**: Update `WORKER_API` to your actual Cloudflare Worker URL!

---

## Database Schema

### `status_logs` Table (Stores readings)
```sql
- station_id (TEXT)
- timestamp (TEXT, default: now)
- is_online (INTEGER: 0=offline, 1=online)
- temperature (REAL)
- humidity (REAL)
- pressure (REAL)
- wind_speed (REAL)
- response_time_ms (INTEGER)
```

### `stations` Table (Station metadata)
```sql
- station_id (TEXT, unique)
- station_name (TEXT)
- location (TEXT)
- latitude (REAL)
- longitude (REAL)
- install_date (TEXT)
```

---

## Usage

### 1. Deploy Worker
```bash
wrangler publish
```

### 2. Access Dashboard
```
https://yourdomain.com/dashboard/index.html
```

### 3. Auto-Refresh
Dashboard automatically:
- Fetches data every 30 minutes
- Recalculates uptime percentages
- Updates map markers
- Refreshes all charts

---

## Performance Notes

✅ **Optimized for:**
- Up to 300+ stations
- Markercluster prevents map slowdown
- Batch station sync (10 stations per batch)
- Database indexes on station_id and timestamp

⚠️ **Known Limitations:**
- Map clustering can be adjusted in config
- Chart.js limits display to ~100 data points
- Uptime % requires 24+ hours of historical data

---

## Troubleshooting

### Uptime shows 0% or N/A
- Check: Do you have at least 1 status log entry? Query: `SELECT COUNT(*) FROM status_logs`
- Worker may still be collecting initial data

### Map not showing stations
- Check coordinates are not (0,0): `SELECT station_id, latitude, longitude FROM stations WHERE latitude != 0`
- Zoom out or pan around - markers cluster at higher zoom levels

### Temperature shows N/A
- Check: `SELECT station_id, temperature FROM status_logs ORDER BY timestamp DESC LIMIT 5`
- May not have temp data for that station

### Uptime doesn't match expected
- Uptime = Online readings in last 24 hours / All readings in last 24 hours
- Syncs happen every 30 minutes, so you need 48+ readings for full 24-hour period

---

## Files Modified

✅ `src/index.js`
- Added `/api/uptime-percentages` endpoint
- Enhanced station data with uptime calculations

✅ `dashboard/index.html`
- Updated Leaflet markers to show uptime %
- Added `loadUptimePercentages()` function
- Enhanced table with uptime column
- Color-coded uptime display (green/yellow/red)

---

## Next Steps (Optional Enhancements)

1. **Downtime Alerts**: Add email notifications when stations go offline
2. **Historical Reports**: Generate daily/weekly uptime reports
3. **Data Export**: Export station data to CSV
4. **Mobile App**: Convert to PWA for mobile access
5. **Advanced Analytics**: Add moving averages, trend detection
6. **Performance Graphs**: Add wind speed, humidity, pressure charts
7. **Geofencing**: Highlight stations in specific regions
8. **Comparison View**: Compare two stations side-by-side

---

**Dashboard is now fully functional!** 🎉

Access your dashboard and you should see:
- ✅ All stations on the map with markers
- ✅ Uptime % for each station (≥95% is green)
- ✅ Current temperature for each station
- ✅ Online/Offline status with colors
- ✅ 24-hour uptime trend chart
- ✅ Searchable, sortable station list
- ✅ Recent offline stations panel

Enjoy monitoring your weather stations! 🌦️📊
