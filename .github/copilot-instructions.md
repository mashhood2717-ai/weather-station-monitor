# 🤖 Copilot & AI Agent Instructions for Weather Station Dashboard

## Project Overview
- **Purpose:** Monitors weather stations with real-time status, temperature, and uptime/downtime analytics.
- **Architecture:**
  - **Backend:** Cloudflare Worker (src/index.js) exposes REST API endpoints, syncs data to D1 (SQLite) database.
  - **Frontend:** Pure HTML/JS dashboard (dashboard/index.html) fetches from Worker API, renders map, table, and stats.
  - **Data Flow:** Worker syncs every 30 min → logs to DB → dashboard fetches via API → merges and displays.

## Key Files & Structure
- `src/index.js`: Cloudflare Worker backend, all API logic.
- `dashboard/index.html`: Main dashboard UI, all client logic.
- `schema.sql`: DB schema (status_logs, stations, etc).
- `wrangler.toml`: Worker deployment config.
- `README.md`: Architecture, API endpoints, and deploy instructions.

## Essential Workflows
- **Deploy Worker:**
  ```bash
  wrangler publish
  ```
- **Update API Endpoint:**
  Edit `dashboard/index.html` → set `WORKER_API` to your Worker URL.
- **Test API:**
  ```js
  fetch('https://<your-worker>.workers.dev/api/uptime-percentages').then(r => r.json())
  ```
- **Dashboard Usage:**
  - Open dashboard/index.html in browser.
  - Map, table, and stats auto-refresh every 30 min.

## Project-Specific Patterns & Conventions
- **Uptime Calculation:**
  - 24-hour window, color-coded: green (≥95%), yellow (80–94%), red (<80%).
  - SQL: see `handleUptimePercentagesRequest` in `src/index.js`.
- **Temperature:**
  - Always display in Celsius, auto-convert from Fahrenheit.
- **Map Markers:**
  - Green = online, red = offline. Clustering enabled.
- **Authentication:**
  - Token-based, stored in localStorage, checked on page load.
- **No server-side rendering:**
  - All dashboard logic is client-side JS.

## Integration & External Dependencies
- **Cloudflare Worker:**
  - All backend logic and DB access.
- **D1 Database:**
  - Stores all station logs and metadata.
- **Leaflet.js:**
  - For interactive map rendering.

## Troubleshooting & Testing
- **Common Issues:**
  - No stations: check API URL, token, network errors.
  - Uptime N/A: need 24h of data in `status_logs`.
  - Map errors: check Leaflet load, lat/lng data.
- **Verification Checklist:**
  - See README.md for full pre-launch checklist.

## Examples
- **Add new API endpoint:**
  - Follow pattern in `src/index.js` (see `/api/uptime-percentages`).
- **Add new dashboard feature:**
  - Add JS in `dashboard/index.html`, fetch from Worker API, update UI.

---
For more, see the documentation files listed above. When in doubt, check the README.md and follow the established patterns in `src/index.js` and `dashboard/index.html`.
