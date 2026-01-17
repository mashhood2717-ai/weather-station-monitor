# 🌤️ Weather Station Monitoring System

A real-time weather station monitoring dashboard that tracks 300+ weather stations across Pakistan. Built with Cloudflare Workers, D1 Database, and a modern web dashboard.

---

## 📋 Table of Contents

1. [What Is This Project?](#what-is-this-project)
2. [How It Works](#how-it-works)
3. [Project Structure](#project-structure)
4. [API Endpoints](#api-endpoints)
5. [Database Schema](#database-schema)
6. [Dashboard Features](#dashboard-features)
7. [How To Deploy](#how-to-deploy)
8. [Common Questions](#common-questions)

---

## 🎯 What Is This Project?

This system monitors weather stations installed across Pakistan. It:

- **Tracks station status** - Which stations are online/offline
- **Records weather data** - Temperature, rainfall, wind speed
- **Calculates uptime** - How reliable each station is (24h, 7d, 30d, 1 year)
- **Shows on a map** - Interactive map with all station locations
- **Sends daily reports** - Email summary of all stations every morning

### Who Uses It?
- Weatherwalay operations team
- Station maintenance teams
- Management for reporting

---

## ⚙️ How It Works

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│   HubService    │ ───► │ Cloudflare Worker│ ───► │   D1 Database   │
│  (Source API)   │      │  (Our Backend)   │      │  (Data Storage) │
└─────────────────┘      └──────────────────┘      └─────────────────┘
                                  │
                                  ▼
                         ┌─────────────────┐
                         │    Dashboard    │
                         │   (Frontend)    │
                         └─────────────────┘
```

### The Flow:

1. **Every 15 minutes** (automatic cron job):
   - Worker fetches all stations from HubService API
   - Checks which are online/offline
   - Stores temperature, rainfall, wind speed
   - Saves to D1 database

2. **When you open the dashboard**:
   - Dashboard calls our Worker API
   - Worker queries database for uptime stats
   - Returns combined data (live status + historical uptime)
   - Dashboard displays everything

3. **Every morning at 8 AM PKT**:
   - Worker generates daily report
   - Sends email to configured recipients

---

## 📁 Project Structure

```
weather-monitor/
│
├── src/
│   └── index.js          # ⭐ Main backend code (Cloudflare Worker)
│                         #    - All API endpoints
│                         #    - Database queries
│                         #    - Cron sync logic
│
├── dashboard/
│   ├── index.html        # ⭐ Main dashboard (all-in-one HTML file)
│   │                     #    - Stats cards
│   │                     #    - Charts
│   │                     #    - Map
│   │                     #    - Station table
│   │
│   └── login.html        # Login page (token-based auth)
│
├── schema.sql            # Database table definitions
├── wrangler.toml         # Cloudflare Worker configuration
├── package.json          # Project dependencies
│
└── .github/
    └── copilot-instructions.md  # AI coding instructions
```

### Key Files Explained:

| File | Purpose |
|------|---------|
| `src/index.js` | The "brain" - handles all API requests, syncs data, calculates uptime |
| `dashboard/index.html` | The visual interface - charts, maps, tables |
| `schema.sql` | Database structure definition |
| `wrangler.toml` | Tells Cloudflare how to deploy the Worker |

---

## 🔌 API Endpoints

**Base URL:** `https://weatherlink-monitor.mashhood2717.workers.dev`

### 1. Get All Stations with Uptime
```
GET /api/stations-with-uptime
```
**What it returns:** All stations with their current status, temperature, rainfall, and 24-hour uptime percentage.

**Example Response:**
```json
{
  "success": true,
  "total": 284,
  "stations": [
    {
      "station_id": "163674",
      "station_name": "Abbottabad City",
      "status": "Active",
      "temperature": 5.6,
      "rainfall": 0,
      "uptime_24h": 100,
      "latitude": 34.16853,
      "longitude": 73.22342,
      "api_source": "Davis"
    }
  ]
}
```

**How to test (in browser or Postman):**
```
https://weatherlink-monitor.mashhood2717.workers.dev/api/stations-with-uptime
```

---

### 2. Get Dashboard Stats
```
GET /api/dashboard-stats
```
**What it returns:** Average uptime/downtime across all stations, and daily extremes (max/min temp, max rainfall, max wind) since midnight PKT.

**Example Response:**
```json
{
  "success": true,
  "daily_extremes": {
    "max_temp": 22,
    "max_temp_station": "PIB Colony Karachi",
    "min_temp": -2.1,
    "min_temp_station": "Shimshal Valley",
    "max_rainfall": 0.4,
    "max_rainfall_station": "Lahore DHA Phase 6",
    "max_wind_gust": 24.1,
    "max_wind_gust_station": "Terrace Grill, Murree"
  },
  "average_uptime": {
    "uptime_pct": 63.3,
    "downtime_pct": 36.7,
    "stations_counted": 284
  }
}
```

**How to test:**
```
https://weatherlink-monitor.mashhood2717.workers.dev/api/dashboard-stats
```

---

### 3. Get Uptime Trend Chart Data
```
GET /api/uptime-trend-chart?range=24h
```
**Parameters:**
- `range`: `24h`, `7d`, `30d`, or `1y`

**What it returns:** Time-series uptime data for charts.

**Example Response:**
```json
{
  "success": true,
  "range": "24h",
  "granularity": "hourly",
  "trend": [
    { "period": "2026-01-17 00:00:00", "uptime_pct": 62.5 },
    { "period": "2026-01-17 01:00:00", "uptime_pct": 63.1 }
  ],
  "overall_uptime": 63.3,
  "overall_downtime": 36.7
}
```

**How to test:**
```
https://weatherlink-monitor.mashhood2717.workers.dev/api/uptime-trend-chart?range=7d
```

---

### 4. Get Uptime Percentages (for all stations)
```
GET /api/uptime-percentages
```
**What it returns:** 24-hour uptime percentage for each station.

**How to test:**
```
https://weatherlink-monitor.mashhood2717.workers.dev/api/uptime-percentages
```

---

### 5. Get Station History
```
GET /api/station-history/{station_id}?hours=24
```
**Parameters:**
- `hours`: Number of hours of history (default: 24)
- `days`: Number of days (alternative to hours)

**What it returns:** Detailed history for a specific station including hourly data and downtime records.

**How to test:**
```
https://weatherlink-monitor.mashhood2717.workers.dev/api/station-history/163674?hours=48
```

---

### 6. Trigger Manual Sync
```
GET /api/sync
```
**What it does:** Manually triggers a sync of all stations from HubService.

**When to use:** If you want fresh data immediately instead of waiting for the 15-minute cron.

**How to test:**
```
https://weatherlink-monitor.mashhood2717.workers.dev/api/sync
```

---

### 7. Get Daily Report (JSON)
```
GET /api/daily-report
```
**What it returns:** Complete daily report with all stations, category breakdown, and offline list.

**How to test:**
```
https://weatherlink-monitor.mashhood2717.workers.dev/api/daily-report
```

---

### 8. Download Daily Report (Excel/CSV)
```
GET /api/daily-report/excel
```
**What it does:** Downloads a CSV file with the daily report.

**How to test:** Open in browser - it will download a file.

---

### 9. Get Storage Stats
```
GET /api/storage-stats
```
**What it returns:** Database usage statistics (how much storage is used).

**How to test:**
```
https://weatherlink-monitor.mashhood2717.workers.dev/api/storage-stats
```

---

### 10. Test HubService Connection
```
GET /api/test-hubservice?name=lahore
```
**What it does:** Tests the connection to HubService API and returns raw station data.

**How to test:**
```
https://weatherlink-monitor.mashhood2717.workers.dev/api/test-hubservice?name=islamabad
```

---

## 🗄️ Database Schema

We use Cloudflare D1 (SQLite) with these tables:

### `stations` - Master list of all stations
| Column | Type | Description |
|--------|------|-------------|
| station_id | TEXT | Unique identifier (e.g., "163674") |
| station_name | TEXT | Display name (POI or station name) |
| location | TEXT | Technical station name |
| latitude | REAL | GPS latitude |
| longitude | REAL | GPS longitude |
| api_source | TEXT | "Davis", "Misol", or "WU" |
| install_date | DATE | When station was added |

### `status_logs` - Historical status records
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Auto-increment ID |
| station_id | TEXT | Which station |
| timestamp | DATETIME | When the check happened |
| is_online | INTEGER | 1 = online, 0 = offline |
| temperature | REAL | Temperature in Celsius |
| rainfall | REAL | Rainfall in mm |
| wind_speed | REAL | Wind gust in km/h |
| response_time_ms | INTEGER | API response time |

### `downtime_records` - Tracks offline periods
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Auto-increment ID |
| station_id | TEXT | Which station |
| start_time | DATETIME | When it went offline |
| end_time | DATETIME | When it came back online |
| duration_minutes | INTEGER | How long it was down |
| status | TEXT | "active" or "resolved" |

---

## 📊 Dashboard Features

### Stat Cards (Top Row)
| Card | Description |
|------|-------------|
| 🟢 Online | Number of currently active stations |
| 🔴 Offline | Number of currently down stations |
| 📈 Avg Uptime % | Average uptime across all stations (24h) |
| 📉 Avg Downtime % | Average downtime across all stations (24h) |
| 🌡️ Max Temp | Highest temperature today (since midnight PKT) |
| ❄️ Min Temp | Lowest temperature today |
| 🌧️ Max Rainfall | Highest rainfall today |
| 💨 Max Wind Gust | Highest wind speed today |
| 🔄 Last Sync | When data was last updated |

### Charts
1. **Ring Chart** - Visual breakdown of online vs offline
2. **Category Chart** - Uptime by category (Corporate, Community, Reference, Employee Stations, Others)
3. **Uptime Trend** - Line chart with toggles for 24H/7D/30D/1Y

### Map
- Interactive map of Pakistan
- Green markers = Online stations
- Red markers = Offline stations
- Yellow markers = Inactive stations
- Click any marker for details (temp, rainfall, uptime)

### Station Table
- Searchable and sortable
- Filter by category or status
- Click a row to see detailed history modal

---

## 🚀 How To Deploy

### 1. Deploy the Worker (Backend)
```bash
cd weather-monitor
wrangler deploy
```
This uploads `src/index.js` to Cloudflare Workers.

### 2. Deploy the Dashboard (Frontend)
The dashboard is hosted on Cloudflare Pages. It auto-deploys when you push to GitHub:
```bash
git add .
git commit -m "your changes"
git push
```

### URLs After Deployment:
- **Worker API:** https://weatherlink-monitor.mashhood2717.workers.dev
- **Dashboard:** https://weatherwalay-dashboard.pages.dev

---

## ❓ Common Questions

### Q: How often does data sync?
**A:** Every 15 minutes automatically via cron job.

### Q: Where does the data come from?
**A:** HubService API (`hubservice.weatherwalay.com`) - this is Weatherwalay's internal station management system.

### Q: How is uptime calculated?
**A:** 
```
Uptime % = (Online Checks / Total Checks) × 100
```
For example, if a station was checked 96 times in 24 hours (every 15 min) and was online 90 times:
```
Uptime = 90/96 × 100 = 93.75%
```

### Q: What are the station categories?
| Category | Description |
|----------|-------------|
| Corporate | Installed at corporate offices |
| Community | Shared community stations |
| Reference | Official reference stations (PMD) |
| Employee Stations | Installed at employee homes |
| Others | Other/uncategorized stations |

### Q: How is temperature data handled?
**A:** 
- HubService provides temperature in Celsius
- WU (Weather Underground) stations provide in Fahrenheit, which we convert to Celsius
- Only **online stations** are included in daily extremes

### Q: What's the difference between POI and Station Name?
**A:** 
- **Station Name** = Technical identifier (e.g., "ILAHOR14")
- **POI** (Point of Interest) = User-friendly name (e.g., "Lahore DHA Phase 6")
- Dashboard shows POI when available

### Q: How long is data kept?
**A:** 15 months (456 days). Older data is automatically deleted to stay within database limits.

### Q: What if a station shows 0% uptime but I know it's online?
**A:** The uptime is calculated from historical checks in our database. If we just started tracking a station, it may need 24 hours of data before uptime is accurate.

### Q: How do I add a new station?
**A:** Stations are automatically synced from HubService. If you add a station in HubService, it will appear in our system within 15 minutes.

---

## 🔧 Environment Variables

Set these in Cloudflare Worker settings:

| Variable | Description |
|----------|-------------|
| `HUBSERVICE_BASIC_AUTH` | Login credentials for HubService (`phone:password`) |
| `RESEND_API_KEY` | API key for sending emails (optional) |
| `REPORT_EMAILS` | Comma-separated email addresses for daily reports |
| `REPORT_FROM_EMAIL` | Sender email address |

---

## 🛠️ Troubleshooting

### Dashboard shows "Loading..."
1. Check browser console for errors (F12 → Console)
2. Try `/api/sync` to force data refresh
3. Check if Worker is running: visit the API URL directly

### Stations show 0% uptime
- Wait 24 hours for enough data to accumulate
- Check if the station exists in HubService

### Temperature shows "--"
- Station may be offline
- Temperature sensor may not be reporting

### Map doesn't load
- Check internet connection
- Try refreshing the page
- Check if Leaflet CDN is accessible

---

## 📞 Support

For issues or questions:
1. Check the Cloudflare dashboard for Worker logs
2. Check browser console for frontend errors
3. Try `/api/sync` to force a fresh data sync

---

## 📜 Version History

| Date | Changes |
|------|---------|
| Jan 17, 2026 | Added uptime trend chart with 24H/7D/30D/1Y toggles |
| Jan 17, 2026 | Added avg uptime/downtime stat cards |
| Jan 17, 2026 | Added min temp and max wind gust tiles |
| Jan 17, 2026 | POI names shown instead of technical station names |
| Jan 17, 2026 | Daily extremes reset at midnight PKT |
| Jan 17, 2026 | Wind speed data extraction from Davis and WU stations |

---

**Built with ❤️ for Weatherwalay Operations Team**
